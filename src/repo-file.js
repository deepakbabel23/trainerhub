"use strict";
/* ============================================================================
   TrainerHub — file repository (Phase 3)

   The Phase 2 JSON-file store, reshaped to the same async repository
   interface as the Postgres backend. Kept for local development and for the
   test suite, so the 68 existing tests prove that migrating the storage layer
   changed no behaviour anywhere above it.

   Not for production: no durability across restarts, and its slot guarantee
   relies on Node's single-threaded handler model rather than a constraint.
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR  = process.env.TRAINERHUB_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "trainerhub.json");

const OCCUPYING = ["RESERVED", "PUBLISHED"];

let state = null;

function emptyState(){
  return { version: 3, sessions: [], registrations: [], adminSessions: {}, loginAttempts: [] };
}

function load(){
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (parsed && Array.isArray(parsed.sessions)){
      // No date-based reseed. Phase 2 discarded stored data whenever the day
      // rolled over, which is destructive the moment data is real.
      parsed.adminSessions = parsed.adminSessions || {};
      parsed.loginAttempts = parsed.loginAttempts || [];
      return parsed;
    }
  } catch { /* missing or corrupt — start fresh */ }
  return emptyState();
}

function persist(){
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e){ console.error("[repo-file] persist failed:", e.message); }
}

function s(){ if (!state) state = load(); return state; }

async function init(){
  state = load(); persist();
  return { backend: "file", sessionCount: state.sessions.length };
}

/* ------------------------------------------------------------- selectors */
const clone = o => (o ? JSON.parse(JSON.stringify(o)) : o);

async function activeSessionsInRange(fromISO, toISO){
  return clone(s().sessions
    .filter(x => OCCUPYING.includes(x.status) && x.date >= fromISO && x.date <= toISO)
    .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot)));
}
async function sessionById(id){
  return clone(s().sessions.find(x => x.id === id) || null);
}
async function publishedUpcoming(){
  return clone(s().sessions.filter(x => x.status === "PUBLISHED")
    .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot)));
}
async function pendingSessions(){
  return clone(s().sessions.filter(x => x.status === "RESERVED")
    .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot)));
}
async function registrationCounts(){
  const map = {};
  s().registrations.forEach(r => { map[r.sessionId] = (map[r.sessionId] || 0) + 1; });
  return map;
}
async function registrationCount(sessionId){
  return s().registrations.filter(r => r.sessionId === sessionId).length;
}

/* ------------------------------------------------------------- mutations */

/** Mirrors the Postgres partial unique index in application code. */
async function insertSession(sess){
  const st = s();
  const clash = st.sessions.find(x =>
    x.date === sess.date && x.slot === sess.slot && OCCUPYING.includes(x.status));
  if (clash) return { ok: false, reason: "TAKEN" };
  const row = {
    ...sess,
    description: sess.description || "",
    speakerPhone: sess.speakerPhone || "",
    speakerEmail: sess.speakerEmail || "",
    source: sess.source || "speaker",
    createdAt: Date.now(),
    decidedAt: sess.status === "PUBLISHED" ? Date.now() : null
  };
  st.sessions.push(row); persist();
  return { ok: true, session: clone(row) };
}

async function transition(id, fromStatus, toStatus){
  const st = s();
  const row = st.sessions.find(x => x.id === id && x.status === fromStatus);
  if (!row) return null;
  row.status = toStatus; row.decidedAt = Date.now();
  persist();
  return clone(row);
}

async function addRegistration(reg){
  s().registrations.push({ ...reg }); persist();
  return reg;
}

/* --------------------------------------------------------- admin sessions */
async function createAdminSession(token, email, expiresAtMs){
  s().adminSessions[token] = { email, expiresAt: expiresAtMs }; persist();
}
async function readAdminSession(token){
  if (!token) return null;
  const rec = s().adminSessions[token];
  if (!rec) return null;
  if (rec.expiresAt < Date.now()){ delete s().adminSessions[token]; persist(); return null; }
  return { email: rec.email };
}
async function destroyAdminSession(token){
  if (!token) return;
  delete s().adminSessions[token]; persist();
}

/* ---------------------------------------------------------- rate limiting */
async function recordLoginAttempt(ip, successful){
  const st = s();
  st.loginAttempts.push({ ip, successful: !!successful, at: Date.now() });
  const cutoff = Date.now() - 24 * 3600 * 1000;
  st.loginAttempts = st.loginAttempts.filter(a => a.at > cutoff);
  persist();
}
async function recentFailedLogins(ip, windowMinutes){
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  return s().loginAttempts.filter(a => a.ip === ip && !a.successful && a.at > cutoff).length;
}

/* ------------------------------------------------------------------ seed */
async function seedIfEmpty(buildSessions){
  const st = s();
  if (st.sessions.length > 0) return { seeded: false, existing: st.sessions.length };
  for (const sess of buildSessions()) await insertSession(sess);
  return { seeded: true, count: st.sessions.length };
}

async function stats(){
  const st = s();
  return {
    sessions: st.sessions.length,
    reserved: st.sessions.filter(x => x.status === "RESERVED").length,
    published: st.sessions.filter(x => x.status === "PUBLISHED").length,
    registrations: st.registrations.length
  };
}

/** Test-only: wipe everything. Never reachable in production. */
async function _resetAll(){ state = emptyState(); persist(); }

module.exports = {
  backend: "file",
  init,
  activeSessionsInRange, sessionById, publishedUpcoming, pendingSessions,
  registrationCounts, registrationCount,
  insertSession, transition, addRegistration,
  createAdminSession, readAdminSession, destroyAdminSession,
  recordLoginAttempt, recentFailedLogins,
  seedIfEmpty, stats, _resetAll,
  healthy: async () => true,
  close: async () => {},
  DATA_FILE
};
