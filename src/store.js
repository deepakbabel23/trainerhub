"use strict";
/* ============================================================================
   TrainerHub — persistence (Phase 2)

   A JSON file store with atomic writes. Deliberately the narrowest possible
   interface (read the state, mutate under a lock, persist) so Phase 3 can
   swap this file for a real database without touching the API layer.
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const D = require("./domain");

const DATA_DIR  = process.env.TRAINERHUB_DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "trainerhub.json");

function uid(){ return crypto.randomBytes(6).toString("hex"); }

/* ------------------------------------------------------------------- seed */
/* Demo data anchored to the current date so the seven-day window always looks
   right whenever the server is started. Phase 3 replaces this with migrations
   and real records. */
function seedSessions(now = new Date()){
  const W = D.windowDates(now);
  const mk = (dateISO, slot, status, topic, description, name, phone, email, link) => ({
    id: uid(), date: dateISO, slot, status,
    topic, description,
    speakerName: name, speakerPhone: phone, speakerEmail: email || "",
    meetingLink: link, source: "speaker",
    createdAt: Date.now(), decidedAt: status === "PUBLISHED" ? Date.now() : null
  });
  return [
    mk(W[1], "11:00", "PUBLISHED", "AI for HR Professionals",
      "A practical walkthrough of how HR teams can use AI assistants for screening, onboarding documentation and internal policy Q&A. Includes a live demonstration and a question round at the end.",
      "Raj Sharma", "+91 98200 11223", "raj.sharma@example.com", "https://meet.google.com/hrt-aiqa-001"),
    mk(W[1], "19:00", "RESERVED", "AI for Small Business",
      "How a two-person business can automate quotations, invoices and customer follow-ups without hiring a developer.",
      "Neha Gupta", "+91 99300 44556", "neha.gupta@example.com", "https://meet.google.com/sbz-aiqa-002"),
    mk(W[2], "19:00", "PUBLISHED", "Using AI for Marketing",
      "Campaign briefs, audience research and copy iteration. We will build one complete campaign end to end during the session.",
      "Amit Jain", "+91 98450 77889", "", "https://us02web.zoom.us/j/8841127700"),
    mk(W[3], "19:00", "RESERVED", "AI Productivity",
      "Cutting two hours a day out of routine knowledge work: meeting notes, inbox triage and weekly reporting.",
      "Priya Mehta", "+91 90040 33221", "priya.mehta@example.com", "https://meet.google.com/prd-aiqa-004"),
    mk(W[5], "11:00", "PUBLISHED", "Data Storytelling for Analysts",
      "Turning a dense spreadsheet into a three-slide narrative an executive will actually act on.",
      "Karthik Iyer", "+91 96320 88114", "", "https://teams.microsoft.com/l/meetup-join/ds-001")
  ];
}

function emptyState(now = new Date()){
  return {
    version: 2,
    seededOn: D.iso(now),
    sessions: seedSessions(now),
    registrations: []
  };
}

/* ------------------------------------------------------------------ state */
let state = null;

function load(){
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions)){
      // Reseed when the stored demo data has aged out of the booking window,
      // so a long-running demo server never shows an empty calendar.
      if (parsed.seededOn === D.iso(new Date())) return parsed;
    }
  } catch { /* missing or corrupt file — fall through to a fresh state */ }
  return emptyState();
}

function persist(){
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Atomic: write to a temp file then rename, so a crash mid-write cannot
    // leave a half-written JSON file behind.
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e){
    console.error("[store] persist failed:", e.message);
  }
}

function init(){ state = load(); persist(); return state; }
function get(){ if (!state) init(); return state; }

/**
 * Run a mutation and persist it.
 *
 * Node runs one request handler at a time, so a read-modify-write inside this
 * callback cannot interleave with another request's. That is what makes the
 * slot-uniqueness check in api.js a genuine check-and-set rather than the
 * racy client-side check Phase 1 had. A multi-process deployment would need
 * the database constraint described in the Phase 3 notes.
 */
function mutate(fn){
  const s = get();
  const result = fn(s);
  persist();
  return result;
}

function reset(){ state = emptyState(); persist(); return state; }

module.exports = { init, get, mutate, reset, uid, DATA_FILE, DATA_DIR, seedSessions, emptyState };
