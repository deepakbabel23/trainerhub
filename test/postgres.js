"use strict";
/* ============================================================================
   TrainerHub — Postgres integration suite (Phase 3)

   Proves the things only a real database can prove, and that the Phase 2
   file store could not:

     • the partial unique index actually prevents double-booking, even under
       genuinely concurrent inserts
     • rejecting and cancelling really free the slot
     • data survives losing every connection (the spin-down scenario)
     • admin sessions outlive a restart
     • login rate limiting engages

   Run:  DATABASE_URL='postgres://...' npm run test:pg

   SAFETY: this suite writes and deletes rows. It only touches rows it
   created, identified by a unique run tag, and it refuses to run against a
   database that already holds sessions unless you pass --allow-dirty.
   ========================================================================== */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

if (!process.env.DATABASE_URL){
  console.error(`
Set DATABASE_URL first, e.g.

  DATABASE_URL='postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require' npm run test:pg
`);
  process.exit(1);
}

const ALLOW_DIRTY = process.argv.includes("--allow-dirty");
const db   = require("../src/db");
const repo = require("../src/repo-pg");
const D    = require("../src/domain");
const crypto = require("crypto");

const TAG = "pgtest-" + crypto.randomBytes(4).toString("hex");
const uid = () => crypto.randomBytes(6).toString("hex");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail){
  cond ? pass++ : (fail++, failures.push(name));
  console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
}
function section(n){ console.log(`\n\x1b[1m${n}\x1b[0m`); }

/* Use dates far outside the booking window so this can never collide with
   real bookings, and clean up by tag afterwards. */
function farDate(offsetDays){
  const d = new Date(); d.setFullYear(d.getFullYear() + 5);
  d.setDate(d.getDate() + offsetDays);
  return D.iso(d);
}
const mk = (date, slot, over = {}) => ({
  id: uid(), date, slot, status: "RESERVED",
  topic: TAG + " topic", description: "",
  speakerName: "Test Speaker", speakerPhone: "+91 98200 11223", speakerEmail: "",
  meetingLink: "https://meet.google.com/" + TAG, source: "speaker", ...over
});

async function cleanup(){
  await db.query(`DELETE FROM registrations WHERE session_id IN (SELECT id FROM sessions WHERE topic LIKE $1)`, [TAG + "%"]);
  await db.query(`DELETE FROM sessions WHERE topic LIKE $1`, [TAG + "%"]);
  await db.query(`DELETE FROM admin_sessions WHERE email = $1`, [TAG + "@test.local"]);
  await db.query(`DELETE FROM login_attempts WHERE ip = $1`, [TAG]);
}

(async () => {
  console.log(`\n\x1b[1mTrainerHub — Postgres integration suite\x1b[0m`);
  console.log(`  run tag: ${TAG}\n`);

  /* ------------------------------------------------------------ schema */
  section("Schema");
  const info = await repo.init();
  check("Migration runs and is idempotent", true, `${info.sessionCount} sessions currently in the database`);
  await repo.init();   // second run must not error
  check("Re-running the migration is safe", true, "CREATE ... IF NOT EXISTS throughout");

  if (info.sessionCount > 0 && !ALLOW_DIRTY){
    console.log(`\n\x1b[33mThis database already holds ${info.sessionCount} sessions.\x1b[0m`);
    console.log(`Refusing to run against data that might be real.`);
    console.log(`If this is a scratch database, re-run with:  npm run test:pg -- --allow-dirty\n`);
    await db.close();
    process.exit(1);
  }

  const idx = await db.one(`
    SELECT indexdef FROM pg_indexes
     WHERE tablename = 'sessions' AND indexname = 'sessions_active_slot_uniq'`);
  check("The partial unique index exists",
    !!idx && /UNIQUE/i.test(idx.indexdef) && /RESERVED/.test(idx.indexdef),
    idx ? idx.indexdef.replace(/\s+/g, " ").slice(0, 120) + "…" : "MISSING");

  /* -------------------------------------------------- slot uniqueness */
  section("Slot uniqueness — enforced by the database, not the application");

  const d1 = farDate(1);
  const first = await repo.insertSession(mk(d1, "11:00"));
  check("First nomination succeeds", first.ok && first.session.status === "RESERVED");

  const dup = await repo.insertSession(mk(d1, "11:00"));
  check("Second nomination for the same slot is refused",
    dup.ok === false && dup.reason === "TAKEN");

  const otherSlot = await repo.insertSession(mk(d1, "19:00"));
  check("The other slot that day is unaffected", otherSlot.ok === true);

  /* The real test. Phase 2 could only serialise these because Node runs one
     handler at a time; here they hit Postgres genuinely in parallel. */
  const d2 = farDate(2);
  const racers = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      repo.insertSession(mk(d2, "11:00", { topic: `${TAG} racer ${i}` })))
  );
  const winners = racers.filter(r => r.ok).length;
  check("20 genuinely concurrent inserts — exactly one wins",
    winners === 1, `${winners} accepted, ${racers.length - winners} rejected with 23505`);

  /* ------------------------------------------------ lifecycle + release */
  section("Lifecycle releases the slot");

  const rejected = await repo.transition(first.session.id, "RESERVED", "REJECTED");
  check("Reject transitions the row", !!rejected && rejected.status === "REJECTED");

  const afterReject = await repo.insertSession(mk(d1, "11:00", { topic: TAG + " rebooked" }));
  check("The rejected slot can be claimed again", afterReject.ok === true,
    "the partial index excludes REJECTED, so the slot is genuinely free");

  const approved = await repo.transition(afterReject.session.id, "RESERVED", "PUBLISHED");
  check("Approve transitions RESERVED to PUBLISHED", !!approved && approved.status === "PUBLISHED");

  const doubleApprove = await repo.transition(afterReject.session.id, "RESERVED", "PUBLISHED");
  check("Approving twice is refused (compare-and-set)", doubleApprove === null,
    "two admins clicking at once cannot both apply");

  const cancelled = await repo.transition(afterReject.session.id, "PUBLISHED", "CANCELLED");
  check("Cancel transitions PUBLISHED to CANCELLED", !!cancelled && cancelled.status === "CANCELLED");

  const afterCancel = await repo.insertSession(mk(d1, "11:00", { topic: TAG + " after cancel" }));
  check("The cancelled slot can be claimed again", afterCancel.ok === true);

  /* ----------------------------------------------------- registrations */
  section("Registrations");
  const pubSession = await repo.transition(afterCancel.session.id, "RESERVED", "PUBLISHED");
  await repo.addRegistration({ id: uid(), sessionId: pubSession.id, participantName: "Anita Rao" });
  await repo.addRegistration({ id: uid(), sessionId: pubSession.id, participantName: "Vikram Nair" });
  check("Registrations are recorded", (await repo.registrationCount(pubSession.id)) === 2);

  /* ------------------------------------------------------- persistence */
  section("Persistence — the whole point of Phase 3");

  const survivorId = pubSession.id;
  await db.close();                    // drop every connection, as a spin-down does
  check("All database connections closed", true, "simulating a Render spin-down");

  const again = await repo.sessionById(survivorId);   // forces a brand-new pool
  check("The booking is still there after reconnecting",
    !!again && again.id === survivorId && again.status === "PUBLISHED",
    "on the file store this row would have been gone");
  check("Its registrations survived too", (await repo.registrationCount(survivorId)) === 2);
  check("Dates survive the round trip as plain YYYY-MM-DD",
    again.date === d1, `${again.date} (no timezone drift — see FINDING-001)`);

  /* ---------------------------------------------------- admin sessions */
  section("Admin sessions and rate limiting");

  const token = crypto.randomBytes(16).toString("hex");
  await repo.createAdminSession(token, TAG + "@test.local", Date.now() + 60_000);
  await db.close();                    // restart again
  const restored = await repo.readAdminSession(token);
  check("An admin session survives a restart", !!restored && restored.email === TAG + "@test.local",
    "Phase 2 kept these in memory, so every spin-down signed the admin out");

  const expired = crypto.randomBytes(16).toString("hex");
  await repo.createAdminSession(expired, TAG + "@test.local", Date.now() - 1000);
  check("An expired session is rejected", (await repo.readAdminSession(expired)) === null);

  await repo.destroyAdminSession(token);
  check("Sign-out invalidates the session", (await repo.readAdminSession(token)) === null);

  for (let i = 0; i < 5; i++) await repo.recordLoginAttempt(TAG, false);
  check("Failed login attempts are counted per IP",
    (await repo.recentFailedLogins(TAG, 15)) === 5);
  check("Old attempts fall outside the window",
    (await repo.recentFailedLogins(TAG, 0)) === 0);

  /* ------------------------------------------------------------ safety */
  section("Safety rails");
  const seedResult = await repo.seedIfEmpty(() => []);
  check("Seeding refuses to touch a non-empty database",
    seedResult.seeded === false, `${seedResult.existing} rows present`);

  /* ----------------------------------------------------------- cleanup */
  await cleanup();
  const leftover = await db.one(`SELECT count(*)::int AS n FROM sessions WHERE topic LIKE $1`, [TAG + "%"]);
  check("Test data cleaned up", leftover.n === 0, `${leftover.n} rows left behind`);

  const finalStats = await repo.stats();
  console.log("\n" + "─".repeat(68));
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail) console.log(`  Failed: ${failures.join(", ")}`);
  console.log(`  Database now holds: ${finalStats.sessions} sessions, ${finalStats.registrations} registrations`);
  console.log("─".repeat(68) + "\n");

  await db.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async err => {
  console.error("\n\x1b[31mSuite crashed:\x1b[0m", err.message);
  if (/pg' package is not installed/.test(err.message)){
    console.error("\nRun `npm install` first — Phase 3 needs the Postgres driver.\n");
  }
  try { await cleanup(); await db.close(); } catch {}
  process.exit(1);
});
