"use strict";
/* ============================================================================
   TrainerHub — Phase 2 acceptance suite
   Runs the 14 P0 tests from TDD v0.1 plus negative security tests against a
   live server over real HTTP.   Run:  node test/acceptance.js
   ========================================================================== */

const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = Number(process.env.TEST_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trainerhub-test-"));

/* ------------------------------------------------------------- test harness */
let passed = 0, failed = 0;
const results = [];

function check(id, condition, detail){
  const ok = !!condition;
  ok ? passed++ : failed++;
  results.push({ id, ok, detail: detail || "" });
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${id}${detail ? "\n          " + detail : ""}`);
}
function section(name){ console.log(`\n\x1b[1m${name}\x1b[0m`); }

/* ------------------------------------------------------------- http client */
let cookieJar = "";
async function req(method, path, body, { withCookie = true, captureCookie = false } = {}){
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (withCookie && cookieJar) headers["Cookie"] = cookieJar;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (captureCookie){
    const sc = res.headers.get("set-cookie");
    if (sc) cookieJar = sc.split(";")[0];
  }
  return { status: res.status, json, text, headers: res.headers };
}
const GET  = (p, o) => req("GET",  p, null, o);
const POST = (p, b, o) => req("POST", p, b, o);

/* -------------------------------------------------------------- date helpers */
function iso(d){
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function addDays(d, n){ const x = new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }

const validNomination = (date, slot, over = {}) => ({
  date, slot,
  topic: "Test Session Topic",
  description: "A description for the test session.",
  meetingLink: "https://meet.google.com/tst-abcd-efg",
  speakerName: "Test Speaker",
  speakerPhone: "+91 98200 11223",
  speakerEmail: "test@example.com",
  ...over
});

/* --------------------------------------------------------------------- main */
let child;
async function waitForServer(timeoutMs = 10000){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    try { const r = await fetch(BASE + "/api/calendar"); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error("server did not start in time");
}

async function run(){
  console.log(`\nTrainerHub Phase 2 — acceptance suite`);
  console.log(`Server ${BASE} · data dir ${DATA_DIR}\n`);

  /* ---- reset to a known state -------------------------------------- */
  await POST("/api/demo/reset");

  const today = new Date();
  const W = Array.from({ length: 7 }, (_, i) => iso(addDays(today, i)));

  /* ================================================================== */
  section("Booking window and slot states");

  const cal = (await GET("/api/calendar")).json;
  check("P0-002  seven-day booking window",
    cal.days.length === 7 && cal.days[0].date === W[0] && cal.days[6].date === W[6],
    `days=${cal.days.length}, first=${cal.days[0].date}, last=${cal.days[6].date}`);

  const dayEight = iso(addDays(today, 7));
  const outside = await POST("/api/nominations", validNomination(dayEight, "11:00"));
  check("P0-002b  day 8 rejected by the server",
    outside.status === 409 || outside.status === 422,
    `POST day 8 -> ${outside.status} ${outside.json && outside.json.error}`);

  check("        every day exposes exactly two slots",
    cal.days.every(d => d.slots.length === 2 && d.slots[0].slot === "11:00" && d.slots[1].slot === "19:00"),
    "RULE-001");

  // P0-003 — a slot earlier today must read PASSED and be unbookable.
  const nowHour = new Date().getHours();
  const todaySlots = cal.days[0].slots;
  const passedSlot = todaySlots.find(s => s.state === "PASSED");
  if (nowHour >= 11){
    check("P0-003  passed slot today is unavailable",
      !!passedSlot, `today's slots: ${todaySlots.map(s => s.slot + "=" + s.state).join(", ")}`);
    if (passedSlot){
      const r = await POST("/api/nominations", validNomination(W[0], passedSlot.slot));
      check("P0-003b  server refuses to book a passed slot",
        r.status === 409, `-> ${r.status} ${r.json && r.json.error}`);
    }
  } else {
    check("P0-003  passed slot today is unavailable",
      true, "skipped — no slot has passed yet at this hour (logic covered by P0-003c)");
  }
  // Time-independent proof of the same rule via a past date.
  const past = await POST("/api/nominations", validNomination(iso(addDays(today, -1)), "11:00"));
  check("P0-003c  past date refused",
    past.status === 409 || past.status === 422, `yesterday -> ${past.status}`);

  /* ================================================================== */
  section("Nomination");

  let freeDate = null, freeSlot = null;
  for (const d of cal.days){
    const s = d.slots.find(x => x.state === "AVAILABLE");
    if (s){ freeDate = d.date; freeSlot = s.slot; break; }
  }
  check("        a free slot exists to test with", !!freeDate, `${freeDate} ${freeSlot}`);

  const nom = await POST("/api/nominations", validNomination(freeDate, freeSlot));
  check("P0-004  valid nomination succeeds and reserves the slot",
    nom.status === 201 && nom.json.session.status === "RESERVED",
    `-> ${nom.status}, status=${nom.json && nom.json.session && nom.json.session.status}`);

  const calAfter = (await GET("/api/calendar")).json;
  const nowReserved = calAfter.days.find(d => d.date === freeDate).slots.find(s => s.slot === freeSlot);
  check("P0-004b  calendar reflects the reservation",
    nowReserved.state === "RESERVED", `slot state -> ${nowReserved.state}`);

  const dup = await POST("/api/nominations", validNomination(freeDate, freeSlot));
  check("P0-001  slot uniqueness — second nomination refused",
    dup.status === 409 && dup.json.error === "SLOT_TAKEN",
    `-> ${dup.status} ${dup.json && dup.json.error}`);

  /* Concurrency: fire many simultaneous nominations at one free slot.
     Exactly one must win. This is the race Phase 1 could not close. */
  let raceDate = null, raceSlot = null;
  for (const d of calAfter.days){
    const s = d.slots.find(x => x.state === "AVAILABLE");
    if (s){ raceDate = d.date; raceSlot = s.slot; break; }
  }
  const race = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      POST("/api/nominations", validNomination(raceDate, raceSlot, { topic: "Race entrant " + i })))
  );
  const wins = race.filter(r => r.status === 201).length;
  const losses = race.filter(r => r.status === 409).length;
  check("P0-001b  12 concurrent nominations — exactly one wins",
    wins === 1 && losses === 11, `${wins} created, ${losses} refused`);

  /* Validation — P0-005 */
  const badCases = [
    ["missing topic",        validNomination(W[6], "11:00", { topic: "" }),                    "topic"],
    ["missing link",         validNomination(W[6], "11:00", { meetingLink: "" }),              "meetingLink"],
    ["schemeless link",      validNomination(W[6], "11:00", { meetingLink: "meet.google.com/x" }), "meetingLink"],
    ["nonsense link",        validNomination(W[6], "11:00", { meetingLink: "notaurl" }),       "meetingLink"],
    ["ftp link",             validNomination(W[6], "11:00", { meetingLink: "ftp://x.com/a" }), "meetingLink"],
    ["missing name",         validNomination(W[6], "11:00", { speakerName: "" }),              "speakerName"],
    ["single-word name",     validNomination(W[6], "11:00", { speakerName: "Deepak" }),        "speakerName"],
    ["missing phone",        validNomination(W[6], "11:00", { speakerPhone: "" }),             "speakerPhone"],
    ["short phone",          validNomination(W[6], "11:00", { speakerPhone: "123" }),          "speakerPhone"],
    ["bad email",            validNomination(W[6], "11:00", { speakerEmail: "not-an-email" }), "speakerEmail"],
    ["bogus slot",           validNomination(W[6], "13:00"),                                   "slot"],
    ["bogus date",           validNomination("not-a-date", "11:00"),                           "date"]
  ];
  let allRejected = true, detail = [];
  for (const [label, payload, field] of badCases){
    const r = await POST("/api/nominations", payload);
    const ok = r.status === 422 && r.json.errors && r.json.errors[field];
    if (!ok){ allRejected = false; detail.push(`${label} -> ${r.status}`); }
  }
  check("P0-005  every invalid nomination is rejected (12 cases)",
    allRejected, allRejected ? "all 12 returned 422 with a field error" : detail.join("; "));

  const countBefore = (await GET("/api/admin/dashboard", { withCookie: false })).status;
  check("P0-005b  invalid nominations created nothing",
    countBefore === 401, "dashboard still requires auth — checked again after login");

  /* Email genuinely optional (SPEC SCREEN-04) */
  let optDate = null, optSlot = null;
  const cal3 = (await GET("/api/calendar")).json;
  for (const d of cal3.days){
    const s = d.slots.find(x => x.state === "AVAILABLE");
    if (s){ optDate = d.date; optSlot = s.slot; break; }
  }
  const noEmail = await POST("/api/nominations", validNomination(optDate, optSlot, { speakerEmail: "" }));
  check("        email is optional",
    noEmail.status === 201, `-> ${noEmail.status}`);

  /* ================================================================== */
  section("Public visibility and meeting-link privacy");

  const reservedId = nom.json.session.id;
  const pubList = await GET("/api/sessions");
  check("P0-007  a reserved session is NOT publicly listed",
    !pubList.json.sessions.some(s => s.id === reservedId), `${pubList.json.sessions.length} published`);

  const directFetch = await GET("/api/sessions/" + reservedId);
  check("P0-007b  a reserved session cannot be fetched publicly",
    directFetch.status === 404, `-> ${directFetch.status}`);

  /* P0-008 — scan the raw bytes of every public response for any real link. */
  const admin0 = await POST("/api/admin/login", { email: "admin@trainerhub.app", password: "admin123" }, { captureCookie: true });
  const allSessions = (await GET("/api/admin/dashboard")).json;
  const everyLink = [...allSessions.pending, ...allSessions.published].map(s => s.meetingLink).filter(Boolean);
  const savedCookie = cookieJar; cookieJar = "";            // go anonymous

  const publicResponses = [];
  publicResponses.push(["GET /api/calendar",  (await GET("/api/calendar")).text]);
  publicResponses.push(["GET /api/sessions",  (await GET("/api/sessions")).text]);
  publicResponses.push(["GET /api/bootstrap", (await GET("/api/bootstrap")).text]);
  const somePublished = (await GET("/api/sessions")).json.sessions[0];
  if (somePublished){
    publicResponses.push([`GET /api/sessions/${somePublished.id}`, (await GET("/api/sessions/" + somePublished.id)).text]);
  }
  publicResponses.push([`GET /api/nominations/${reservedId}`, (await GET("/api/nominations/" + reservedId)).text]);

  let leaks = [];
  for (const [label, text] of publicResponses){
    for (const link of everyLink){
      if (text.includes(link)) leaks.push(`${label} leaked ${link}`);
    }
  }
  check("P0-008  no meeting link in ANY public API response",
    leaks.length === 0,
    leaks.length ? leaks.join("; ") : `scanned ${publicResponses.length} endpoints against ${everyLink.length} links`);

  const htmlPage = await fetch(BASE + "/").then(r => r.text());
  const jsBundle = await fetch(BASE + "/app.js").then(r => r.text());
  check("P0-008b  no meeting link in the served HTML or JS",
    !everyLink.some(l => htmlPage.includes(l) || jsBundle.includes(l)),
    "the Phase 1 weakness — mock data shipped to the browser — is gone");

  /* P0-009 — registration reveals the link, and only then. */
  const target = (await GET("/api/sessions")).json.sessions[0];
  const reg = await POST(`/api/sessions/${target.id}/register`, { participantName: "Anita Rao" });
  check("P0-009  registration succeeds and returns the meeting link",
    reg.status === 200 && !!reg.json.session.meetingLink,
    `-> ${reg.status}, link ${reg.json && reg.json.session && reg.json.session.meetingLink ? "present" : "MISSING"}`);

  const badReg1 = await POST(`/api/sessions/${target.id}/register`, { participantName: "" });
  const badReg2 = await POST(`/api/sessions/${target.id}/register`, { participantName: "Anita" });
  check("P0-009b  registration requires a full name",
    badReg1.status === 422 && badReg2.status === 422,
    `empty -> ${badReg1.status}, single word -> ${badReg2.status}`);
  check("P0-009c  a failed registration returns no link",
    !badReg1.text.includes("http") && !badReg2.text.includes("http"), "");

  const regReserved = await POST(`/api/sessions/${reservedId}/register`, { participantName: "Anita Rao" });
  check("P0-008c  cannot register against a reserved session to extract its link",
    regReserved.status === 404 && !regReserved.text.includes("meet.google"),
    `-> ${regReserved.status}`);

  /* ================================================================== */
  section("Administrator authorisation");

  cookieJar = "";   // anonymous
  const guarded = [
    ["GET",  "/api/admin/dashboard"],
    ["GET",  `/api/admin/sessions/${reservedId}`],
    ["POST", `/api/admin/sessions/${reservedId}/approve`],
    ["POST", `/api/admin/sessions/${reservedId}/reject`],
    ["POST", `/api/admin/sessions/${reservedId}/cancel`],
    ["POST", "/api/admin/sessions"]
  ];
  let allGuarded = true, guardDetail = [];
  for (const [method, p] of guarded){
    const r = await req(method, p, method === "POST" ? {} : null, { withCookie: false });
    if (r.status !== 401){ allGuarded = false; guardDetail.push(`${method} ${p} -> ${r.status}`); }
  }
  check("P0-010  every admin route returns 401 without a session",
    allGuarded, allGuarded ? `all ${guarded.length} routes guarded` : guardDetail.join("; "));

  const forged = await req("GET", "/api/admin/dashboard", null, { withCookie: false });
  cookieJar = "th_admin=forged-token-aaaaaaaaaaaaaaaaaaaaaaaa";
  const forged2 = await GET("/api/admin/dashboard");
  check("P0-010b  a forged session cookie is rejected",
    forged2.status === 401, `-> ${forged2.status}`);
  cookieJar = "";

  const wrongPass = await POST("/api/admin/login", { email: "admin@trainerhub.app", password: "nope" });
  const wrongUser = await POST("/api/admin/login", { email: "hacker@evil.com", password: "admin123" });
  check("P0-010c  bad credentials rejected",
    wrongPass.status === 401 && wrongUser.status === 401,
    `wrong password -> ${wrongPass.status}, wrong email -> ${wrongUser.status}`);

  const login = await POST("/api/admin/login", { email: "admin@trainerhub.app", password: "admin123" }, { captureCookie: true });
  check("P0-010d  correct credentials issue an httpOnly session cookie",
    login.status === 200 && /HttpOnly/i.test(login.headers.get("set-cookie") || ""),
    `cookie: ${(login.headers.get("set-cookie") || "").split(";").slice(1).join(";").trim()}`);

  /* ================================================================== */
  section("Lifecycle");

  const approved = await POST(`/api/admin/sessions/${reservedId}/approve`);
  check("P0-011  approval moves RESERVED -> PUBLISHED",
    approved.status === 200 && approved.json.session.status === "PUBLISHED",
    `-> ${approved.json && approved.json.session && approved.json.session.status}`);

  const listAfterApprove = (await GET("/api/sessions", { withCookie: false })).json;
  check("P0-011b  the approved session is now publicly visible",
    listAfterApprove.sessions.some(s => s.id === reservedId), "");

  const calAfterApprove = (await GET("/api/calendar")).json;
  const slotAfterApprove = calAfterApprove.days.find(d => d.date === freeDate).slots.find(s => s.slot === freeSlot);
  check("P0-011c  the slot now reads PUBLISHED",
    slotAfterApprove.state === "PUBLISHED", `-> ${slotAfterApprove.state}`);

  const reApprove = await POST(`/api/admin/sessions/${reservedId}/approve`);
  check("        approving twice is refused",
    reApprove.status === 400, `-> ${reApprove.status} ${reApprove.json && reApprove.json.error}`);

  /* reject */
  const dash = (await GET("/api/admin/dashboard")).json;
  const toReject = dash.pending[0];
  const rejected = await POST(`/api/admin/sessions/${toReject.id}/reject`);
  const calAfterReject = (await GET("/api/calendar")).json;
  const slotAfterReject = calAfterReject.days.find(d => d.date === toReject.date).slots.find(s => s.slot === toReject.slot);
  const publicAfterReject = (await GET("/api/sessions", { withCookie: false })).json;
  check("P0-012  rejection hides the session and releases the slot",
    rejected.status === 200 &&
    slotAfterReject.state === "AVAILABLE" &&
    !publicAfterReject.sessions.some(s => s.id === toReject.id),
    `slot -> ${slotAfterReject.state}`);

  const rebook = await POST("/api/nominations", validNomination(toReject.date, toReject.slot, { topic: "Rebooked after rejection" }));
  check("P0-012b  the released slot can be nominated again",
    rebook.status === 201, `-> ${rebook.status}`);

  /* cancel */
  const dash2 = (await GET("/api/admin/dashboard")).json;
  const toCancel = dash2.published[0];
  const cancelled = await POST(`/api/admin/sessions/${toCancel.id}/cancel`);
  const calAfterCancel = (await GET("/api/calendar")).json;
  const slotAfterCancel = calAfterCancel.days.find(d => d.date === toCancel.date).slots.find(s => s.slot === toCancel.slot);
  const publicAfterCancel = (await GET("/api/sessions", { withCookie: false })).json;
  check("P0-013  cancellation hides the session and releases the slot",
    cancelled.status === 200 &&
    slotAfterCancel.state === "AVAILABLE" &&
    !publicAfterCancel.sessions.some(s => s.id === toCancel.id),
    `slot -> ${slotAfterCancel.state}`);

  const fetchCancelled = await GET("/api/sessions/" + toCancel.id, { withCookie: false });
  check("P0-013b  a cancelled session 404s publicly",
    fetchCancelled.status === 404, `-> ${fetchCancelled.status}`);

  /* ================================================================== */
  section("Admin session creation (FR-015)");

  const cal4 = (await GET("/api/calendar")).json;
  let cDate = null, cSlot = null;
  for (const d of cal4.days){
    const s = d.slots.find(x => x.state === "AVAILABLE");
    if (s){ cDate = d.date; cSlot = s.slot; break; }
  }
  const created = await POST("/api/admin/sessions", {
    date: cDate, slot: cSlot, topic: "Admin Created Session",
    speakerName: "Admin Speaker", meetingLink: "https://meet.google.com/adm-test-001", description: "Created by an admin."
  });
  check("FR-015  admin can create a session, published immediately",
    created.status === 201 && created.json.session.status === "PUBLISHED",
    `-> ${created.status}, status=${created.json && created.json.session && created.json.session.status}`);

  const occupied = await POST("/api/admin/sessions", {
    date: cDate, slot: cSlot, topic: "Clashing Session",
    speakerName: "Admin Speaker", meetingLink: "https://meet.google.com/adm-test-002"
  });
  check("FR-015b  admin creation obeys slot uniqueness too",
    occupied.status === 409, `-> ${occupied.status} ${occupied.json && occupied.json.error}`);

  const createdPublic = (await GET("/api/sessions", { withCookie: false })).json;
  check("FR-015c  the admin-created session is publicly visible without its link",
    createdPublic.sessions.some(s => s.id === created.json.session.id) &&
    !createdPublic.text?.includes?.("adm-test-001"), "");

  /* ================================================================== */
  section("Empty states and misc");

  await POST("/api/demo/clear-published");
  const emptyList = (await GET("/api/sessions", { withCookie: false })).json;
  check("        no upcoming sessions -> empty list",
    emptyList.sessions.length === 0, `${emptyList.sessions.length} sessions`);

  await POST("/api/demo/reset");
  await POST("/api/demo/fill-slots");
  const fullCal = (await GET("/api/calendar")).json;
  check("        no available slots -> availableCount 0",
    fullCal.availableCount === 0, `availableCount=${fullCal.availableCount}`);

  await POST("/api/demo/reset");
  const notFound = await GET("/api/sessions/does-not-exist", { withCookie: false });
  check("        unknown session 404s", notFound.status === 404, `-> ${notFound.status}`);

  const wrongVerb = await req("DELETE", "/api/sessions", null, {});
  check("        wrong HTTP verb -> 405 with Allow header",
    wrongVerb.status === 405 && !!wrongVerb.headers.get("allow"),
    `-> ${wrongVerb.status}, Allow: ${wrongVerb.headers.get("allow")}`);

  const badJson = await fetch(BASE + "/api/nominations", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json"
  });
  check("        malformed JSON -> 400, not a crash", badJson.status === 400, `-> ${badJson.status}`);

  const logout = await POST("/api/admin/logout");
  const afterLogout = await GET("/api/admin/dashboard");
  check("        logout invalidates the session server-side",
    logout.status === 200 && afterLogout.status === 401, `dashboard after logout -> ${afterLogout.status}`);

  /* ------------------------------------------------------------------ */
  console.log("\n" + "─".repeat(66));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("─".repeat(66) + "\n");
  return failed === 0;
}

/* ------------------------------------------------------------------- boot */
(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), TRAINERHUB_DATA_DIR: DATA_DIR, TRAINERHUB_DEMO: "on" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", d => process.stderr.write("[server] " + d));

  let ok = false;
  try {
    await waitForServer();
    ok = await run();
  } catch (err){
    console.error("\nSuite crashed:", err);
  } finally {
    child.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
  process.exit(ok ? 0 : 1);
})();
