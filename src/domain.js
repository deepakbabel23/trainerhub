"use strict";
/* ============================================================================
   TrainerHub — domain layer (Phase 2)
   The authoritative implementation of the product rules. The browser holds no
   truth; every rule below is enforced here, on the server.

   Traceability: PRD v0.1 FR-001..FR-015 · SPEC v0.1 RULE-001..RULE-014
   ========================================================================== */

/* RULE-001 — exactly two slots per calendar day. */
const SLOTS = [
  { id: "11:00", label: "11:00 AM", hour: 11 },
  { id: "19:00", label: "7:00 PM",  hour: 19 }
];

/* RULE-002 — the booking window is seven calendar days, today included. */
const WINDOW_DAYS = 7;

const SLOT_IDS = SLOTS.map(s => s.id);

/* Statuses a session row may hold. Only RESERVED and PUBLISHED occupy a slot;
   REJECTED and CANCELLED are terminal and release it (RULE-012, RULE-013). */
const STATUS = {
  RESERVED:  "RESERVED",
  PUBLISHED: "PUBLISHED",
  REJECTED:  "REJECTED",
  CANCELLED: "CANCELLED"
};
const OCCUPYING = [STATUS.RESERVED, STATUS.PUBLISHED];

/* ------------------------------------------------------------------ dates */
function iso(d){
  return d.getFullYear() + "-" +
         String(d.getMonth() + 1).padStart(2, "0") + "-" +
         String(d.getDate()).padStart(2, "0");
}
function parseISO(s){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  // reject impossible dates like 2026-02-31 that Date would silently roll over
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}
function addDays(d, n){ const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function slotMeta(slotId){ return SLOTS.find(s => s.id === slotId) || null; }
function slotLabel(slotId){ const s = slotMeta(slotId); return s ? s.label : slotId; }

/** The exact wall-clock moment a slot starts. */
function slotDateTime(dateISO, slotId){
  const d = parseISO(dateISO); const meta = slotMeta(slotId);
  if (!d || !meta) return null;
  d.setHours(meta.hour, 0, 0, 0);
  return d;
}

/** The seven ISO dates currently open for nomination. RULE-002. */
function windowDates(now = new Date()){
  const today = new Date(now.getTime()); today.setHours(0, 0, 0, 0);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => iso(addDays(today, i)));
}

function inWindow(dateISO, now = new Date()){
  return windowDates(now).includes(dateISO);
}

/* RULE-003 — a slot whose scheduled time has already passed is unavailable. */
function hasPassed(dateISO, slotId, now = new Date()){
  const dt = slotDateTime(dateISO, slotId);
  return dt ? dt <= now : true;
}

/* ------------------------------------------------------------ slot states */

/** The session currently occupying a slot, if any. FR-003. */
function sessionAt(sessions, dateISO, slotId){
  return sessions.find(s =>
    s.date === dateISO && s.slot === slotId && OCCUPYING.includes(s.status)) || null;
}

/**
 * AVAILABLE | RESERVED | PUBLISHED | PASSED for any date+slot.
 * An occupied slot reports its occupant's status even if the time has passed,
 * so a session that already happened still reads as PUBLISHED rather than
 * silently reverting to PASSED.
 */
function slotState(sessions, dateISO, slotId, now = new Date()){
  const occupant = sessionAt(sessions, dateISO, slotId);
  if (occupant) return occupant.status;              // RULE-005, RULE-006
  if (hasPassed(dateISO, slotId, now)) return "PASSED";  // RULE-003
  return "AVAILABLE";
}

/** Can a speaker nominate this slot right now? RULE-002/003/005/006. */
function isNominatable(sessions, dateISO, slotId, now = new Date()){
  if (!SLOT_IDS.includes(slotId)) return false;
  if (!inWindow(dateISO, now)) return false;
  return slotState(sessions, dateISO, slotId, now) === "AVAILABLE";
}

/** The seven-day grid the slot-selection screen renders. FR-001, FR-002. */
function buildCalendar(sessions, now = new Date()){
  return windowDates(now).map(dateISO => ({
    date: dateISO,
    slots: SLOTS.map(meta => {
      const state = slotState(sessions, dateISO, meta.id, now);
      const occupant = sessionAt(sessions, dateISO, meta.id);
      return {
        slot: meta.id,
        label: meta.label,
        state,
        // Topic is public context for an occupied slot. The meeting link is
        // deliberately never included here — see serialize.js.
        topic: occupant ? occupant.topic : null
      };
    })
  }));
}

function availableCount(sessions, now = new Date()){
  let n = 0;
  for (const d of windowDates(now))
    for (const s of SLOTS)
      if (slotState(sessions, d, s.id, now) === "AVAILABLE") n++;
  return n;
}

/* ------------------------------------------------------------ validation */
/* Authoritative. The client validates too, for fast feedback, but the client
   is never trusted: every rule here runs again on the server. FR-006. */

function isValidUrl(v){
  const raw = String(v == null ? "" : v).trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(raw);
    return !!u.hostname && u.hostname.includes(".") && !u.hostname.endsWith(".");
  } catch { return false; }
}
function isValidEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim()); }
function isFullName(v){
  const t = String(v || "").trim();
  return t.length >= 3 && t.split(/\s+/).filter(Boolean).length >= 2;
}
function isValidPhone(v){ return String(v || "").replace(/\D/g, "").length >= 8; }

const LIMITS = { topic: 120, description: 1000, name: 80, phone: 30, email: 120, link: 500 };

function clean(v, max){ return String(v == null ? "" : v).trim().slice(0, max); }

/**
 * Validates a speaker nomination payload.
 * Returns { errors: {field: message}, value: cleanedPayload }.
 */
function validateNomination(input, { requirePhone = true } = {}){
  const value = {
    date:         clean(input.date, 10),
    slot:         clean(input.slot, 5),
    topic:        clean(input.topic, LIMITS.topic),
    description:  clean(input.description, LIMITS.description),
    meetingLink:  clean(input.meetingLink, LIMITS.link),
    speakerName:  clean(input.speakerName, LIMITS.name),
    speakerPhone: clean(input.speakerPhone, LIMITS.phone),
    speakerEmail: clean(input.speakerEmail, LIMITS.email)
  };
  const errors = {};

  if (!parseISO(value.date))          errors.date = "Choose a valid date.";
  if (!SLOT_IDS.includes(value.slot)) errors.slot = "Choose either the 11:00 AM or the 7:00 PM slot.";

  if (!value.topic)               errors.topic = "Enter a session topic.";
  else if (value.topic.length < 4) errors.topic = "The topic is too short to be useful to participants.";

  if (!value.meetingLink)              errors.meetingLink = "Enter a meeting link.";
  else if (!isValidUrl(value.meetingLink)) errors.meetingLink = "Enter a valid meeting link, starting with https://";

  if (!value.speakerName)             errors.speakerName = "Enter your full name.";
  else if (!isFullName(value.speakerName)) errors.speakerName = "Enter your full name, first and last.";

  if (requirePhone){
    if (!value.speakerPhone)              errors.speakerPhone = "Enter a phone number.";
    else if (!isValidPhone(value.speakerPhone)) errors.speakerPhone = "Enter a valid phone number.";
  }

  // Email is optional for V1 (SPEC SCREEN-04) — validated only when supplied.
  if (value.speakerEmail && !isValidEmail(value.speakerEmail))
    errors.speakerEmail = "Enter a valid email address, or leave it blank.";

  return { errors, value };
}

function validateRegistration(input){
  const value = { participantName: clean(input.participantName, LIMITS.name) };
  const errors = {};
  if (!value.participantName)            errors.participantName = "Enter your full name.";
  else if (!isFullName(value.participantName)) errors.participantName = "Enter your full name, first and last.";
  return { errors, value };
}

module.exports = {
  SLOTS, SLOT_IDS, WINDOW_DAYS, STATUS, OCCUPYING, LIMITS,
  iso, parseISO, addDays, slotMeta, slotLabel, slotDateTime,
  windowDates, inWindow, hasPassed,
  sessionAt, slotState, isNominatable, buildCalendar, availableCount,
  isValidUrl, isValidEmail, isFullName, isValidPhone,
  validateNomination, validateRegistration
};
