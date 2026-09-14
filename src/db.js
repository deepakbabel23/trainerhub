"use strict";
/* ============================================================================
   TrainerHub — database connection (Phase 3)

   Thin wrapper over node-postgres. Owns the pool, SSL, migrations and the
   error-code translation the store relies on.

   `pg` is loaded lazily so the application still boots and runs on the file
   backend when the dependency is absent — which is how the existing 68 tests
   keep running unchanged.
   ========================================================================== */

const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const isEnabled = () => !!DATABASE_URL;

/* Postgres SQLSTATE codes we act on. */
const PG_UNIQUE_VIOLATION = "23505";

let pool = null;
let Pool = null;

function loadDriver(){
  if (Pool) return Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (e){
    throw new Error(
      "DATABASE_URL is set but the 'pg' package is not installed.\n" +
      "Run `npm install` so the Postgres driver is available, then restart."
    );
  }
  return Pool;
}

function getPool(){
  if (pool) return pool;
  loadDriver();
  pool = new Pool({
    connectionString: DATABASE_URL,
    // Neon (and most managed Postgres) require TLS. Their certificate chain is
    // not in Node's default store, so verification is relaxed here; the
    // connection is still encrypted. Set PGSSLMODE=verify-full with a CA
    // bundle if you need full verification.
    ssl: /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  pool.on("error", err => console.error("[db] idle client error:", err.message));
  return pool;
}

/** Run a query. Returns the pg result. */
async function query(text, params){
  const p = getPool();
  try {
    return await p.query(text, params);
  } catch (err){
    // Surface something actionable rather than a bare driver error.
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED"){
      err.message = `Cannot reach the database (${err.code}). Check DATABASE_URL. Original: ${err.message}`;
    }
    throw err;
  }
}

/** Convenience: return rows only. */
async function rows(text, params){
  const r = await query(text, params);
  return r.rows;
}

/** Convenience: first row or null. */
async function one(text, params){
  const r = await query(text, params);
  return r.rows[0] || null;
}

/** Run a callback inside a transaction, on a single dedicated client. */
async function transaction(fn){
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err){
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

function isUniqueViolation(err){
  return err && err.code === PG_UNIQUE_VIOLATION;
}

/**
 * Apply the schema. Idempotent — every statement is CREATE ... IF NOT EXISTS,
 * so this is safe on every boot and never touches existing rows.
 */
async function migrate(){
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await query(sql);
  const { rows: [{ count }] } = await query("SELECT count(*)::int AS count FROM sessions");
  return { sessionCount: count };
}

/** Housekeeping: drop expired admin sessions and stale rate-limit rows. */
async function cleanup(){
  await query("DELETE FROM admin_sessions WHERE expires_at < now()");
  await query("DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 day'");
}

async function close(){
  if (pool){ await pool.end(); pool = null; }
}

async function healthy(){
  try { await query("SELECT 1"); return true; } catch { return false; }
}

module.exports = {
  isEnabled, query, rows, one, transaction,
  isUniqueViolation, migrate, cleanup, close, healthy,
  PG_UNIQUE_VIOLATION,
  get url(){ return DATABASE_URL; }
};
