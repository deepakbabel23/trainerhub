"use strict";
/* ============================================================================
   TrainerHub — Postgres repository (Phase 3)

   Implements the repository interface against Neon / any Postgres.

   Two deliberate choices worth knowing about:

   1. Dates are read with to_char(session_date, 'YYYY-MM-DD'), never as a
      native DATE. node-postgres parses DATE into a JS Date at local midnight,
      which would reintroduce exactly the class of timezone bug recorded as
      FINDING-001. Keeping the calendar date as an opaque 'YYYY-MM-DD' string
      end to end means no implicit conversion can happen.

   2. Slot claiming is an INSERT, not a check-then-write. The partial unique
      index decides who wins; a unique violation becomes the existing 409.
   ========================================================================== */

const db = require("./db");

/* --------------------------------------------------------------- mapping */
const SESSION_COLUMNS = `
  id,
  to_char(session_date, 'YYYY-MM-DD')      AS date,
  slot,
  status,
  topic,
  description,
  speaker_name                              AS "speakerName",
  speaker_phone                             AS "speakerPhone",
  speaker_email                             AS "speakerEmail",
  meeting_link                              AS "meetingLink",
  source,
  (extract(epoch from created_at) * 1000)::bigint::text AS "createdAtMs",
  CASE WHEN decided_at IS NULL THEN NULL
       ELSE (extract(epoch from decided_at) * 1000)::bigint::text END AS "decidedAtMs"
`;

/** Normalise a DB row into the shape the rest of the app already expects. */
function mapSession(r){
  if (!r) return null;
  return {
    id: r.id,
    date: r.date,
    slot: r.slot,
    status: r.status,
    topic: r.topic,
    description: r.description || "",
    speakerName: r.speakerName,
    speakerPhone: r.speakerPhone || "",
    speakerEmail: r.speakerEmail || "",
    meetingLink: r.meetingLink,
    source: r.source,
    createdAt: Number(r.createdAtMs),
    decidedAt: r.decidedAtMs == null ? null : Number(r.decidedAtMs)
  };
}

/* ------------------------------------------------------------------ init */
async function init(){
  const { sessionCount } = await db.migrate();
  await db.cleanup();
  return { backend: "postgres", sessionCount };
}

/* ------------------------------------------------------------- selectors */

/** Sessions occupying a slot (RESERVED or PUBLISHED) within a date range. */
async function activeSessionsInRange(fromISO, toISO){
  const rows = await db.rows(
    `SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE status IN ('RESERVED','PUBLISHED')
        AND session_date BETWEEN $1::date AND $2::date
      ORDER BY session_date, slot`,
    [fromISO, toISO]
  );
  return rows.map(mapSession);
}

async function sessionById(id){
  const r = await db.one(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`, [id]);
  return mapSession(r);
}

/** Published sessions that have not yet started. RULE-008. */
async function publishedUpcoming(){
  const rows = await db.rows(
    `SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE status = 'PUBLISHED'
      ORDER BY session_date, slot`
  );
  return rows.map(mapSession);
}

async function pendingSessions(){
  const rows = await db.rows(
    `SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE status = 'RESERVED'
      ORDER BY session_date, slot`
  );
  return rows.map(mapSession);
}

async function registrationCounts(){
  const rows = await db.rows(
    `SELECT session_id AS id, count(*)::int AS n FROM registrations GROUP BY session_id`
  );
  const map = {};
  rows.forEach(r => { map[r.id] = r.n; });
  return map;
}

async function registrationCount(sessionId){
  const r = await db.one(
    `SELECT count(*)::int AS n FROM registrations WHERE session_id = $1`, [sessionId]);
  return r ? r.n : 0;
}

/* -------------------------------------------------------------- mutations */

/**
 * Claim a slot. The partial unique index is the arbiter — if another request
 * already holds this slot, Postgres raises 23505 and we translate it.
 * Returns { ok: true, session } or { ok: false, reason: "TAKEN" }.
 */
async function insertSession(s){
  try {
    const r = await db.one(
      `INSERT INTO sessions
         (id, session_date, slot, status, topic, description,
          speaker_name, speaker_phone, speaker_email, meeting_link, source, decided_at)
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               CASE WHEN $4 = 'PUBLISHED' THEN now() ELSE NULL END)
       RETURNING ${SESSION_COLUMNS}`,
      [s.id, s.date, s.slot, s.status, s.topic, s.description || "",
       s.speakerName, s.speakerPhone || "", s.speakerEmail || "", s.meetingLink, s.source || "speaker"]
    );
    return { ok: true, session: mapSession(r) };
  } catch (err){
    if (db.isUniqueViolation(err)) return { ok: false, reason: "TAKEN" };
    throw err;
  }
}

/**
 * Move a session from one status to another, only if it is currently in the
 * expected status. The WHERE clause makes this a compare-and-set, so two
 * administrators clicking Approve at the same moment cannot both succeed.
 * Returns the updated session, or null if the precondition failed.
 */
async function transition(id, fromStatus, toStatus){
  const r = await db.one(
    `UPDATE sessions SET status = $3, decided_at = now()
      WHERE id = $1 AND status = $2
      RETURNING ${SESSION_COLUMNS}`,
    [id, fromStatus, toStatus]
  );
  return mapSession(r);
}

async function addRegistration(reg){
  await db.query(
    `INSERT INTO registrations (id, session_id, participant_name) VALUES ($1, $2, $3)`,
    [reg.id, reg.sessionId, reg.participantName]
  );
  return reg;
}

/* --------------------------------------------------------- admin sessions */

async function createAdminSession(token, email, expiresAtMs){
  await db.query(
    `INSERT INTO admin_sessions (token, email, expires_at)
     VALUES ($1, $2, to_timestamp($3::bigint / 1000.0))`,
    [token, email, String(expiresAtMs)]
  );
}

async function readAdminSession(token){
  if (!token) return null;
  const r = await db.one(
    `SELECT email FROM admin_sessions WHERE token = $1 AND expires_at > now()`, [token]);
  return r ? { email: r.email } : null;
}

async function destroyAdminSession(token){
  if (!token) return;
  await db.query(`DELETE FROM admin_sessions WHERE token = $1`, [token]);
}

/* ---------------------------------------------------------- rate limiting */

async function recordLoginAttempt(ip, successful){
  await db.query(`INSERT INTO login_attempts (ip, successful) VALUES ($1, $2)`, [ip, !!successful]);
}

/** Failed attempts from this IP within the window. */
async function recentFailedLogins(ip, windowMinutes){
  const r = await db.one(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE ip = $1 AND successful = false
        AND attempted_at > now() - ($2::int * interval '1 minute')`,
    [ip, windowMinutes]
  );
  return r ? r.n : 0;
}

/* ------------------------------------------------------------------ seed */

/**
 * Insert demo rows ONLY into an empty database, and only when explicitly
 * requested. Phase 2 reseeded whenever the stored date changed, which was
 * correct for an ephemeral demo and would silently delete real bookings here.
 */
async function seedIfEmpty(buildSessions){
  const r = await db.one(`SELECT count(*)::int AS n FROM sessions`);
  if (r && r.n > 0) return { seeded: false, existing: r.n };
  const sessions = buildSessions();
  for (const s of sessions) await insertSession(s);
  return { seeded: true, count: sessions.length };
}

async function stats(){
  const r = await db.one(`
    SELECT
      (SELECT count(*)::int FROM sessions)                              AS sessions,
      (SELECT count(*)::int FROM sessions WHERE status = 'RESERVED')    AS reserved,
      (SELECT count(*)::int FROM sessions WHERE status = 'PUBLISHED')   AS published,
      (SELECT count(*)::int FROM registrations)                         AS registrations`);
  return r || {};
}

module.exports = {
  backend: "postgres",
  init,
  activeSessionsInRange, sessionById, publishedUpcoming, pendingSessions,
  registrationCounts, registrationCount,
  insertSession, transition, addRegistration,
  createAdminSession, readAdminSession, destroyAdminSession,
  recordLoginAttempt, recentFailedLogins,
  seedIfEmpty, stats,
  healthy: db.healthy, close: db.close
};
