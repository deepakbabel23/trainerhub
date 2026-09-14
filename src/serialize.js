"use strict";
/* ============================================================================
   TrainerHub — serialisation boundary (Phase 2)

   FR-011 / RULE-009 / P0-008: the meeting link must never reach the public.

   This file is the ONLY place a session row is turned into an API response.
   The public serialiser builds a fresh object with an explicit field list, so
   a link cannot leak by someone later adding a field to the session row or
   spreading the row into a response. Leaking it would take a deliberate edit
   here, not an oversight elsewhere.
   ========================================================================== */

const { slotLabel } = require("./domain");

/**
 * Public view of a session. Safe for anonymous callers.
 * Deliberately omits: meetingLink, speakerPhone, speakerEmail.
 */
function publicSession(s){
  return {
    id:          s.id,
    date:        s.date,
    slot:        s.slot,
    slotLabel:   slotLabel(s.slot),
    topic:       s.topic,
    description: s.description || "",
    speakerName: s.speakerName,
    status:      s.status
  };
}

/**
 * Public session plus the meeting link. Returned from exactly one place:
 * the response to a participant's own successful registration. FR-012.
 */
function registeredSession(s){
  return { ...publicSession(s), meetingLink: s.meetingLink };
}

/**
 * Full view, for authenticated administrators only. Includes the link and the
 * speaker's contact details, which an admin needs to review a nomination.
 */
function adminSession(s, extra = {}){
  return {
    id:           s.id,
    date:         s.date,
    slot:         s.slot,
    slotLabel:    slotLabel(s.slot),
    topic:        s.topic,
    description:  s.description || "",
    speakerName:  s.speakerName,
    speakerPhone: s.speakerPhone || "",
    speakerEmail: s.speakerEmail || "",
    meetingLink:  s.meetingLink,
    status:       s.status,
    source:       s.source,
    createdAt:    s.createdAt,
    decidedAt:    s.decidedAt || null,
    ...extra
  };
}

/* Defence in depth: a cheap assertion used by the tests, and by the response
   writer in development, to prove no public payload carries a link. */
function assertNoLink(payload, sessions){
  const body = JSON.stringify(payload);
  for (const s of sessions){
    if (s.meetingLink && body.includes(s.meetingLink)){
      throw new Error("Meeting link leaked into a public payload: session " + s.id);
    }
  }
  return true;
}

module.exports = { publicSession, registeredSession, adminSession, assertNoLink };
