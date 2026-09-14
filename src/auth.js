"use strict";
/* ============================================================================
   TrainerHub — administrator authentication (Phase 3)

   Changes from Phase 2, both forced by going live:

   1. Sessions live in the database, not a Map. A restart no longer signs the
      administrator out — which on a free tier that spins down every 15
      minutes made the console effectively unusable.

   2. Login is rate limited. A single shared password on a public URL is
      brute-forceable; throttling by IP is the minimum defence.

   Still one hard-coded administrator. That is a deliberate, stated limit —
   see the production notes in the README.
   ========================================================================== */

const crypto = require("crypto");
const repo = require("./repo");

const SESSION_COOKIE = "th_admin";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;          // 8 hours

/* Rate limiting: lock an IP out after this many failures in the window. */
const MAX_FAILED_ATTEMPTS = Number(process.env.TRAINERHUB_LOGIN_MAX_ATTEMPTS || 8);
const ATTEMPT_WINDOW_MIN  = Number(process.env.TRAINERHUB_LOGIN_WINDOW_MIN  || 15);

const ADMIN_EMAIL      = (process.env.TRAINERHUB_ADMIN_EMAIL || "admin@trainerhub.app").toLowerCase();
const DEFAULT_PASSWORD = "admin123";
const ADMIN_PASSWORD   = process.env.TRAINERHUB_ADMIN_PASSWORD || DEFAULT_PASSWORD;
const USING_DEFAULT_PASSWORD = ADMIN_PASSWORD === DEFAULT_PASSWORD;

const SECURE_COOKIES =
  process.env.TRAINERHUB_SECURE_COOKIES === "1" ||
  (process.env.TRAINERHUB_SECURE_COOKIES !== "0" && process.env.NODE_ENV === "production");

/* Salted scrypt hash, so the process never holds a comparable plaintext. */
const SALT = crypto.randomBytes(16);
const PASSWORD_HASH = crypto.scryptSync(ADMIN_PASSWORD, SALT, 64);

function passwordMatches(candidate){
  let hash;
  try { hash = crypto.scryptSync(String(candidate == null ? "" : candidate), SALT, 64); }
  catch { return false; }
  return crypto.timingSafeEqual(hash, PASSWORD_HASH);
}
function emailMatches(candidate){
  const a = Buffer.from(String(candidate == null ? "" : candidate).trim().toLowerCase());
  const b = Buffer.from(ADMIN_EMAIL);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ cookies */
function parseCookies(header){
  const out = {};
  String(header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
const cookieFlags = () =>
  `HttpOnly; SameSite=Strict; Path=/${SECURE_COOKIES ? "; Secure" : ""}`;
const sessionCookie = token =>
  `${SESSION_COOKIE}=${token}; ${cookieFlags()}; Max-Age=${SESSION_TTL_MS / 1000}`;
const clearCookie = () =>
  `${SESSION_COOKIE}=; ${cookieFlags()}; Max-Age=0`;

/** Best-effort client IP, honouring the proxy header Render sets. */
function clientIp(req){
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/* ------------------------------------------------------------------ session */
function tokenFrom(req){
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

/** The admin behind a request, or null. Every admin route awaits this. */
async function currentAdmin(req){
  const token = tokenFrom(req);
  if (!token) return null;
  const session = await repo.readAdminSession(token);
  return session ? { email: session.email, token } : null;
}

/**
 * Verify a login attempt.
 * Returns { ok, token } | { ok:false, rateLimited:true, retryAfterMinutes }
 */
async function login(req, email, password){
  const ip = clientIp(req);

  const failures = await repo.recentFailedLogins(ip, ATTEMPT_WINDOW_MIN);
  if (failures >= MAX_FAILED_ATTEMPTS){
    return { ok: false, rateLimited: true, retryAfterMinutes: ATTEMPT_WINDOW_MIN };
  }

  // Evaluate both before branching so the failure path costs the same either way.
  const okEmail = emailMatches(email);
  const okPass  = passwordMatches(password);
  if (!okEmail || !okPass){
    await repo.recordLoginAttempt(ip, false);
    const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - (failures + 1));
    return { ok: false, attemptsRemaining: remaining };
  }

  await repo.recordLoginAttempt(ip, true);
  const token = crypto.randomBytes(32).toString("hex");
  await repo.createAdminSession(token, ADMIN_EMAIL, Date.now() + SESSION_TTL_MS);
  return { ok: true, token };
}

async function logout(req){
  const token = tokenFrom(req);
  if (token) await repo.destroyAdminSession(token);
}

module.exports = {
  SESSION_COOKIE, ADMIN_EMAIL, USING_DEFAULT_PASSWORD, SECURE_COOKIES,
  MAX_FAILED_ATTEMPTS, ATTEMPT_WINDOW_MIN,
  login, logout, currentAdmin, parseCookies, sessionCookie, clearCookie, clientIp
};
