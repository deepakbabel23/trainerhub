"use strict";
/* ============================================================================
   TrainerHub — Postgres repository contract test (no database required)

   The full Postgres suite (test/postgres.js) needs a real Neon database.
   This one does not, and it catches the bug classes that would otherwise only
   surface in production:

     • placeholder/parameter count mismatches ($1..$n vs params.length)
     • a unique violation not being translated into { ok:false, TAKEN }
     • column aliases drifting out of step with the mapper
     • DATE being read natively instead of via to_char — the FINDING-001 trap
     • SQL that silently references a column the schema does not define

   It works by substituting a stub for the `pg` driver that records every
   query instead of executing it. It proves the JavaScript is correct; only
   test/postgres.js can prove Postgres accepts the SQL.
   ========================================================================== */

const Module = require("module");
const fs = require("fs");
const path = require("path");

/* ------------------------------------------------------- the pg stub ---- */
const calls = [];
let nextResult = { rows: [], rowCount: 0 };
let throwCode = null;

class FakeClient {
  async query(text, params){
    if (typeof text === "object" && text !== null){ params = text.values; text = text.text; }
    calls.push({ text, params: params || [] });
    if (throwCode){ const e = new Error("stub error"); e.code = throwCode; throwCode = null; throw e; }
    return nextResult;
  }
  release(){}
}
class FakePool {
  constructor(cfg){ this.cfg = cfg; FakePool.lastConfig = cfg; }
  on(){}
  async connect(){ return new FakeClient(); }
  async query(text, params){ return new FakeClient().query(text, params); }
  async end(){}
}

const realResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest){
  if (request === "pg") return "pg-stub";
  return realResolve.call(this, request, ...rest);
};
require.cache["pg-stub"] = { id: "pg-stub", filename: "pg-stub", loaded: true, exports: { Pool: FakePool } };

process.env.DATABASE_URL = "postgresql://u:p@ep-test.neon.tech/neondb?sslmode=require";

const db   = require("../src/db");
const repo = require("../src/repo-pg");

/* --------------------------------------------------------------- harness */
let pass = 0, fail = 0;
function check(name, cond, detail){
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
function section(n){ console.log(`\n\x1b[1m${n}\x1b[0m`); }
const last = () => calls[calls.length - 1];
function reset(rows = []){ calls.length = 0; nextResult = { rows, rowCount: rows.length }; }

/** Highest $N referenced in the SQL. */
function maxPlaceholder(sql){
  const m = sql.match(/\$(\d+)/g) || [];
  return m.reduce((a, p) => Math.max(a, +p.slice(1)), 0);
}

/* Columns the schema actually defines, so SQL cannot drift from it. */
const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8");
function schemaHasColumn(table, col){
  const t = SCHEMA.split(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`, "i"))[1];
  if (!t) return false;
  return new RegExp(`^\\s*${col}\\s`, "im").test(t.split(/^\);/m)[0]);
}

const ROW = {
  id: "abc123", date: "2026-09-20", slot: "11:00", status: "RESERVED",
  topic: "T", description: "D",
  speakerName: "A B", speakerPhone: "+91 1", speakerEmail: "a@b.co",
  meetingLink: "https://meet.google.com/x", source: "speaker",
  createdAtMs: "1757800000000", decidedAtMs: null
};

(async () => {
  console.log("\n\x1b[1mTrainerHub — Postgres repository contract (stubbed driver)\x1b[0m");

  /* ------------------------------------------------------- connection */
  section("Connection");
  reset([{ count: 0 }]);
  await db.query("SELECT 1");
  check("TLS is requested for a Neon URL",
    !!FakePool.lastConfig.ssl, JSON.stringify(FakePool.lastConfig.ssl));
  check("A pool bound is configured", FakePool.lastConfig.max > 0, `max=${FakePool.lastConfig.max}`);

  /* -------------------------------------------- parameter binding ---- */
  section("Every query binds exactly the parameters it references");

  const probes = [
    ["activeSessionsInRange", () => repo.activeSessionsInRange("2026-09-14", "2026-09-20")],
    ["sessionById",           () => repo.sessionById("abc123")],
    ["publishedUpcoming",     () => repo.publishedUpcoming()],
    ["pendingSessions",       () => repo.pendingSessions()],
    ["registrationCount",     () => repo.registrationCount("abc123")],
    ["transition",            () => repo.transition("abc123", "RESERVED", "PUBLISHED")],
    ["addRegistration",       () => repo.addRegistration({ id: "r1", sessionId: "abc123", participantName: "Anita Rao" })],
    ["createAdminSession",    () => repo.createAdminSession("tok", "a@b.co", Date.now() + 1000)],
    ["readAdminSession",      () => repo.readAdminSession("tok")],
    ["destroyAdminSession",   () => repo.destroyAdminSession("tok")],
    ["recordLoginAttempt",    () => repo.recordLoginAttempt("1.2.3.4", false)],
    ["recentFailedLogins",    () => repo.recentFailedLogins("1.2.3.4", 15)],
    ["insertSession",         () => repo.insertSession({ ...ROW, createdAt: 0 })]
  ];

  let mismatches = [];
  for (const [name, run] of probes){
    reset([ROW]);
    await run();
    for (const c of calls){
      const need = maxPlaceholder(c.text);
      if (need !== c.params.length){
        mismatches.push(`${name}: SQL uses $${need} but ${c.params.length} params supplied`);
      }
    }
  }
  check(`Placeholder counts match across ${probes.length} operations`,
    mismatches.length === 0, mismatches.join("; ") || "no mismatches");

  /* -------------------------------------------------- date handling -- */
  section("Date handling (FINDING-001 guard)");
  reset([ROW]);
  await repo.sessionById("abc123");
  check("Dates are read with to_char, never as a native DATE",
    /to_char\(\s*session_date\s*,\s*'YYYY-MM-DD'\s*\)/.test(last().text),
    "prevents the driver parsing DATE into a local-midnight Date object");

  reset([ROW]);
  await repo.insertSession({ ...ROW });
  check("Dates are written with an explicit ::date cast",
    /\$2::date/.test(last().text));

  reset([ROW]);
  const mapped = await repo.sessionById("abc123");
  check("Row maps to the shape the rest of the app expects",
    mapped.date === "2026-09-20" && mapped.speakerName === "A B" &&
    typeof mapped.createdAt === "number" && mapped.decidedAt === null,
    `createdAt=${mapped.createdAt} (number), date is a string`);

  /* ------------------------------------------- unique violation ------ */
  section("Unique violation becomes a clean 409");
  reset([]);
  throwCode = "23505";
  const taken = await repo.insertSession({ ...ROW });
  check("23505 maps to { ok:false, reason:'TAKEN' }",
    taken.ok === false && taken.reason === "TAKEN", JSON.stringify(taken));

  reset([]);
  throwCode = "42P01";                       // undefined table — a real bug
  let rethrown = false;
  try { await repo.insertSession({ ...ROW }); } catch { rethrown = true; }
  check("Other database errors are NOT swallowed", rethrown,
    "only 23505 is treated as a taken slot");

  /* ------------------------------------------ SQL matches the schema - */
  section("SQL references only columns the schema defines");
  const referenced = new Set();
  reset([ROW]);
  for (const [, run] of probes){ try { await run(); } catch {} }
  calls.forEach(c => {
    (c.text.match(/\b(session_date|speaker_name|speaker_phone|speaker_email|meeting_link|decided_at|created_at|participant_name|registered_at|expires_at|attempted_at|successful)\b/g) || [])
      .forEach(col => referenced.add(col));
  });
  const undefinedCols = [...referenced].filter(col =>
    !["sessions", "registrations", "admin_sessions", "login_attempts"].some(t => schemaHasColumn(t, col)));
  check(`All ${referenced.size} referenced columns exist in schema.sql`,
    undefinedCols.length === 0, undefinedCols.length ? "MISSING: " + undefinedCols.join(", ") : [...referenced].join(", "));

  /* -------------------------------------------- transition semantics - */
  section("Transition is a compare-and-set");
  reset([ROW]);
  await repo.transition("abc123", "RESERVED", "PUBLISHED");
  check("UPDATE is guarded by the expected current status",
    /WHERE\s+id\s*=\s*\$1\s+AND\s+status\s*=\s*\$2/i.test(last().text),
    "so two concurrent approvals cannot both apply");

  reset([]);                                  // no rows returned = precondition failed
  const blocked = await repo.transition("abc123", "RESERVED", "PUBLISHED");
  check("A failed precondition returns null, not a throw", blocked === null);

  /* --------------------------------------------------- seed safety --- */
  section("Seed safety");
  reset([{ n: 7 }]);
  const seeded = await repo.seedIfEmpty(() => { throw new Error("must not be called"); });
  check("Seeding a non-empty database is a no-op",
    seeded.seeded === false && seeded.existing === 7,
    "real bookings can never be overwritten by demo data");

  console.log("\n" + "─".repeat(68));
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log("─".repeat(68) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error("Crashed:", err); process.exit(1); });
