"use strict";
/* ============================================================================
   TrainerHub — client render test

   Loads the real public/app.js inside a minimal DOM shim and points its fetch
   at a real running server, then walks every route and inspects the HTML the
   views actually produce. This catches the failure the API suite cannot: a
   view reading a field the serialiser does not send.

   Run:  node test/ui-render.js
   ========================================================================== */

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

const PORT = Number(process.env.TEST_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trainerhub-ui-"));

let passed = 0, failed = 0;
function check(name, cond, detail){
  cond ? passed++ : failed++;
  console.log(`  ${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? "\n          " + detail : ""}`);
}
function section(n){ console.log(`\n\x1b[1m${n}\x1b[0m`); }

/* --------------------------------------------------------------- DOM shim */
function makeEl(id){
  return {
    id, innerHTML: "", hidden: false, className: "", disabled: false,
    _attrs: {},
    setAttribute(k, v){ this._attrs[k] = v; },
    getAttribute(k){ return this._attrs[k] ?? null; },
    querySelector(){ return null; },
    querySelectorAll(){ return []; },
    focus(){}, click(){}
  };
}

function buildSandbox(cookieJar){
  const els = { app: makeEl("app"), proto: makeEl("proto"), netbar: makeEl("netbar"), main: makeEl("main") };
  const listeners = {};
  const loc = { hash: "#/" };

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, JSON, Date, Math, String, Number, Boolean, Array, Object, RegExp, Error, Promise,
    navigator: { clipboard: { writeText: async () => {} } },
    location: loc,
    confirm: () => true,
    document: {
      getElementById: id => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      createElement: () => makeEl("tmp"),
      body: makeEl("body")
    },
    window: {
      scrollTo(){},
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }
    },
    // Route the client's fetch at the real server, carrying cookies so the
    // admin views exercise a genuine authenticated session.
    async fetch(url, opts = {}){
      const full = url.startsWith("http") ? url : BASE + url;
      const headers = { ...(opts.headers || {}) };
      if (cookieJar.value) headers.Cookie = cookieJar.value;
      const res = await globalThis.fetch(full, { ...opts, headers });
      const sc = res.headers.get("set-cookie");
      if (sc) cookieJar.value = sc.split(";")[0];
      return res;
    }
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return { sandbox, els, loc, listeners };
}

async function loadApp(cookieJar){
  const code = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const ctx = buildSandbox(cookieJar);
  vm.createContext(ctx.sandbox);
  vm.runInContext(code, ctx.sandbox, { filename: "app.js" });
  // Top-level const/let live in the context's lexical scope, not on the global
  // object, so reach them by evaluating an expression in the same context.
  ctx.evalIn = expr => vm.runInContext(expr, ctx.sandbox);
  await new Promise(r => setTimeout(r, 250));   // let boot() finish
  return ctx;
}

/* The shim has no real hashchange event, so after firing a handler that
   navigates via go(), render explicitly and let it settle. */
async function settle(ctx, ms = 260){
  await new Promise(r => setTimeout(r, ms));
  await ctx.sandbox.render();
  await new Promise(r => setTimeout(r, 160));
  return ctx.els.app.innerHTML;
}

/** Navigate the shimmed client and return the rendered HTML. */
async function visit(ctx, hash){
  ctx.loc.hash = hash;
  await ctx.sandbox.render();
  // give any chained go()/render() a chance to settle
  await new Promise(r => setTimeout(r, 120));
  return ctx.els.app.innerHTML;
}

const has = (html, ...needles) => needles.every(n => html.includes(n));

/* ------------------------------------------------------------------- main */
async function run(){
  const cookieJar = { value: "" };
  await globalThis.fetch(BASE + "/api/demo/reset", { method: "POST" });

  const ctx = await loadApp(cookieJar);

  section("Public screens render from live API data");

  const landing = await visit(ctx, "#/");
  check("SCREEN-01 landing",
    has(landing, "Learn something.", "Teach something.", "Upcoming Sessions", "Become a Speaker", "Three steps"),
    `${landing.length} bytes`);
  check("SCREEN-01 shows a live availability count",
    /\d+ slots? open in the next seven days|No slots open/.test(landing),
    (landing.match(/\d+ slots? open in the next seven days/) || ["(none)"])[0]);

  const slots = await visit(ctx, "#/speaker");
  check("SCREEN-02 slot calendar renders 7 days",
    (slots.match(/class="day"/g) || []).length === 7,
    `${(slots.match(/class="day"/g) || []).length} day columns`);
  check("SCREEN-02 renders 14 slots",
    (slots.match(/class="slot /g) || []).length === 14,
    `${(slots.match(/class="slot /g) || []).length} slot cards`);
  check("SCREEN-02 states carry text labels, not colour alone",
    has(slots, ">Available<", ">Reserved<", ">Published<"),
    "accessibility requirement from SPEC §8");
  check("SCREEN-02 available slots are buttons, others are not",
    slots.includes('data-act="pick"') && slots.includes("slot-reserved") && !slots.includes('class="slot slot-reserved" data-act'),
    "");

  const sessions = await visit(ctx, "#/sessions");
  check("SCREEN-07 upcoming sessions list",
    has(sessions, "Upcoming sessions", "View details &amp; join"),
    `${(sessions.match(/class="card sess"/g) || []).length} session cards`);

  const list = await (await globalThis.fetch(BASE + "/api/sessions")).json();
  const first = list.sessions[0];
  const detail = await visit(ctx, "#/sessions/" + first.id);
  check("SCREEN-08 session detail",
    has(detail, first.topic, first.speakerName, "Join session"), "");
  check("SCREEN-08 renders NO meeting link",
    !detail.includes("meet.google.com") && !detail.includes("zoom.us") && !detail.includes("teams.microsoft"),
    "P0-008 at the rendered-DOM level");

  const register = await visit(ctx, `#/sessions/${first.id}/register`);
  check("SCREEN-09 registration form",
    has(register, "Join this session", 'id="f-register"', "Get meeting link"), "");
  check("SCREEN-09 renders NO meeting link",
    !register.includes("meet.google.com") && !register.includes("zoom.us"), "");

  section("Participant registration reveals the link");

  // Drive the real submit handler through the shim.
  const submitHandlers = ctx.listeners.submit || [];
  const fakeForm = {
    id: "f-register",
    getAttribute: k => (k === "data-id" ? first.id : null),
    participantName: { value: "Anita Rao" },
    querySelector: () => makeEl("btn")
  };
  await submitHandlers[0]({ target: fakeForm, preventDefault(){} });
  const success = await settle(ctx);
  check("SCREEN-10 success screen shows the link",
    has(success, "registered!", "Anita Rao", "Your meeting link") &&
    /https:\/\/(meet\.google\.com|us02web\.zoom\.us|teams\.microsoft\.com)/.test(success),
    "the link appears only here, and only after registering");

  section("Speaker nomination flow");

  const cal = await (await globalThis.fetch(BASE + "/api/calendar")).json();
  let fd = null, fs_ = null;
  for (const d of cal.days){
    const s = d.slots.find(x => x.state === "AVAILABLE");
    if (s){ fd = d.date; fs_ = s.slot; break; }
  }
  // Simulate picking a slot, as the click handler does.
  const UIref = ctx.evalIn("UI");
  UIref.draft = {
    date: fd, slot: fs_, slotLabel: fs_ === "11:00" ? "11:00 AM" : "7:00 PM",
    topic: "", description: "", meetingLink: "", speakerName: "", speakerPhone: "", speakerEmail: ""
  };
  const form1 = await visit(ctx, "#/speaker/session");
  check("SCREEN-03 session form, prefilled with the chosen slot",
    has(form1, 'id="f-session"', "Session details", fs_ === "11:00" ? "11:00 AM" : "7:00 PM"), "");

  Object.assign(UIref.draft, {
    topic: "AI for Small Business", description: "Automating quotes and follow-ups.",
    meetingLink: "https://meet.google.com/ui-test-001"
  });
  const form2 = await visit(ctx, "#/speaker/details");
  check("SCREEN-04 speaker form", has(form2, 'id="f-speaker"', "Full name", "Phone number", "(optional)"), "");

  Object.assign(UIref.draft, {
    speakerName: "Deepak Babel", speakerPhone: "+91 98200 11223", speakerEmail: "deepak@example.com"
  });
  const review = await visit(ctx, "#/speaker/review");
  check("SCREEN-05 review shows every field",
    has(review, "Review your nomination", "AI for Small Business", "Deepak Babel", "not public yet", "Submit nomination"), "");

  // Fire the real submit-nomination click handler.
  const clickHandlers = ctx.listeners.click || [];
  const btn = { getAttribute: k => (k === "data-act" ? "submit-nomination" : null),
                setAttribute(){}, closest(){ return btn; }, querySelector: () => null, disabled: false };
  await clickHandlers[0]({ target: { closest: () => btn } });
  const confirmed = await settle(ctx);
  check("SCREEN-06 confirmation after a real POST",
    has(confirmed, "Your slot is reserved.", "submitted for approval", "not public yet", "Deepak Babel"), "");
  check("SCREEN-06 shows RESERVED, never PUBLISHED",
    confirmed.includes(">Reserved<") && !confirmed.includes(">Published<"), "P0-006");

  const newId = UIref.lastNominationId;
  check("        the nomination really exists on the server",
    !!newId && (await globalThis.fetch(BASE + "/api/nominations/" + newId)).ok, `id=${newId}`);

  section("Admin screens");

  const loginScreen = await visit(ctx, "#/admin");
  check("SCREEN-11 unauthenticated admin route renders the login screen",
    has(loginScreen, 'id="f-admin"', "Sign in") && !loginScreen.includes("Session management"),
    "P0-010 at the UI level");

  await globalThis.fetch(BASE + "/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@trainerhub.app", password: "admin123" })
  }).then(r => { cookieJar.value = (r.headers.get("set-cookie") || "").split(";")[0]; });

  const dashboard = await visit(ctx, "#/admin");
  check("SCREEN-12 dashboard renders pending and published tables",
    has(dashboard, "Session management", "Pending nominations", "Published sessions", "Create session", "Sign out"),
    "");

  const dash = await (await globalThis.fetch(BASE + "/api/admin/dashboard", { headers: { Cookie: cookieJar.value } })).json();
  const reviewScreen = await visit(ctx, "#/admin/review/" + dash.pending[0].id);
  check("SCREEN-13 review shows the full nomination including the link",
    has(reviewScreen, "Review nomination", "Approve &amp; publish", "Reject nomination", dash.pending[0].meetingLink),
    "admins are entitled to see it");

  const manageScreen = await visit(ctx, "#/admin/manage/" + dash.published[0].id);
  check("SCREEN-14 manage shows cancel and the registration count",
    has(manageScreen, "Manage session", "Cancel session", "Registrations"), "");

  const createScreen = await visit(ctx, "#/admin/create");
  check("SCREEN-15 create form lists the 7 window dates and both slots",
    (createScreen.match(/<option value="\d{4}-\d{2}-\d{2}"/g) || []).length === 7 &&
    createScreen.includes('value="11:00"') && createScreen.includes('value="19:00"'),
    `${(createScreen.match(/<option value="\d{4}-\d{2}-\d{2}"/g) || []).length} date options`);

  section("Empty states");

  await globalThis.fetch(BASE + "/api/demo/clear-published", { method: "POST" });
  const emptySessions = await visit(ctx, "#/sessions");
  check("        no upcoming sessions",
    emptySessions.includes("There are no upcoming sessions yet."), "");

  await globalThis.fetch(BASE + "/api/demo/reset", { method: "POST" });
  await globalThis.fetch(BASE + "/api/demo/fill-slots", { method: "POST" });
  const fullSlots = await visit(ctx, "#/speaker");
  check("        no available slots",
    fullSlots.includes("No speaker slots are currently available in the next seven days."), "");

  await globalThis.fetch(BASE + "/api/demo/reset", { method: "POST" });

  console.log("\n" + "─".repeat(66));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("─".repeat(66) + "\n");
  return failed === 0;
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), TRAINERHUB_DATA_DIR: DATA_DIR, TRAINERHUB_DEMO: "on" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.on("data", d => process.stderr.write("[server] " + d));

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline){
    try { const r = await fetch(BASE + "/api/calendar"); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 120));
  }

  let ok = false;
  try { ok = await run(); }
  catch (err){ console.error("\nSuite crashed:", err); }
  finally {
    child.kill();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
  process.exit(ok ? 0 : 1);
})();
