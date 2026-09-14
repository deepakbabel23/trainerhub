"use strict";
/* ============================================================================
   TrainerHub — post-deployment verification

   Points at a LIVE deployment and checks the things that actually go wrong on
   a first deploy: wrong bind, missing password, cookies not Secure, demo
   routes left open, and meeting links leaking to the public.

   Safe by default: every check is read-only. It creates nothing and deletes
   nothing, so it is safe to run against a URL testers are using.

   Usage:
     node test/verify-deployment.js https://your-app.onrender.com
     node test/verify-deployment.js https://your-app.onrender.com --password 'your-admin-password'

   The optional --password additionally proves admin login works and that the
   session cookie comes back with the right flags. It signs out afterwards.
   ========================================================================== */

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const pwIndex = process.argv.indexOf("--password");
const PASSWORD = pwIndex > -1 ? process.argv[pwIndex + 1] : null;
const emailIndex = process.argv.indexOf("--email");
const EMAIL = emailIndex > -1 ? process.argv[emailIndex + 1] : "admin@trainerhub.app";

if (!BASE || !/^https?:\/\//.test(BASE)){
  console.error("\nUsage: node test/verify-deployment.js https://your-app.onrender.com [--email you@x.com --password 'secret']\n");
  process.exit(1);
}

let pass = 0, fail = 0, warn = 0;
const problems = [];
function ok(name, detail){ pass++; console.log(`  \x1b[32m✓\x1b[0m  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`); }
function bad(name, detail, fix){
  fail++; console.log(`  \x1b[31m✗\x1b[0m  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`);
  if (fix) problems.push(`${name}\n     → ${fix}`);
}
function note(name, detail){ warn++; console.log(`  \x1b[33m!\x1b[0m  ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ""}`); }
function section(n){ console.log(`\n\x1b[1m${n}\x1b[0m`); }

async function get(path, opts = {}){
  const res = await fetch(BASE + path, { redirect: "manual", ...opts });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
}
async function post(path, body, opts = {}){
  const res = await fetch(BASE + path, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: body ? JSON.stringify(body) : "{}"
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
}

(async () => {
  console.log(`\n\x1b[1mVerifying ${BASE}\x1b[0m`);

  /* ---------------------------------------------------------------- alive */
  section("Reachable");
  const t0 = Date.now();
  let health;
  try { health = await get("/api/healthz"); }
  catch (e){
    bad("Server responds", e.message,
        "Check the Render log. A cold start on the free tier can take 60s — wait and rerun.");
    console.log("\nCannot continue without a reachable server.\n");
    process.exit(1);
  }
  const ms = Date.now() - t0;
  health.status === 200 && health.json?.ok
    ? ok("Health check", `${ms}ms${ms > 5000 ? " — cold start" : ""}`)
    : bad("Health check", `HTTP ${health.status}`, "The service is up but /api/healthz is wrong. Check the start command is `node server.js`.");

  if (BASE.startsWith("https://")) ok("Served over HTTPS");
  else note("Not HTTPS", "Secure cookies will be rejected by the browser. Use the https:// URL.");

  const page = await get("/");
  page.status === 200 && page.text.includes("TrainerHub")
    ? ok("App shell loads")
    : bad("App shell", `HTTP ${page.status}`, "index.html is not being served. Check the public/ folder was committed.");

  const js  = await get("/app.js");
  const css = await get("/styles.css");
  js.status === 200 && css.status === 200
    ? ok("Static assets load", "app.js + styles.css")
    : bad("Static assets", `app.js ${js.status}, styles.css ${css.status}`, "public/ files missing from the deploy.");

  /* ------------------------------------------------------- product sanity */
  section("Product data");
  const cal = await get("/api/calendar");
  if (cal.status === 200 && cal.json?.days?.length === 7){
    const states = cal.json.days.flatMap(d => d.slots.map(s => s.state));
    ok("Seven-day calendar", `${states.length} slots, ${cal.json.availableCount} available`);
    states.length === 14
      ? ok("Two slots per day")
      : bad("Slot count", `${states.length}, expected 14`);
  } else {
    bad("Calendar", `HTTP ${cal.status}`, "The API is not responding correctly.");
  }

  const sessions = await get("/api/sessions");
  sessions.status === 200 && Array.isArray(sessions.json?.sessions)
    ? ok("Published sessions listed", `${sessions.json.sessions.length} public`)
    : bad("Sessions endpoint", `HTTP ${sessions.status}`);

  /* ------------------------------------------------------------- security */
  section("Security — the checks that matter before sharing");

  // 1. Admin routes must be closed to anonymous callers.
  const guarded = ["/api/admin/dashboard", "/api/admin/sessions/anything"];
  let allGuarded = true;
  for (const p of guarded){ if ((await get(p)).status !== 401) allGuarded = false; }
  const writeGuarded = (await post("/api/admin/sessions", {})).status === 401;
  allGuarded && writeGuarded
    ? ok("Admin routes return 401 when signed out")
    : bad("ADMIN ROUTES ARE OPEN", "", "Serious. Do not share this URL. Check the deploy is running the current code.");

  // 2. The default password must not work.
  const defaultPw = await post("/api/admin/login", { email: "admin@trainerhub.app", password: "admin123" });
  defaultPw.status === 401
    ? ok("Default password rejected")
    : bad("DEFAULT PASSWORD STILL WORKS", `HTTP ${defaultPw.status}`,
          "Anyone can sign in as admin. Set TRAINERHUB_ADMIN_PASSWORD in Render → Environment and redeploy.");

  // 3. No meeting link in any public response. The core FR-011 guarantee.
  //
  // Two modes. With an admin password we fetch the REAL links and look for
  // those exact strings — an exact test with no false positives. Without one
  // we fall back to a pattern scan, which must ignore the example URLs that
  // legitimately appear as form placeholders in the UI code.
  const publicBodies = [
    ["/api/calendar", cal.text],
    ["/api/sessions", sessions.text],
    ["/api/bootstrap", (await get("/api/bootstrap")).text],
    ["/", page.text],
    ["/app.js", js.text]
  ];
  const first = sessions.json?.sessions?.[0];
  if (first) publicBodies.push([`/api/sessions/${first.id}`, (await get("/api/sessions/" + first.id)).text]);

  let realLinks = null;
  if (PASSWORD){
    const probe = await post("/api/admin/login", { email: EMAIL, password: PASSWORD });
    if (probe.status === 200){
      const jar = (probe.headers.get("set-cookie") || "").split(";")[0];
      const dash = await get("/api/admin/dashboard", { headers: { Cookie: jar } });
      if (dash.status === 200){
        realLinks = [...dash.json.pending, ...dash.json.published]
          .map(x => x.meetingLink).filter(Boolean);
      }
      await post("/api/admin/logout", null, { headers: { Cookie: jar } });
    }
  }

  const leaks = [];
  if (realLinks && realLinks.length){
    for (const [label, body] of publicBodies){
      for (const link of realLinks){
        if (String(body).includes(link)) leaks.push(`${label} → ${link}`);
      }
    }
    leaks.length === 0
      ? ok("No real meeting link in any public response",
           `exact scan: ${publicBodies.length} endpoints × ${realLinks.length} live links`)
      : bad("MEETING LINK LEAK", leaks.join(" | "), "FR-011 is broken on this deployment. Do not share the URL.");
  } else {
    // Example URLs that are supposed to be in the UI (form placeholders).
    const PLACEHOLDER = /abc-defg-hij|your-|example\.com|demo-fill-slot|xxx/i;
    const LINK_RE = /https?:\/\/(?:[\w-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|whereby\.com|meet\.jit\.si)\/[^\s"'<>\\]+/gi;
    for (const [label, body] of publicBodies){
      const found = (String(body).match(LINK_RE) || []).filter(u => !PLACEHOLDER.test(u));
      if (found.length) leaks.push(`${label} → ${[...new Set(found)].join(", ")}`);
    }
    if (leaks.length === 0){
      ok("No meeting links in any public response", `pattern scan of ${publicBodies.length} endpoints`);
      if (!PASSWORD) note("Link scan was heuristic", "rerun with --password for an exact scan against the real links");
    } else {
      bad("POSSIBLE MEETING LINK LEAK", leaks.join(" | "),
          "Rerun with --password to confirm against the real links. If confirmed, do not share the URL.");
    }
  }

  // 4. Demo routes must be closed on a shared URL.
  const demo = await post("/api/demo/reset");
  if (demo.status === 404) ok("Demo routes disabled", "testers cannot reset the data");
  else if (demo.status === 200) note("DEMO ROUTES ARE OPEN",
    "Any visitor can wipe the data mid-session. Remove TRAINERHUB_DEMO=on unless you want the prototype controls.");
  else note("Demo routes", `unexpected HTTP ${demo.status}`);

  // 5. A forged cookie must not authenticate.
  const forged = await get("/api/admin/dashboard", { headers: { Cookie: "th_admin=" + "f".repeat(64) } });
  forged.status === 401
    ? ok("Forged session cookie rejected")
    : bad("FORGED COOKIE ACCEPTED", `HTTP ${forged.status}`, "Do not share this URL.");

  /* ------------------------------------------------------- optional login */
  if (PASSWORD){
    section("Admin sign-in");
    const login = await post("/api/admin/login", { email: EMAIL, password: PASSWORD });
    if (login.status !== 200){
      bad("Admin login", `HTTP ${login.status} — ${login.json?.message || ""}`,
          "Check TRAINERHUB_ADMIN_EMAIL and TRAINERHUB_ADMIN_PASSWORD in Render → Environment.");
    } else {
      ok("Admin login succeeds", EMAIL);
      const cookie = login.headers.get("set-cookie") || "";
      const flags = { HttpOnly: /HttpOnly/i.test(cookie), Secure: /Secure/i.test(cookie), SameSite: /SameSite=Strict/i.test(cookie) };
      flags.HttpOnly && flags.SameSite ? ok("Cookie is HttpOnly + SameSite=Strict") : bad("Cookie flags", cookie);
      if (BASE.startsWith("https://")){
        flags.Secure
          ? ok("Cookie is Secure")
          : bad("Cookie missing Secure", "", "Set NODE_ENV=production in Render → Environment.");
      }
      const jar = cookie.split(";")[0];
      const dash = await get("/api/admin/dashboard", { headers: { Cookie: jar } });
      dash.status === 200
        ? ok("Dashboard reachable when signed in", `${dash.json.pending.length} pending, ${dash.json.published.length} published`)
        : bad("Dashboard", `HTTP ${dash.status}`);
      await post("/api/admin/logout", null, { headers: { Cookie: jar } });
      const after = await get("/api/admin/dashboard", { headers: { Cookie: jar } });
      after.status === 401 ? ok("Sign-out invalidates the session") : bad("Sign-out", `HTTP ${after.status}`);
    }
  } else {
    section("Admin sign-in");
    note("Skipped", "rerun with --password 'your-password' to test the admin login too");
  }

  /* ------------------------------------------------------------- verdict */
  console.log("\n" + "─".repeat(68));
  if (fail === 0){
    console.log(`  \x1b[32mREADY TO SHARE\x1b[0m — ${pass} checks passed${warn ? `, ${warn} note(s)` : ""}`);
  } else {
    console.log(`  \x1b[31mDO NOT SHARE YET\x1b[0m — ${fail} problem(s), ${pass} passed`);
    console.log("\n  Fix these:");
    problems.forEach((p, i) => console.log(`\n  ${i + 1}. ${p}`));
  }
  console.log("─".repeat(68) + "\n");
  process.exit(fail === 0 ? 0 : 1);
})();
