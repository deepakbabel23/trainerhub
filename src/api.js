"use strict";
/* ============================================================================
   TrainerHub — HTTP API (Phase 2)

   Every product rule is enforced here, server-side. The browser is a renderer.

   Public routes
     GET  /api/bootstrap                      calendar + published sessions
     GET  /api/calendar                       7-day slot grid with states
     GET  /api/sessions                       published sessions (no links)
     GET  /api/sessions/:id                   one published session (no link)
     POST /api/nominations                    create a nomination -> RESERVED
     GET  /api/nominations/:id                a speaker's own confirmation view
     POST /api/sessions/:id/register          register -> returns the link

   Admin routes (all require a valid session cookie)
     POST /api/admin/login
     POST /api/admin/logout
     GET  /api/admin/me
     GET  /api/admin/dashboard
     POST /api/admin/sessions/:id/approve
     POST /api/admin/sessions/:id/reject
     POST /api/admin/sessions/:id/cancel
     POST /api/admin/sessions                 manual creation -> PUBLISHED

   Demo routes (prototype affordances, disabled with TRAINERHUB_DEMO=off)
     POST /api/demo/reset | /api/demo/fill-slots | /api/demo/clear-published
   ========================================================================== */

const D = require("./domain");
const store = require("./store");
const auth = require("./auth");
const { publicSession, registeredSession, adminSession } = require("./serialize");

/* Demo routes let anyone reset or flood the data. Harmless locally, hostile on
   a shared tester URL — so they default OFF in production and must be opted
   into explicitly with TRAINERHUB_DEMO=on. */
const DEMO_ROUTES_ENABLED = process.env.NODE_ENV === "production"
  ? process.env.TRAINERHUB_DEMO === "on"
  : process.env.TRAINERHUB_DEMO !== "off";

/* --------------------------------------------------------------- helpers */
class HttpError extends Error {
  constructor(status, code, message, extra = {}){
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}
const badRequest   = (code, msg, extra) => new HttpError(400, code, msg, extra);
const unauthorized = ()                 => new HttpError(401, "UNAUTHORIZED", "Administrator sign-in required.");
const notFound     = (msg)              => new HttpError(404, "NOT_FOUND", msg || "Not found.");
const conflict     = (code, msg, extra) => new HttpError(409, "SLOT_TAKEN", msg, extra);
const invalid      = (errors)           => new HttpError(422, "VALIDATION_FAILED", "Some details need correcting.", { errors });

function findSession(state, id){
  return state.sessions.find(s => s.id === id) || null;
}
function registrationCount(state, sessionId){
  return state.registrations.filter(r => r.sessionId === sessionId).length;
}

/** Published sessions that have not yet started, soonest first. RULE-008. */
function publishedSessions(state, now = new Date()){
  return state.sessions
    .filter(s => s.status === D.STATUS.PUBLISHED)
    .filter(s => D.slotDateTime(s.date, s.slot) > now)
    .sort((a, b) => D.slotDateTime(a.date, a.slot) - D.slotDateTime(b.date, b.slot));
}
function pendingSessions(state){
  return state.sessions
    .filter(s => s.status === D.STATUS.RESERVED)
    .sort((a, b) => D.slotDateTime(a.date, a.slot) - D.slotDateTime(b.date, b.slot));
}

function requireAdmin(req){
  const admin = auth.currentAdmin(req);
  if (!admin) throw unauthorized();
  return admin;
}

/* ============================================================ public routes */

function getCalendar(){
  const state = store.get();
  return {
    days: D.buildCalendar(state.sessions),
    availableCount: D.availableCount(state.sessions),
    windowDays: D.WINDOW_DAYS,
    slots: D.SLOTS.map(s => ({ id: s.id, label: s.label }))
  };
}

function getPublishedList(){
  const state = store.get();
  return { sessions: publishedSessions(state).map(publicSession) };
}

function getBootstrap(req){
  return {
    calendar: getCalendar(),
    sessions: getPublishedList().sessions,
    admin: auth.currentAdmin(req) ? { email: auth.currentAdmin(req).email } : null,
    demoRoutes: DEMO_ROUTES_ENABLED,
    serverTime: new Date().toISOString()
  };
}

/** FR-009 / P0-007: only published sessions are publicly retrievable. */
function getSession(id){
  const state = store.get();
  const s = findSession(state, id);
  if (!s || s.status !== D.STATUS.PUBLISHED){
    throw notFound("This session is not available. It may have been cancelled.");
  }
  return { session: publicSession(s) };   // no meeting link — P0-008
}

/** FR-004 / FR-005 / P0-001 / P0-004 / P0-005. */
function createNomination(body){
  const { errors, value } = D.validateNomination(body);
  if (Object.keys(errors).length) throw invalid(errors);

  return store.mutate(state => {
    // Re-checked inside the write path: the slot must still be free at the
    // moment we commit, not merely when the speaker loaded the calendar.
    if (!D.isNominatable(state.sessions, value.date, value.slot)){
      const state_ = D.slotState(state.sessions, value.date, value.slot);
      throw conflict("SLOT_TAKEN",
        state_ === "PASSED"
          ? "That time has already passed. Please choose another slot."
          : "This slot was just reserved by another speaker. Please choose another available slot.",
        { slotState: state_ });
    }
    const session = {
      id: store.uid(),
      date: value.date, slot: value.slot,
      status: D.STATUS.RESERVED,                      // RULE-004
      topic: value.topic, description: value.description,
      speakerName: value.speakerName, speakerPhone: value.speakerPhone,
      speakerEmail: value.speakerEmail, meetingLink: value.meetingLink,
      source: "speaker", createdAt: Date.now(), decidedAt: null
    };
    state.sessions.push(session);
    return { session: publicSession(session) };       // link withheld even here
  });
}

/**
 * The speaker's own confirmation view. Returns the nomination whatever its
 * current status, so the confirmation screen can tell the speaker honestly if
 * an admin has already acted on it. Still no meeting link: the speaker
 * supplied it, the screen does not need it back.
 */
function getNomination(id){
  const state = store.get();
  const s = findSession(state, id);
  if (!s) throw notFound("That nomination could not be found.");
  return { session: publicSession(s) };
}

/** FR-010 / FR-012 / P0-009: the one route that returns a meeting link. */
function registerParticipant(id, body){
  const { errors, value } = D.validateRegistration(body);
  if (Object.keys(errors).length) throw invalid(errors);

  return store.mutate(state => {
    const s = findSession(state, id);
    if (!s || s.status !== D.STATUS.PUBLISHED){
      throw notFound("This session is not available for registration.");
    }
    const registration = {
      id: store.uid(), sessionId: s.id,
      participantName: value.participantName,
      registeredAt: Date.now()
    };
    state.registrations.push(registration);
    return {
      registration: { id: registration.id, participantName: registration.participantName },
      session: registeredSession(s)          // link revealed only now — RULE-011
    };
  });
}

/* ============================================================= admin routes */

function adminLogin(body, res){
  const token = auth.login(body && body.email, body && body.password);
  if (!token) throw new HttpError(401, "BAD_CREDENTIALS", "Incorrect email or password.");
  res.setHeader("Set-Cookie", auth.sessionCookie(token));
  return { admin: { email: auth.ADMIN_EMAIL } };
}

function adminLogout(req, res){
  const admin = auth.currentAdmin(req);
  if (admin) auth.destroySession(admin.token);
  res.setHeader("Set-Cookie", auth.clearCookie());
  return { ok: true };
}

function adminMe(req){
  const admin = auth.currentAdmin(req);
  return { admin: admin ? { email: admin.email } : null };
}

function adminDashboard(req){
  requireAdmin(req);
  const state = store.get();
  return {
    pending:   pendingSessions(state).map(s => adminSession(s)),
    published: publishedSessions(state).map(s =>
                 adminSession(s, { registrations: registrationCount(state, s.id) })),
    availableCount: D.availableCount(state.sessions)
  };
}

function adminGetSession(req, id){
  requireAdmin(req);
  const state = store.get();
  const s = findSession(state, id);
  if (!s) throw notFound("That session could not be found.");
  return { session: adminSession(s, { registrations: registrationCount(state, s.id) }) };
}

/** FR-007 / P0-011: RESERVED -> PUBLISHED. */
function adminApprove(req, id){
  requireAdmin(req);
  return store.mutate(state => {
    const s = findSession(state, id);
    if (!s) throw notFound("That nomination could not be found.");
    if (s.status !== D.STATUS.RESERVED)
      throw badRequest("INVALID_TRANSITION", `Only a reserved nomination can be approved. This one is ${s.status.toLowerCase()}.`);
    s.status = D.STATUS.PUBLISHED; s.decidedAt = Date.now();
    return { session: adminSession(s) };
  });
}

/** FR-008 / FR-014 / P0-012: RESERVED -> rejected, slot released. */
function adminReject(req, id){
  requireAdmin(req);
  return store.mutate(state => {
    const s = findSession(state, id);
    if (!s) throw notFound("That nomination could not be found.");
    if (s.status !== D.STATUS.RESERVED)
      throw badRequest("INVALID_TRANSITION", `Only a reserved nomination can be rejected. This one is ${s.status.toLowerCase()}.`);
    s.status = D.STATUS.REJECTED; s.decidedAt = Date.now();
    return { session: adminSession(s), slotState: D.slotState(state.sessions, s.date, s.slot) };
  });
}

/** FR-013 / FR-014 / P0-013: PUBLISHED -> cancelled, slot released. */
function adminCancel(req, id){
  requireAdmin(req);
  return store.mutate(state => {
    const s = findSession(state, id);
    if (!s) throw notFound("That session could not be found.");
    if (s.status !== D.STATUS.PUBLISHED)
      throw badRequest("INVALID_TRANSITION", `Only a published session can be cancelled. This one is ${s.status.toLowerCase()}.`);
    s.status = D.STATUS.CANCELLED; s.decidedAt = Date.now();
    return { session: adminSession(s), slotState: D.slotState(state.sessions, s.date, s.slot) };
  });
}

/** FR-015 / RULE-014: manual creation, publishing immediately. Same slot rules. */
function adminCreate(req, body){
  requireAdmin(req);
  const { errors, value } = D.validateNomination(body, { requirePhone: false });
  if (Object.keys(errors).length) throw invalid(errors);

  return store.mutate(state => {
    if (!D.isNominatable(state.sessions, value.date, value.slot)){
      const st = D.slotState(state.sessions, value.date, value.slot);
      throw conflict("SLOT_TAKEN",
        `That slot is not available — it is ${st.toLowerCase()}. Choose another slot.`,
        { slotState: st });
    }
    const session = {
      id: store.uid(), date: value.date, slot: value.slot,
      status: D.STATUS.PUBLISHED,
      topic: value.topic, description: value.description,
      speakerName: value.speakerName, speakerPhone: value.speakerPhone,
      speakerEmail: value.speakerEmail, meetingLink: value.meetingLink,
      source: "admin", createdAt: Date.now(), decidedAt: Date.now()
    };
    state.sessions.push(session);
    return { session: adminSession(session) };
  });
}

/* ============================================================== demo routes */
/* Prototype affordances for demonstrating the error and empty states the spec
   requires. Not product features. Turn them off with TRAINERHUB_DEMO=off. */

function requireDemo(){
  if (!DEMO_ROUTES_ENABLED) throw notFound("Demo routes are disabled.");
}
function demoReset(){
  requireDemo(); store.reset();
  return { ok: true, calendar: getCalendar() };
}
function demoFillSlots(){
  requireDemo();
  return store.mutate(state => {
    for (const date of D.windowDates()){
      for (const meta of D.SLOTS){
        if (D.slotState(state.sessions, date, meta.id) === "AVAILABLE"){
          state.sessions.push({
            id: store.uid(), date, slot: meta.id, status: D.STATUS.RESERVED,
            topic: "Placeholder nomination", description: "",
            speakerName: "Demo Speaker", speakerPhone: "+91 90000 00000", speakerEmail: "",
            meetingLink: "https://meet.google.com/demo-fill-slot",
            source: "speaker", createdAt: Date.now(), decidedAt: null
          });
        }
      }
    }
    return { ok: true };
  });
}
function demoClearPublished(){
  requireDemo();
  return store.mutate(state => {
    state.sessions.forEach(s => {
      if (s.status === D.STATUS.PUBLISHED){ s.status = D.STATUS.CANCELLED; s.decidedAt = Date.now(); }
    });
    return { ok: true };
  });
}

module.exports = {
  HttpError, DEMO_ROUTES_ENABLED,
  getBootstrap, getCalendar, getPublishedList, getSession,
  createNomination, getNomination, registerParticipant,
  adminLogin, adminLogout, adminMe, adminDashboard, adminGetSession,
  adminApprove, adminReject, adminCancel, adminCreate,
  demoReset, demoFillSlots, demoClearPublished,
  publishedSessions, pendingSessions
};
