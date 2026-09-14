"use strict";
/* ============================================================================
   TrainerHub — client (Phase 2)

   The same screens as Phase 1, but this file holds NO product truth. Slot
   states, lifecycle transitions, validation and authorisation all live on the
   server; this is a renderer plus a form-UX layer.

   In particular it never has the meeting link until the server returns it in
   response to a participant's own registration.
   ========================================================================== */

/* ------------------------------------------------------------------ helpers */
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
const DAYS  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTH = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function parseISO(s){ const p = String(s).split("-"); return new Date(+p[0], +p[1]-1, +p[2]); }
function fmtLong(d){ const x = parseISO(d); return `${x.getDate()} ${MONTH[x.getMonth()]} ${x.getFullYear()}`; }
function fmtDayFull(d){ return `${DAYS[parseISO(d).getDay()]}, ${fmtLong(d)}`; }
function fmtShort(d){ const x = parseISO(d); return `${DAYS[x.getDay()].slice(0,3)} ${MONTH[x.getMonth()].slice(0,3)} ${x.getDate()}`; }
function initials(n){
  const p = String(n || "").trim().split(/\s+/);
  return ((p[0] || "")[0] || "").toUpperCase() + ((p[1] || "")[0] || "").toUpperCase();
}

/* ---------------------------------------------------------------- API client */
const API = {
  async call(method, path, body){
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin"
      });
    } catch {
      // Network failure. Never let this look like success.
      throw { code: "NETWORK", message: "We couldn't reach the server. Check your connection and try again.", status: 0 };
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok){
      throw { code: data.error || "ERROR", message: data.message || "Something went wrong.",
              errors: data.errors || null, status: res.status, slotState: data.slotState };
    }
    return data;
  },
  get:  (p)    => API.call("GET",  p),
  post: (p, b) => API.call("POST", p, b)
};

/* --------------------------------------------------------------- view state */
/* Ephemeral UI state only — never product state. */
const UI = {
  draft: null,            // the nomination being composed
  errors: {},             // field errors from the last submit
  flash: null,            // one-shot banner
  admin: null,            // { email } when signed in, per the server
  lastNominationId: null,
  registration: null,     // { participantName, session } after registering
  demoRoutes: true,
  busy: false
};
let protoOpen = false;

function setFlash(kind, icon, title, text){ UI.flash = { kind, icon, title, text }; }
function takeFlash(){ const f = UI.flash; UI.flash = null; return f ? alertBox(f.kind, I[f.icon] || I.check, f.title, f.text) : ""; }

/* -------------------------------------------------------------------- icons */
const I = {
  check:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
  clock:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>',
  globe:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8a2 2 0 004 0 2 2 0 011.523-1.943A5.977 5.977 0 0116 10c0 .34-.028.675-.083 1H15a2 2 0 00-2 2v2.197A5.973 5.973 0 0110 16v-2a2 2 0 00-2-2 2 2 0 01-2-2 2 2 0 00-1.668-1.973z" clip-rule="evenodd"/></svg>',
  ban:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M13.477 14.89A6 6 0 015.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367zM18 10a8 8 0 11-16 0 8 8 0 0116 0z" clip-rule="evenodd"/></svg>',
  alert:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>',
  lock:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg>',
  cal:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 011 1v1h6V3a1 1 0 112 0v1h1a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h1V3a1 1 0 011-1zm11 6H3v8h14V8z" clip-rule="evenodd"/></svg>',
  arrow:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>',
  back:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>',
  inbox:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.5 6a1 1 0 01.9.55l.4.9a1 1 0 00.9.55h4.6a1 1 0 00.9-.55l.4-.9a1 1 0 01.9-.55H16V5H4v6h1.5z" clip-rule="evenodd"/></svg>',
  user:'<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>',
  copy:'<svg viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h6a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V3z"/><path d="M4 6a1 1 0 011-1h1v8a2 2 0 002 2h5v1a1 1 0 01-1 1H5a1 1 0 01-1-1V6z"/></svg>'
};
function badge(state){
  const m = {
    AVAILABLE: ["b-available", I.check, "Available"],
    RESERVED:  ["b-reserved",  I.clock, "Reserved"],
    PUBLISHED: ["b-published", I.globe, "Published"],
    PASSED:    ["b-passed",    I.ban,   "Passed"],
    REJECTED:  ["b-passed",    I.ban,   "Rejected"],
    CANCELLED: ["b-passed",    I.ban,   "Cancelled"]
  }[state] || ["b-passed", I.ban, state];
  return `<span class="badge ${m[0]}">${m[1]}${m[2]}</span>`;
}
function alertBox(kind, icon, title, text){
  return `<div class="alert alert-${kind}" role="alert">${icon}<div><b>${esc(title)}</b>${text ? "<br>" + esc(text) : ""}</div></div>`;
}

/* ------------------------------------------------------------------- chrome */
function header(active){
  return `<header class="top"><div class="wrap top-in">
    <a class="brand" href="#/"><span class="mark">T</span>TrainerHub</a>
    <nav class="main" aria-label="Primary">
      <a href="#/sessions"${active === "sessions" ? ' aria-current="page"' : ""}>Upcoming Sessions</a>
      <a href="#/speaker"${active === "speaker" ? ' aria-current="page"' : ""}>Become a Speaker</a>
    </nav>
    <a class="admin-link" href="#/admin"><span class="dot" aria-hidden="true"></span>Admin Portal</a>
  </div></header>`;
}
function footer(){
  return `<footer class="bot"><div class="wrap bot-in">
    <div><div class="l">Learn something. Teach something.</div>
    <div class="small muted">Two speaker slots every day. Seven days ahead.</div></div>
    <nav aria-label="Footer"><a href="#/sessions">Upcoming Sessions</a>
    <a href="#/speaker">Become a Speaker</a><a href="#/admin">Admin Console</a></nav>
  </div></footer>`;
}
const page       = (a, b) => header(a) + `<main id="main"><div class="wrap">${b}</div></main>` + footer();
const pageNarrow = (a, b) => header(a) + `<main id="main"><div class="wrap-narrow">${b}</div></main>` + footer();

function adminShell(body, narrow){
  return header("admin")
    + `<div class="admin-bar"><div class="wrap in">
         <span class="t">TrainerHub · Admin console${UI.admin ? " · " + esc(UI.admin.email) : ""}</span>
         <button data-act="admin-logout">Sign out</button></div></div>`
    + `<main id="main"><div class="${narrow ? "wrap-narrow" : "wrap"}">${body}</div></main>` + footer();
}
function stepper(n){
  const names = ["Choose Slot","Session Details","Speaker Details","Review"];
  let out = '<nav class="steps" aria-label="Nomination progress">';
  for (let i = 0; i < 4; i++){
    const cls = i + 1 === n ? "step on" : (i + 1 < n ? "step done" : "step");
    out += `<span class="${cls}"${i + 1 === n ? ' aria-current="step"' : ""}>
              <span class="n">${i + 1}</span><span class="lbl">${names[i]}</span></span>`;
    if (i < 3) out += '<span class="step-sep" aria-hidden="true">›</span>';
  }
  return out + "</nav>";
}
const backLink = (href, label) =>
  `<a class="linkbtn" href="${href}" style="margin-bottom:16px">${I.back}${esc(label)}</a>`;
const row = (k, v) => `<div class="row"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;

function field(name, label, required, type, placeholder, value, error, hint){
  const id = "f-" + name;
  let out = `<div class="field"><label for="${id}">${esc(label)} ` +
    (required ? '<span class="req" aria-hidden="true">*</span><span class="sr">required</span>'
              : '<span class="optional">(optional)</span>') + "</label>" +
    (hint ? `<p class="hint" id="${id}-hint">${esc(hint)}</p>` : "");
  const aria = ` aria-describedby="${hint ? id + "-hint " : ""}${error ? id + "-err" : ""}"` +
               (error ? ' aria-invalid="true"' : "") + (required ? ' aria-required="true"' : "");
  out += type === "textarea"
    ? `<textarea class="textarea${error ? " err" : ""}" id="${id}" name="${name}" placeholder="${esc(placeholder)}"${aria}>${esc(value || "")}</textarea>`
    : `<input class="input${error ? " err" : ""}" id="${id}" name="${name}" type="text" placeholder="${esc(placeholder)}" value="${esc(value || "")}"${aria}>`;
  if (error) out += `<p class="errmsg" id="${id}-err">${I.alert}${esc(error)}</p>`;
  return out + "</div>";
}

/* ============================================================ SCREEN-01 */
async function viewLanding(){
  const { calendar } = await API.get("/api/bootstrap");
  const avail = calendar.availableCount;
  return page("home", `
    <section class="hero">
      <h1 class="h-hero">Learn something.<br><span class="b">Teach something.</span></h1>
      <p class="lead" style="max-width:620px;margin:18px auto 0">TrainerHub is a public portal for peer-led training.
      Claim one of two daily speaker slots to run a session, or browse approved sessions and join one.</p>
      <div class="cta">
        <a class="btn btn-primary" href="#/sessions">${I.cal}Upcoming Sessions</a>
        <a class="btn btn-secondary" href="#/speaker">${I.user}Become a Speaker</a>
      </div>
      <div class="rule-note">
        <span class="pill">${I.clock}Two slots daily · 11:00 AM and 7:00 PM</span>
        <span class="pill">${I.cal}Book up to 7 days ahead</span>
        <span class="pill">${I.check}No account needed</span>
      </div>
    </section>
    <section aria-labelledby="how-h" style="margin-top:16px">
      <div style="text-align:center;margin-bottom:22px">
        <p class="eyebrow">How it works</p>
        <h2 class="h-lg" id="how-h" style="margin-top:6px">Three steps, start to finish</h2>
      </div>
      <div class="how">
        <div class="card card-p"><div class="n">01</div>
          <h3 class="h-sm">Pick an open slot</h3>
          <p class="small muted" style="margin-top:8px">Every day has exactly two slots: 11:00 AM and 7:00 PM.
          Choose any slot marked Available in the next seven days and submit your topic. Submitting reserves
          that slot immediately, so nobody else can take it.</p></div>
        <div class="card card-p"><div class="n">02</div>
          <h3 class="h-sm">An administrator reviews it</h3>
          <p class="small muted" style="margin-top:8px">Your slot stays reserved while your nomination is reviewed.
          If it is approved the session is published publicly. If it is rejected the slot opens up again.</p></div>
        <div class="card card-p"><div class="n">03</div>
          <h3 class="h-sm">Participants join by name</h3>
          <p class="small muted" style="margin-top:8px">Published sessions are listed publicly with the topic,
          speaker, date and time. The meeting link stays hidden until a participant enters their full name.</p></div>
      </div>
    </section>
    <section class="card card-p" style="margin-top:32px;display:flex;gap:20px;justify-content:space-between;align-items:center;flex-wrap:wrap">
      <div><h3 class="h-sm">${avail > 0 ? `${avail} slot${avail === 1 ? "" : "s"} open in the next seven days` : "No slots open in the next seven days"}</h3>
      <p class="small muted" style="margin-top:4px">Availability is read live from the server.</p></div>
      <a class="btn btn-primary" href="#/speaker">View slot calendar${I.arrow}</a>
    </section>`);
}

/* ============================================================ SCREEN-02 */
async function viewSpeakerSlots(){
  const cal = await API.get("/api/calendar");
  const flash = takeFlash();

  const grid = cal.days.map((day, i) => {
    const label = i === 0 ? "Today" : (i === 1 ? "Tomorrow" : "Day " + (i + 1));
    const slots = day.slots.map(sl => {
      if (sl.state === "AVAILABLE"){
        return `<button type="button" class="slot slot-available"
                  data-act="pick" data-date="${day.date}" data-slot="${sl.slot}"
                  aria-label="Nominate the ${sl.label} slot on ${esc(fmtDayFull(day.date))}. Available.">
                  <span class="t">${sl.label}</span>${badge("AVAILABLE")}
                  <span class="cue">Click to nominate${I.arrow}</span></button>`;
      }
      if (sl.state === "PASSED"){
        return `<div class="slot slot-passed"><span class="t">${sl.label}</span>${badge("PASSED")}
                  <span class="sub" style="margin-top:auto">This time has already passed</span></div>`;
      }
      return `<div class="slot slot-${sl.state.toLowerCase()}"><span class="t">${sl.label}</span>${badge(sl.state)}
                <span class="sub" title="${esc(sl.topic || "")}" style="margin-top:auto">${esc(sl.topic || "")}</span></div>`;
    }).join("");
    return `<div class="day"><div class="day-h"><div class="k">${label}</div>
              <div class="d">${esc(fmtShort(day.date))}</div></div>
            <div class="day-b">${slots}</div></div>`;
  }).join("");

  let body = stepper(1) + flash + `
    <div style="margin-bottom:22px">
      <p class="eyebrow">Become a speaker</p>
      <h1 class="h-lg" style="margin-top:6px">Choose your slot</h1>
      <p class="lead" style="margin-top:8px">Two slots are available each day. Pick any slot marked
      <strong>Available</strong> in the next seven days. Submitting your nomination reserves it immediately.</p>
    </div>
    <div class="legend"><span class="legend-t">Status</span>
      <span class="legend-i">${badge("AVAILABLE")} You can nominate this slot</span>
      <span class="legend-i">${badge("RESERVED")} Nominated, awaiting approval</span>
      <span class="legend-i">${badge("PUBLISHED")} Approved and public</span>
      <span class="legend-i">${badge("PASSED")} Time has passed</span>
    </div>`;

  if (cal.availableCount === 0){
    body += `<div class="empty"><div class="i">${I.cal}</div>
      <h2 class="h-sm">No speaker slots are currently available in the next seven days.</h2>
      <p class="small muted" style="margin-top:6px">Every slot in the booking window is already reserved,
      published or passed. Check back tomorrow, when a new day enters the window.</p></div>
      <div style="margin-top:18px"><div class="day-grid">${grid}</div></div>`;
  } else {
    body += `<div class="day-grid">${grid}</div>`;
  }
  return page("speaker", body);
}

/* ====================================================== SCREEN-03 / 04 / 05 */
function viewSessionForm(){
  const d = UI.draft;
  if (!d) { go("#/speaker"); return ""; }
  const e = UI.errors || {};
  return pageNarrow("speaker", stepper(2) + backLink("#/speaker", "Back to slot calendar") + `
    <div class="panel">
      <h1 class="h-md">Session details</h1>
      <p class="muted small" style="margin:8px 0 4px">You are nominating the
      <strong>${esc(d.slotLabel)}</strong> slot on <strong>${esc(fmtDayFull(d.date))}</strong>.</p>
      <hr style="border:0;border-top:1px solid var(--border);margin:22px 0">
      <form id="f-session" novalidate>
        ${field("topic", "Session topic", true, "input", "e.g. AI for Small Business", d.topic, e.topic,
                "What will you teach? Keep it short and specific.")}
        ${field("meetingLink", "Meeting link", true, "input", "https://meet.google.com/abc-defg-hij", d.meetingLink, e.meetingLink,
                "Paste the Zoom, Google Meet or Teams link. The server keeps it hidden from the public until a participant registers.")}
        ${field("description", "Session description", false, "textarea", "What will participants learn, and who is it for?", d.description, e.description,
                "Shown on the public session page once your nomination is approved.")}
        <button class="btn btn-primary btn-block" type="submit">Continue to speaker details${I.arrow}</button>
      </form>
    </div>`);
}

function viewSpeakerForm(){
  const d = UI.draft;
  if (!d || !d.topic) { go("#/speaker"); return ""; }
  const e = UI.errors || {};
  return pageNarrow("speaker", stepper(3) + backLink("#/speaker/session", "Back to session details") + `
    <div class="panel">
      <h1 class="h-md">Your details</h1>
      <p class="muted small" style="margin-top:8px">No account and no password. We only ask for what is needed to
      attribute the session and reach you about the nomination.</p>
      <hr style="border:0;border-top:1px solid var(--border);margin:22px 0">
      <form id="f-speaker" novalidate>
        ${field("speakerName", "Full name", true, "input", "e.g. Deepak Babel", d.speakerName, e.speakerName, "")}
        ${field("speakerPhone", "Phone number", true, "input", "e.g. +91 98200 11223", d.speakerPhone, e.speakerPhone, "")}
        ${field("speakerEmail", "Email", false, "input", "e.g. you@example.com", d.speakerEmail, e.speakerEmail, "")}
        <button class="btn btn-primary btn-block" type="submit">Review nomination${I.arrow}</button>
      </form>
    </div>`);
}

function viewReview(){
  const d = UI.draft;
  if (!d || !d.speakerName) { go("#/speaker"); return ""; }
  const flash = takeFlash();
  return pageNarrow("speaker", stepper(4) + backLink("#/speaker/details", "Back to your details") + flash + `
    <div class="panel">
      <h1 class="h-md">Review your nomination</h1>
      <p class="muted small" style="margin:8px 0 22px">Check everything below. Submitting will reserve this slot immediately.</p>
      <p class="eyebrow" style="color:var(--ink-3);margin-bottom:10px">Session</p>
      <div class="rows" style="margin-bottom:22px">
        ${row("Date", fmtLong(d.date))}${row("Time", d.slotLabel)}${row("Topic", d.topic)}
        ${row("Description", d.description || "— not provided —")}${row("Meeting link", d.meetingLink)}
      </div>
      <p class="eyebrow" style="color:var(--ink-3);margin-bottom:10px">Speaker</p>
      <div class="rows" style="margin-bottom:22px">
        ${row("Full name", d.speakerName)}${row("Phone", d.speakerPhone)}
        ${row("Email", d.speakerEmail || "— not provided —")}
      </div>
      <div class="alert alert-warn" style="margin-bottom:22px">${I.clock}
        <div>Submitting reserves this slot straight away, but the session is <b>not public yet</b>.
        An administrator still has to approve it.</div></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="submit-nomination" style="flex:1;min-width:220px">Submit nomination</button>
        <a class="btn btn-secondary" href="#/speaker/session">Edit details</a>
      </div>
    </div>`);
}

/* ============================================================ SCREEN-06 */
async function viewConfirmation(){
  if (!UI.lastNominationId){ go("#/speaker"); return ""; }
  const { session: s } = await API.get("/api/nominations/" + UI.lastNominationId);
  const stillReserved = s.status === "RESERVED";
  return pageNarrow("speaker", `
    <div class="panel" style="text-align:center">
      <div style="width:56px;height:56px;border-radius:var(--r-full);background:var(--resv-bg);border:1px solid var(--resv-bd);color:var(--resv-ic);display:grid;place-items:center;margin:0 auto 18px">
        <span class="big-ic">${I.clock}</span></div>
      <h1 class="h-lg">Your slot is reserved.</h1>
      <p class="lead" style="margin-top:10px">Your session has been submitted for approval.</p>
      <div style="margin:22px 0 8px">${badge(s.status)}
        <span class="small muted" style="display:block;margin-top:8px">${
          stillReserved ? "Reserved · awaiting administrator approval"
                        : "An administrator has since updated this nomination."}</span></div>
      <div class="rows" style="text-align:left;margin:22px 0">
        ${row("Date", fmtDayFull(s.date))}${row("Time", s.slotLabel)}
        ${row("Topic", s.topic)}${row("Speaker", s.speakerName)}
        ${row("Status", stillReserved ? "Reserved — awaiting approval" : s.status)}
      </div>
      <div class="alert alert-warn" style="text-align:left">${I.alert}
        <div><b>This session is not public yet.</b><br>Your slot is held while an administrator reviews the
        nomination. It will appear on Upcoming Sessions only after it is approved. If it is rejected, the slot
        becomes available again.</div></div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:6px">
        <a class="btn btn-secondary" href="#/speaker">Back to slot calendar</a>
        <a class="btn btn-primary" href="#/sessions">See upcoming sessions</a>
      </div></div>`);
}

/* ============================================================ SCREEN-07 */
async function viewSessions(){
  const { sessions } = await API.get("/api/sessions");
  let body = `<div style="margin-bottom:24px">
    <p class="eyebrow">For participants</p>
    <h1 class="h-lg" style="margin-top:6px">Upcoming sessions</h1>
    <p class="lead" style="margin-top:8px">Approved, publicly scheduled sessions. Registration takes your name and nothing else.</p>
  </div>`;

  if (!sessions.length){
    return page("sessions", body + `<div class="empty"><div class="i">${I.cal}</div>
      <h2 class="h-sm">There are no upcoming sessions yet.</h2>
      <p class="small muted" style="margin-top:6px">Sessions appear here once an administrator approves a speaker nomination.</p>
      <a class="btn btn-secondary btn-sm" href="#/speaker" style="margin-top:16px">Become a speaker</a></div>`);
  }
  body += `<div class="sess-grid">` + sessions.map(s => `
    <article class="card sess">
      <div class="when">${I.cal}${esc(fmtShort(s.date))} · ${esc(s.slotLabel)}</div>
      <h2 class="h-sm">${esc(s.topic)}</h2>
      <div class="by"><span class="avatar" aria-hidden="true">${esc(initials(s.speakerName))}</span>${esc(s.speakerName)}</div>
      ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ""}
      <div style="margin-top:auto;padding-top:6px">
        <a class="btn btn-secondary btn-sm btn-block" href="#/sessions/${s.id}">View details &amp; join</a></div>
    </article>`).join("") + `</div>`;
  return page("sessions", body);
}

/* ============================================================ SCREEN-08 */
/* The server does not send a meeting link to this route, so there is nothing
   here to hide — the privacy guarantee is structural, not cosmetic. */
async function viewSessionDetail(id){
  let s;
  try { ({ session: s } = await API.get("/api/sessions/" + id)); }
  catch (err){
    if (err.status === 404){
      return page("sessions", `<div class="empty"><div class="i">${I.ban}</div>
        <h2 class="h-sm">This session is no longer available.</h2>
        <p class="small muted" style="margin-top:6px">${esc(err.message)}</p>
        <a class="btn btn-secondary btn-sm" href="#/sessions" style="margin-top:16px">Back to upcoming sessions</a></div>`);
    }
    throw err;
  }
  return pageNarrow("sessions", backLink("#/sessions", "Back to upcoming sessions") + `
    <div class="panel">
      ${badge("PUBLISHED")}
      <h1 class="h-lg" style="margin-top:14px">${esc(s.topic)}</h1>
      <div class="by" style="margin-top:14px"><span class="avatar" aria-hidden="true">${esc(initials(s.speakerName))}</span>
        <span><span class="tiny muted" style="display:block;text-transform:uppercase;letter-spacing:.06em;font-weight:700">Speaker</span>
        <strong>${esc(s.speakerName)}</strong></span></div>
      <div class="rows" style="margin:22px 0">${row("Date", fmtDayFull(s.date))}${row("Time", s.slotLabel)}</div>
      ${s.description ? `<p class="eyebrow" style="color:var(--ink-3)">About this session</p><p style="margin-top:8px">${esc(s.description)}</p>` : ""}
      <div class="lock" style="margin:22px 0">${I.lock}
        <div>The meeting link is not sent to this page at all. Register with your full name and the server will release it to you.</div></div>
      <a class="btn btn-primary btn-block" href="#/sessions/${s.id}/register">Join session${I.arrow}</a>
    </div>`);
}

/* ============================================================ SCREEN-09 */
async function viewRegister(id){
  let s;
  try { ({ session: s } = await API.get("/api/sessions/" + id)); }
  catch { go("#/sessions"); return ""; }
  const e = UI.errors || {};
  return pageNarrow("sessions", backLink("#/sessions/" + s.id, "Back to session details") + `
    <div class="panel">
      <h1 class="h-md">Join this session</h1>
      <div class="rows" style="margin:18px 0 22px">
        ${row("Session", s.topic)}${row("Speaker", s.speakerName)}
        ${row("When", fmtDayFull(s.date) + " · " + s.slotLabel)}
      </div>
      <form id="f-register" data-id="${s.id}" novalidate>
        ${field("participantName", "Full name", true, "input", "e.g. Anita Rao", UI.lastName || "", e.participantName,
                "Just your name. No email, password or account.")}
        <button class="btn btn-primary btn-block" type="submit">${I.lock}Get meeting link</button>
      </form>
    </div>`);
}

/* ============================================================ SCREEN-10 */
function viewRegistered(id){
  const r = UI.registration;
  if (!r || r.session.id !== id){ go("#/sessions/" + id); return ""; }
  const s = r.session;
  return pageNarrow("sessions", `
    <div class="panel">
      <div style="text-align:center">
        <div style="width:56px;height:56px;border-radius:var(--r-full);background:var(--avail-bg);border:1px solid var(--avail-bd);color:var(--avail-ic);display:grid;place-items:center;margin:0 auto 18px">
          <span class="big-ic">${I.check}</span></div>
        <h1 class="h-lg">You’re registered!</h1>
        <p class="lead" style="margin-top:8px">Thanks, ${esc(r.participantName)}. Here is everything you need.</p>
      </div>
      <div class="rows" style="margin:22px 0">
        ${row("Session", s.topic)}${row("Speaker", s.speakerName)}
        ${row("Date", fmtDayFull(s.date))}${row("Time", s.slotLabel)}
      </div>
      <div class="reveal">
        <p class="eyebrow">Your meeting link</p>
        <div class="linkbox"><code>${esc(s.meetingLink)}</code>
          <button class="btn btn-secondary btn-sm" data-act="copy" data-link="${esc(s.meetingLink)}">${I.copy}<span data-copy-label>Copy</span></button></div>
        <a class="btn btn-primary btn-block" href="${esc(s.meetingLink)}" target="_blank" rel="noopener noreferrer">Join session${I.arrow}</a>
      </div>
      <div style="text-align:center;margin-top:20px"><a class="linkbtn" href="#/sessions">Browse other upcoming sessions</a></div>
    </div>`);
}

/* ============================================================ SCREEN-11 */
function viewAdminLogin(){
  const flash = takeFlash();
  return pageNarrow("admin", `
    <div class="panel" style="max-width:440px;margin:24px auto">
      <p class="eyebrow">Admin portal</p>
      <h1 class="h-md" style="margin-top:6px">Sign in</h1>
      <p class="small muted" style="margin:8px 0 22px">Administrator access only. There is no public registration.</p>
      ${flash}
      <form id="f-admin" novalidate>
        <div class="field"><label for="a-email">Email <span class="req">*</span></label>
          <input class="input" id="a-email" name="email" type="email" autocomplete="username" placeholder="admin@trainerhub.app"></div>
        <div class="field"><label for="a-pass">Password <span class="req">*</span></label>
          <input class="input" id="a-pass" name="password" type="password" autocomplete="current-password" placeholder="••••••••"></div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
      <div class="lock" style="margin-top:20px">${I.lock}
        <div><b>Demo credentials</b><br>admin@trainerhub.app &nbsp;/&nbsp; admin123<br>
        <span class="tiny">Verified on the server against a salted hash; your session is an httpOnly cookie.
        Override with the TRAINERHUB_ADMIN_EMAIL and TRAINERHUB_ADMIN_PASSWORD environment variables.</span></div></div>
    </div>`);
}

/* ============================================================ SCREEN-12 */
async function viewAdminDashboard(){
  const data = await API.get("/api/admin/dashboard");
  const flash = takeFlash();
  let body = flash + `
    <div class="sec-h" style="margin-bottom:22px">
      <div><p class="eyebrow">Dashboard</p><h1 class="h-lg" style="margin-top:6px">Session management</h1></div>
      <a class="btn btn-primary btn-sm" href="#/admin/create">Create session</a>
    </div>
    <div class="stats">
      <div class="card stat"><div class="n">${data.pending.length}</div><div class="l">Pending nominations</div></div>
      <div class="card stat"><div class="n">${data.published.length}</div><div class="l">Published sessions</div></div>
      <div class="card stat"><div class="n">${data.availableCount}</div><div class="l">Available slots (7 days)</div></div>
    </div>
    <section style="margin-bottom:34px"><div class="sec-h"><h2 class="h-md">Pending nominations</h2>${badge("RESERVED")}</div>`;

  body += data.pending.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th scope="col">Date &amp; time</th><th scope="col">Topic</th><th scope="col">Speaker</th>
      <th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>` +
    data.pending.map(s => `<tr>
      <td>${esc(fmtShort(s.date))}<br><span class="muted">${esc(s.slotLabel)}</span></td>
      <td class="topic">${esc(s.topic)}</td><td>${esc(s.speakerName)}</td>
      <td>${badge("RESERVED")}</td>
      <td style="text-align:right"><a class="btn btn-secondary btn-sm" href="#/admin/review/${s.id}">Review</a></td></tr>`).join("")
    + `</tbody></table></div>`
    : `<div class="empty"><div class="i">${I.inbox}</div><h3 class="h-sm">No sessions are awaiting approval.</h3>
       <p class="small muted" style="margin-top:6px">New speaker nominations will appear here.</p></div>`;

  body += `</section><section><div class="sec-h"><h2 class="h-md">Published sessions</h2>${badge("PUBLISHED")}</div>`;
  body += data.published.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th scope="col">Date &amp; time</th><th scope="col">Topic</th><th scope="col">Speaker</th>
      <th scope="col">Registrations</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>` +
    data.published.map(s => `<tr>
      <td>${esc(fmtShort(s.date))}<br><span class="muted">${esc(s.slotLabel)}</span></td>
      <td class="topic">${esc(s.topic)}</td><td>${esc(s.speakerName)}</td>
      <td>${s.registrations}</td>
      <td style="text-align:right"><a class="btn btn-secondary btn-sm" href="#/admin/manage/${s.id}">Manage</a></td></tr>`).join("")
    + `</tbody></table></div>`
    : `<div class="empty"><div class="i">${I.cal}</div><h3 class="h-sm">No published sessions.</h3>
       <p class="small muted" style="margin-top:6px">Approve a nomination or create a session manually.</p></div>`;

  return adminShell(body + `</section>`);
}

/* ============================================================ SCREEN-13 */
async function viewAdminReview(id){
  const { session: s } = await API.get("/api/admin/sessions/" + id);
  if (s.status !== "RESERVED"){
    setFlash("info", "alert", "That nomination has already been decided.", `It is currently ${s.status.toLowerCase()}.`);
    go("#/admin"); return "";
  }
  return adminShell(backLink("#/admin", "Back to dashboard") + `
    <div class="panel" style="max-width:720px">
      ${badge("RESERVED")}
      <h1 class="h-md" style="margin-top:14px">Review nomination</h1>
      <p class="small muted" style="margin-top:8px">Approving publishes this session publicly.
      Rejecting removes it and releases the slot back to Available.</p>
      <p class="eyebrow" style="color:var(--ink-3);margin:24px 0 10px">Session</p>
      <div class="rows">
        ${row("Date", fmtDayFull(s.date))}${row("Time", s.slotLabel)}${row("Topic", s.topic)}
        ${row("Description", s.description || "— not provided —")}${row("Meeting link", s.meetingLink)}
      </div>
      <p class="eyebrow" style="color:var(--ink-3);margin:24px 0 10px">Speaker</p>
      <div class="rows">
        ${row("Full name", s.speakerName)}${row("Phone", s.speakerPhone || "—")}
        ${row("Email", s.speakerEmail || "— not provided —")}
        ${row("Submitted", new Date(s.createdAt).toLocaleString())}
      </div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:26px">
        <button class="btn btn-approve" data-act="approve" data-id="${s.id}" style="flex:1;min-width:200px">${I.check}Approve &amp; publish</button>
        <button class="btn btn-danger" data-act="reject" data-id="${s.id}" style="flex:1;min-width:200px">${I.ban}Reject nomination</button>
      </div>
    </div>`, true);
}

/* ============================================================ SCREEN-14 */
async function viewAdminManage(id){
  const { session: s } = await API.get("/api/admin/sessions/" + id);
  if (s.status !== "PUBLISHED"){
    setFlash("info", "alert", "That session is no longer published.", `It is currently ${s.status.toLowerCase()}.`);
    go("#/admin"); return "";
  }
  const n = s.registrations || 0;
  return adminShell(backLink("#/admin", "Back to dashboard") + `
    <div class="panel" style="max-width:720px">
      ${badge("PUBLISHED")}
      <h1 class="h-md" style="margin-top:14px">Manage session</h1>
      <p class="small muted" style="margin-top:8px">This session is publicly visible on Upcoming Sessions.</p>
      <div class="rows" style="margin:22px 0">
        ${row("Date", fmtDayFull(s.date))}${row("Time", s.slotLabel)}${row("Topic", s.topic)}
        ${row("Speaker", s.speakerName)}${row("Meeting link", s.meetingLink)}${row("Registrations", String(n))}
      </div>
      <div class="alert alert-warn">${I.alert}
        <div>Cancelling removes this session from the public listing and releases the slot back to Available${
          n ? `. ${n} participant${n === 1 ? " has" : "s have"} already registered.` : "."}</div></div>
      <button class="btn btn-danger btn-block" data-act="cancel" data-id="${s.id}">${I.ban}Cancel session</button>
    </div>`, true);
}

/* ============================================================ SCREEN-15 */
async function viewAdminCreate(){
  const cal = await API.get("/api/calendar");
  const d = UI.adminDraft || {};
  const e = UI.errors || {};
  const dateOpts = cal.days.map(x =>
    `<option value="${x.date}"${d.date === x.date ? " selected" : ""}>${esc(fmtDayFull(x.date))}</option>`).join("");
  const slotOpts = cal.slots.map(sl =>
    `<option value="${sl.id}"${d.slot === sl.id ? " selected" : ""}>${sl.label}</option>`).join("");

  return adminShell(backLink("#/admin", "Back to dashboard") + `
    <div class="panel" style="max-width:720px">
      <h1 class="h-md">Create session</h1>
      <p class="small muted" style="margin:8px 0 22px">A session created here is published immediately.
      The server applies the same slot rules: one session per slot, within the seven-day window.</p>
      ${e.slot ? alertBox("danger", I.alert, e.slot, "") : ""}
      <form id="f-create" novalidate>
        <div class="field"><label for="c-date">Date <span class="req">*</span></label>
          <select class="select" id="c-date" name="date">${dateOpts}</select></div>
        <div class="field"><label for="c-slot">Slot <span class="req">*</span></label>
          <select class="select" id="c-slot" name="slot">${slotOpts}</select>
          <p class="hint" style="margin:7px 0 0">Only Available slots can be used.</p></div>
        ${field("topic", "Session topic", true, "input", "e.g. AI for Small Business", d.topic, e.topic, "")}
        ${field("speakerName", "Speaker name", true, "input", "e.g. Deepak Babel", d.speakerName, e.speakerName, "")}
        ${field("meetingLink", "Meeting link", true, "input", "https://meet.google.com/abc-defg-hij", d.meetingLink, e.meetingLink, "")}
        ${field("description", "Description", false, "textarea", "What will participants learn?", d.description, e.description, "")}
        <button class="btn btn-primary btn-block" type="submit">Create &amp; publish session</button>
      </form>
    </div>`, true);
}

/* --------------------------------------------------------- prototype panel */
function protoPanel(open){
  if (!UI.demoRoutes) return "";
  if (!open){
    return `<button class="proto-btn" data-act="proto-toggle" aria-expanded="false"><span aria-hidden="true">⚙</span>Prototype controls</button>`;
  }
  return `<div class="proto-pop" role="dialog" aria-label="Prototype controls">
      <h4>Prototype controls</h4>
      <p>Not product features. These call demo endpoints on the server so you can show the error and empty
      states the spec requires. Disable them with TRAINERHUB_DEMO=off.</p>
      <button class="btn btn-secondary" data-act="demo-fill">Fill every slot (no availability)</button>
      <button class="btn btn-secondary" data-act="demo-clear">Remove all published sessions</button>
      <button class="btn btn-danger" data-act="demo-reset">Reset demo data</button>
      <button class="btn btn-secondary" data-act="proto-toggle" style="margin-bottom:0">Close</button>
    </div>
    <button class="proto-btn" data-act="proto-toggle" aria-expanded="true"><span aria-hidden="true">⚙</span>Prototype controls</button>`;
}

/* ------------------------------------------------------------------ router */
function go(h){ if (location.hash === h) render(); else location.hash = h; }

function showNetError(err){
  const bar = document.getElementById("netbar");
  bar.hidden = false;
  bar.className = "netbar";
  bar.innerHTML = `<div class="wrap">${I.alert}<span>${esc(err.message || "Connection problem.")}</span>
    <button class="linkbtn" data-act="retry" style="color:inherit">Retry</button></div>`;
}
function clearNetError(){ const b = document.getElementById("netbar"); b.hidden = true; b.innerHTML = ""; }

let renderToken = 0;
async function render(){
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  const app = document.getElementById("app");

  // Only show the spinner if the fetch is slow enough to notice.
  const slow = setTimeout(() => {
    if (token === renderToken) app.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Loading…</div>`;
  }, 180);

  let html = "";
  try {
    // Admin routes: ask the SERVER whether we are signed in. The client cannot
    // grant itself access — an unauthenticated dashboard fetch returns 401.
    if (parts[0] === "admin"){
      const { admin } = await API.get("/api/admin/me");
      UI.admin = admin;
      if (!admin) html = viewAdminLogin();
      else if (!parts[1])                    html = await viewAdminDashboard();
      else if (parts[1] === "create")        html = await viewAdminCreate();
      else if (parts[1] === "review")        html = await viewAdminReview(parts[2]);
      else if (parts[1] === "manage")        html = await viewAdminManage(parts[2]);
      else html = await viewAdminDashboard();
    }
    else if (!parts.length)                                 html = await viewLanding();
    else if (parts[0] === "speaker" && !parts[1])           html = await viewSpeakerSlots();
    else if (parts[0] === "speaker" && parts[1] === "session")   html = viewSessionForm();
    else if (parts[0] === "speaker" && parts[1] === "details")   html = viewSpeakerForm();
    else if (parts[0] === "speaker" && parts[1] === "review")    html = viewReview();
    else if (parts[0] === "speaker" && parts[1] === "confirmed") html = await viewConfirmation();
    else if (parts[0] === "sessions" && !parts[1])               html = await viewSessions();
    else if (parts[0] === "sessions" && parts[2] === "register")   html = await viewRegister(parts[1]);
    else if (parts[0] === "sessions" && parts[2] === "registered") html = viewRegistered(parts[1]);
    else if (parts[0] === "sessions" && parts[1])                  html = await viewSessionDetail(parts[1]);
    else html = page("home", `<div class="empty"><div class="i">${I.ban}</div><h2 class="h-sm">Page not found.</h2>
      <a class="btn btn-secondary btn-sm" href="#/" style="margin-top:16px">Go home</a></div>`);
    clearNetError();
  } catch (err){
    clearTimeout(slow);
    if (token !== renderToken) return;
    showNetError(err);
    html = page("home", `<div class="empty"><div class="i">${I.alert}</div>
      <h2 class="h-sm">We couldn't load this page.</h2>
      <p class="small muted" style="margin-top:6px">${esc(err.message || "")}</p>
      <button class="btn btn-secondary btn-sm" data-act="retry" style="margin-top:16px">Try again</button></div>`);
  }

  clearTimeout(slow);
  if (token !== renderToken) return;      // a newer render superseded this one
  if (html){
    app.innerHTML = html;
    document.getElementById("proto").innerHTML = protoPanel(protoOpen);
    window.scrollTo(0, 0);
    const m = document.getElementById("main");
    if (m) m.setAttribute("tabindex", "-1");
  }
}

function focusFirstError(){
  const el = document.querySelector(".input.err, .textarea.err");
  if (el) el.focus();
}
function busy(el, on){
  if (!el) return;
  el.setAttribute("aria-busy", on ? "true" : "false");
  el.disabled = !!on;
}

/* ------------------------------------------------------------ interactions */
document.addEventListener("click", async ev => {
  const el = ev.target.closest("[data-act]");
  if (!el) return;
  const act = el.getAttribute("data-act");

  if (act === "proto-toggle"){ protoOpen = !protoOpen; document.getElementById("proto").innerHTML = protoPanel(protoOpen); return; }
  if (act === "retry"){ clearNetError(); render(); return; }

  if (act === "demo-reset" || act === "demo-fill" || act === "demo-clear"){
    const route = { "demo-reset": "reset", "demo-fill": "fill-slots", "demo-clear": "clear-published" }[act];
    busy(el, true);
    try { await API.post("/api/demo/" + route); } catch (e){ showNetError(e); }
    protoOpen = false;
    go(act === "demo-clear" ? "#/sessions" : "#/speaker"); return;
  }

  /* SCREEN-02 — pick a slot. The server re-checks at submit time. */
  if (act === "pick"){
    UI.draft = {
      date: el.getAttribute("data-date"), slot: el.getAttribute("data-slot"),
      slotLabel: el.getAttribute("data-slot") === "11:00" ? "11:00 AM" : "7:00 PM",
      topic: "", description: "", meetingLink: "", speakerName: "", speakerPhone: "", speakerEmail: ""
    };
    UI.errors = {};
    go("#/speaker/session"); return;
  }

  /* SCREEN-05 — submit. Only the server decides whether the slot is still free. */
  if (act === "submit-nomination"){
    const d = UI.draft; if (!d) return;
    busy(el, true);
    try {
      const { session } = await API.post("/api/nominations", d);
      UI.lastNominationId = session.id;
      UI.draft = null; UI.errors = {};
      go("#/speaker/confirmed");
    } catch (err){
      busy(el, false);
      if (err.code === "SLOT_TAKEN"){
        // Someone else took it. Send the speaker back to a freshly loaded calendar.
        UI.draft = null;
        setFlash("danger", "alert", err.message, "Your nomination was not created.");
        go("#/speaker");
      } else if (err.code === "VALIDATION_FAILED"){
        UI.errors = err.errors || {};
        setFlash("danger", "alert", "Some details need correcting.", "Check the highlighted fields.");
        go("#/speaker/session");
      } else {
        // Never imply the slot was reserved when it was not.
        setFlash("danger", "alert", "We couldn't reserve this slot. Please try again.",
                 "Nothing has been submitted and your slot has not been reserved.");
        render();
      }
    }
    return;
  }

  /* admin lifecycle — the server authorises and performs each transition */
  if (act === "approve" || act === "reject" || act === "cancel"){
    const id = el.getAttribute("data-id");
    if (act === "reject" && !confirm("Reject this nomination?\n\nThe session will not be published and the slot will become Available again.")) return;
    if (act === "cancel" && !confirm("Cancel this published session?\n\nIt will disappear from the public listing and the slot will become Available again.")) return;
    busy(el, true);
    try {
      const res = await API.post(`/api/admin/sessions/${id}/${act}`);
      const s = res.session;
      if (act === "approve") setFlash("ok", "check", "Nomination approved.", "The slot is now Published and the session is publicly visible.");
      if (act === "reject")  setFlash("warn", "ban", "Nomination rejected.", `The ${s.slotLabel} slot on ${fmtLong(s.date)} is Available again.`);
      if (act === "cancel")  setFlash("warn", "ban", "Session cancelled.", `It has been removed from Upcoming Sessions and the ${s.slotLabel} slot on ${fmtLong(s.date)} is Available again.`);
    } catch (err){
      busy(el, false);
      setFlash("danger", "alert", err.message || "That action could not be completed.", "");
    }
    go("#/admin"); return;
  }

  if (act === "admin-logout"){
    try { await API.post("/api/admin/logout"); } catch {}
    UI.admin = null; go("#/"); return;
  }

  if (act === "copy"){
    const link = el.getAttribute("data-link");
    const lbl = el.querySelector("[data-copy-label]");
    const done = () => { if (lbl){ lbl.textContent = "Copied"; setTimeout(() => { lbl.textContent = "Copy"; }, 1800); } };
    try { await navigator.clipboard.writeText(link); done(); }
    catch {
      const t = document.createElement("textarea"); t.value = link; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(t); done();
    }
    return;
  }
});

/* -------------------------------------------------------------- form submits */
document.addEventListener("submit", async ev => {
  const f = ev.target;
  ev.preventDefault();
  const submitBtn = f.querySelector('button[type="submit"]');

  /* SCREEN-03 — client-side validation for fast feedback only. The server
     validates again on POST /api/nominations and its verdict wins. */
  if (f.id === "f-session"){
    const d = UI.draft; if (!d) { go("#/speaker"); return; }
    d.topic = f.topic.value.trim();
    d.meetingLink = f.meetingLink.value.trim();
    d.description = f.description.value.trim();
    const e = {};
    if (!d.topic) e.topic = "Enter a session topic.";
    else if (d.topic.length < 4) e.topic = "The topic is too short to be useful to participants.";
    if (!d.meetingLink) e.meetingLink = "Enter a meeting link.";
    else if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(d.meetingLink)) e.meetingLink = "Enter a valid meeting link, starting with https://";
    UI.errors = e;
    render();
    if (Object.keys(e).length){ focusFirstError(); return; }
    UI.errors = {}; go("#/speaker/details"); return;
  }

  /* SCREEN-04 */
  if (f.id === "f-speaker"){
    const d = UI.draft; if (!d) { go("#/speaker"); return; }
    d.speakerName  = f.speakerName.value.trim();
    d.speakerPhone = f.speakerPhone.value.trim();
    d.speakerEmail = f.speakerEmail.value.trim();
    const e = {};
    if (!d.speakerName) e.speakerName = "Enter your full name.";
    else if (d.speakerName.split(/\s+/).length < 2) e.speakerName = "Enter your full name, first and last.";
    if (!d.speakerPhone) e.speakerPhone = "Enter a phone number.";
    else if (d.speakerPhone.replace(/\D/g, "").length < 8) e.speakerPhone = "Enter a valid phone number.";
    if (d.speakerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.speakerEmail)) e.speakerEmail = "Enter a valid email address, or leave it blank.";
    UI.errors = e;
    render();
    if (Object.keys(e).length){ focusFirstError(); return; }
    UI.errors = {}; go("#/speaker/review"); return;
  }

  /* SCREEN-09 — the only route that yields a meeting link */
  if (f.id === "f-register"){
    const id = f.getAttribute("data-id");
    const name = f.participantName.value.trim();
    UI.lastName = name;
    busy(submitBtn, true);
    try {
      const res = await API.post(`/api/sessions/${id}/register`, { participantName: name });
      UI.registration = { participantName: res.registration.participantName, session: res.session };
      UI.errors = {}; UI.lastName = "";
      go(`#/sessions/${id}/registered`);
    } catch (err){
      busy(submitBtn, false);
      UI.errors = err.errors || { participantName: err.message };
      render(); focusFirstError();
    }
    return;
  }

  /* SCREEN-11 */
  if (f.id === "f-admin"){
    busy(submitBtn, true);
    try {
      const { admin } = await API.post("/api/admin/login", { email: f.email.value, password: f.password.value });
      UI.admin = admin;
      go("#/admin");
    } catch (err){
      busy(submitBtn, false);
      setFlash("danger", "alert", err.message || "Incorrect email or password.", "Check the demo credentials below and try again.");
      render();
    }
    return;
  }

  /* SCREEN-15 */
  if (f.id === "f-create"){
    const payload = {
      date: f.date.value, slot: f.slot.value,
      topic: f.topic.value.trim(), speakerName: f.speakerName.value.trim(),
      meetingLink: f.meetingLink.value.trim(), description: f.description.value.trim()
    };
    UI.adminDraft = payload;
    busy(submitBtn, true);
    try {
      const { session } = await API.post("/api/admin/sessions", payload);
      UI.adminDraft = null; UI.errors = {};
      setFlash("ok", "check", "Session created and published.",
               `${session.topic} · ${fmtLong(session.date)} · ${session.slotLabel}`);
      go("#/admin");
    } catch (err){
      busy(submitBtn, false);
      UI.errors = err.errors || {};
      if (err.code === "SLOT_TAKEN") UI.errors.slot = err.message;
      render(); focusFirstError();
    }
    return;
  }
});

/* -------------------------------------------------------------------- boot */
(async function boot(){
  try {
    const b = await API.get("/api/bootstrap");
    UI.admin = b.admin;
    UI.demoRoutes = b.demoRoutes;
  } catch (err){ showNetError(err); }
  window.addEventListener("hashchange", render);
  render();
})();
