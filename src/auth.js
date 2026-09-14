"use strict";
/* ============================================================================
   TrainerHub — administrator authentication (Phase 2)

   FR / RULE-007 / P0-010: only an administrator may approve, reject, cancel
   or create sessions.

   Phase 1 gated the admin area with a boolean in browser memory, which is not
   authorisation at all. Here the server owns it: credentials are checked
   against a salted hash, a random session token is issued in an httpOnly
   cookie, and every admin route verifies that token server-side before doing
   anything. A caller that forges the cookie value gets 401.

   Still prototype-grade, and honest about it:
   - Credentials come from env vars with a documented demo default.
   - Sessions live in memory, so restarting the server signs admins out.
   - Password hashing is scrypt, but there is no rate limiting or lockout.
   Phase 3 addresses all three.
   ========================================================================== */

const crypto = require("crypto");

const SESSION_COOKIE = "th_admin";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;   // 8 hours

const ADMIN_EMAIL    = (process.env.TRAINERHUB_ADMIN_EMAIL || "admin@trainerhub.app").toLowerCase();
const DEFAULT_PASSWORD = "admin123";
const ADMIN_PASSWORD =  process.env.TRAINERHUB_ADMIN_PASSWORD || DEFAULT_PASSWORD;

/* True when the server is still running the documented demo password. The
   boot guard in server.js refuses to start a production deployment in this
   state, so a public URL can never ship with a password printed in a README. */
const USING_DEFAULT_PASSWORD = ADMIN_PASSWORD === DEFAULT_PASSWORD;

/* Behind a TLS-terminating proxy (Render, Fly, Cloud Run, a tunnel) the
   session cookie must be marked Secure so it is never sent over plain HTTP. */
const SECURE_COOKIES =
  process.env.TRAINERHUB_SECURE_COOKIES === "1" ||
  (process.env.TRAINERHUB_SECURE_COOKIES !== "0" && process.env.NODE_ENV === "production");

/* Store a salted scrypt hash rather than the plaintext, so the running
   process never holds a comparable copy of the password. */
const SALT = crypto.randomBytes(16);
const PASSWORD_HASH = crypto.scryptSync(ADMIN_PASSWORD, SALT, 64);

/** Constant-time comparison, so a wrong password cannot be found by timing. */
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

/* ----------------------------------------------------------- session store */
const sessions = new Map();   // token -> { email, expiresAt }

function createSession(email){
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { email, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function readSession(token){
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()){ sessions.delete(token); return null; }
  return s;
}
function destroySession(token){ if (token) sessions.delete(token); }

/* ------------------------------------------------------------------ cookies */
function parseCookies(header){
  const out = {};
  String(header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(token){
  // httpOnly so page scripts cannot read it; SameSite=Strict to blunt CSRF on
  // the state-changing admin routes; Path=/ so it travels with API calls.
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${SECURE_COOKIES ? "; Secure" : ""}; Max-Age=${SESSION_TTL_MS / 1000}`;
}
function clearCookie(){
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/${SECURE_COOKIES ? "; Secure" : ""}; Max-Age=0`;
}

/** The admin identity behind a request, or null. Every admin route calls this. */
function currentAdmin(req){
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = readSession(token);
  return session ? { email: session.email, token } : null;
}

/** Verifies a login attempt. Returns a token, or null. */
function login(email, password){
  const okEmail = emailMatches(email);
  const okPass  = passwordMatches(password);
  // Evaluate both before branching, so the failure path costs the same either way.
  if (!okEmail || !okPass) return null;
  return createSession(ADMIN_EMAIL);
}

module.exports = {
  SESSION_COOKIE, ADMIN_EMAIL, USING_DEFAULT_PASSWORD, SECURE_COOKIES,
  login, currentAdmin, destroySession, parseCookies, sessionCookie, clearCookie
};
