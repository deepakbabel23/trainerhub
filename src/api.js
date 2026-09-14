"use strict";
/* ============================================================================
   TrainerHub — HTTP API (Phase 3)

   Same endpoints and same contracts as Phase 2. The differences are beneath
   the surface: every handler is async, data comes from the repository, and
   slot claiming is decided by a database constraint rather than by an
   in-process check.
   ========================================================================== */

const D = require("./domain");
const repo = require("./repo");
const auth = require("./auth");
const crypto = require("crypto");
const { publicSession, registeredSession, adminSession } = require("./serialize");

/* Demo routes mutate or destroy data. Off in production unless opted in, and
   hard-disabled whenever a real database is attached — resetting a live
   bookings table from an unauthenticated HTTP call is not a thing we allow. */
const DEMO_ROUTES_ENABLED =
  repo.backend !== "postgres" &&
  (process.env.NODE_ENV === "production"
    ? process.env.TRAINERHUB_DEMO === "on"
    : process.env.TRAINERHUB_DEMO !== "off");

const uid = () => crypto.randomBytes(6).toString("hex");

/* --------------------------------------------------------------- helpers */
class HttpError extends Error {
  constructor(status, code, message, extra = {}){
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}
const badRequest   = (code, msg, extra) => new HttpError(400, code, msg, extra);
const unauthorized = ()                 => new HttpError(401, "UNAUTHORIZED", "Administrator sign-in required.");
const notFound     = (msg)              => new HttpError(404, "NOT_FOUND", msg || "Not found.");
const conflict     = (msg, extra)       => new HttpError(409, "SLOT_TAKEN", msg, extra);
const invalid      = (errors)           => new HttpError(422, "VALIDATION_FAILED", "Some details need correcting.", { errors });

/** Window-bounded active sessions — all the calendar ever needs. */
async function windowSessions(){
  const W = D.windowDates();
  return repo.activeSessionsInRange(W[0], W[W.length - 1]);
}

async function upcomingPublished(now = new Date()){
  const all = await repo.publishedUpcoming();
  return all.filter(s => D.slotDateTime(s.date, s.slot) > now);
}

async function requireAdmin(req){
  const admin = await auth.currentAdmin(req);
  if (!admin) throw unauthorized();
  return admin;
}

/* ============================================================ public routes */

async function getCalendar(){
  const sessions = await windowSessions();
  return {
    days: D.buildCalendar(sessions),
    availableCount: D.availableCount(sessions),
    windowDays: D.WINDOW_DAYS,
    slots: D.SLOTS.map(s => ({ id: s.id, label: s.label }))
  };
}

async function getPublishedList(){
  return { sessions: (await upcomingPublished()).map(publicSession) };
}

async function getBootstrap(req){
  const admin = await auth.currentAdmin(req);
  const [calendar, list] = await Promise.all([getCalendar(), getPublishedList()]);
  return {
    calendar,
    sessions: list.sessions,
    admin: admin ? { email: admin.email } : null,
    demoRoutes: DEMO_ROUTES_ENABLED,
    storage: repo.backend,
    serverTime: new Date().toISOString()
  };
}

/** FR-009 / P0-007. */
async function getSession(id){
  const s = await repo.sessionById(id);
  if (!s || s.status !== D.STATUS.PUBLISHED){
    throw notFound("This session is not available. It may have been cancelled.");
  }
  return { session: publicSession(s) };     // no meeting link — P0-008
}

/**
 * FR-004 / FR-005 / P0-001 / P0-004 / P0-005.
 *
 * Validation and the window/passed rules are checked here so the speaker gets
 * a precise message. Whether the slot is still free is NOT decided here — the
 * insert is, and the unique index arbitrates. That is what makes this correct
 * under concurrency and across multiple instances.
 */
async function createNomination(body){
  const { errors, value } = D.validateNomination(body);
  if (Object.keys(errors).length) throw invalid(errors);

  if (!D.inWindow(value.date)){
    throw conflict("That date is outside the seven-day booking window.", { slotState: "OUT_OF_WINDOW" });
  }
  if (D.hasPassed(value.date, value.slot)){
    throw conflict("That time has already passed. Please choose another slot.", { slotState: "PASSED" });
  }

  const result = await repo.insertSession({
    id: uid(), date: value.date, slot: value.slot,
    status: D.STATUS.RESERVED,                                  // RULE-004
    topic: value.topic, description: value.description,
    speakerName: value.speakerName, speakerPhone: value.speakerPhone,
    speakerEmail: value.speakerEmail, meetingLink: value.meetingLink,
    source: "speaker"
  });

  if (!result.ok){
    throw conflict("This slot was just reserved by another speaker. Please choose another available slot.",
                   { slotState: "TAKEN" });
  }
  return { session: publicSession(result.session) };
}

/** The speaker's own confirmation view. Never includes the meeting link. */
async function getNomination(id){
  const s = await repo.sessionById(id);
  if (!s) throw notFound("That nomination could not be found.");
  return { session: publicSession(s) };
}

/** FR-010 / FR-012 / P0-009 — the one route that returns a meeting link. */
async function registerParticipant(id, body){
  const { errors, value } = D.validateRegistration(body);
  if (Object.keys(errors).length) throw invalid(errors);

  const s = await repo.sessionById(id);
  if (!s || s.status !== D.STATUS.PUBLISHED){
    throw notFound("This session is not available for registration.");
  }
  const registration = { id: uid(), sessionId: s.id, participantName: value.participantName };
  await repo.addRegistration(registration);
  return {
    registration: { id: registration.id, participantName: registration.participantName },
    session: registeredSession(s)            // link revealed only now — RULE-011
  };
}

/* ============================================================= admin routes */

async function adminLogin(req, body, res){
  const result = await auth.login(req, body && body.email, body && body.password);
  if (result.rateLimited){
    throw new HttpError(429, "RATE_LIMITED",
      `Too many failed sign-in attempts. Try again in ${result.retryAfterMinutes} minutes.`);
  }
  if (!result.ok){
    throw new HttpError(401, "BAD_CREDENTIALS", "Incorrect email or password.",
      result.attemptsRemaining != null ? { attemptsRemaining: result.attemptsRemaining } : {});
  }
  res.setHeader("Set-Cookie", auth.sessionCookie(result.token));
  return { admin: { email: auth.ADMIN_EMAIL } };
}

async function adminLogout(req, res){
  await auth.logout(req);
  res.setHeader("Set-Cookie", auth.clearCookie());
  return { ok: true };
}

async function adminMe(req){
  const admin = await auth.currentAdmin(req);
  return { admin: admin ? { email: admin.email } : null };
}

async function adminDashboard(req){
  await requireAdmin(req);
  const [pending, published, counts, sessions] = await Promise.all([
    repo.pendingSessions(), upcomingPublished(), repo.registrationCounts(), windowSessions()
  ]);
  return {
    pending:   pending.map(s => adminSession(s)),
    published: published.map(s => adminSession(s, { registrations: counts[s.id] || 0 })),
    availableCount: D.availableCount(sessions),
    storage: repo.backend
  };
}

async function adminGetSession(req, id){
  await requireAdmin(req);
  const s = await repo.sessionById(id);
  if (!s) throw notFound("That session could not be found.");
  return { session: adminSession(s, { registrations: await repo.registrationCount(id) }) };
}

/** FR-007 / P0-011 — compare-and-set, so a double click cannot double-apply. */
async function adminApprove(req, id){
  await requireAdmin(req);
  const updated = await repo.transition(id, D.STATUS.RESERVED, D.STATUS.PUBLISHED);
  if (!updated){
    const s = await repo.sessionById(id);
    if (!s) throw notFound("That nomination could not be found.");
    throw badRequest("INVALID_TRANSITION",
      `Only a reserved nomination can be approved. This one is ${s.status.toLowerCase()}.`);
  }
  return { session: adminSession(updated) };
}

/** FR-008 / FR-014 / P0-012 — releases the slot via the partial index. */
async function adminReject(req, id){
  await requireAdmin(req);
  const updated = await repo.transition(id, D.STATUS.RESERVED, D.STATUS.REJECTED);
  if (!updated){
    const s = await repo.sessionById(id);
    if (!s) throw notFound("That nomination could not be found.");
    throw badRequest("INVALID_TRANSITION",
      `Only a reserved nomination can be rejected. This one is ${s.status.toLowerCase()}.`);
  }
  return { session: adminSession(updated), slotState: "AVAILABLE" };
}

/** FR-013 / FR-014 / P0-013. */
async function adminCancel(req, id){
  await requireAdmin(req);
  const updated = await repo.transition(id, D.STATUS.PUBLISHED, D.STATUS.CANCELLED);
  if (!updated){
    const s = await repo.sessionById(id);
    if (!s) throw notFound("That session could not be found.");
    throw badRequest("INVALID_TRANSITION",
      `Only a published session can be cancelled. This one is ${s.status.toLowerCase()}.`);
  }
  return { session: adminSession(updated), slotState: "AVAILABLE" };
}

/** FR-015 / RULE-014 — same slot rules, enforced by the same index. */
async function adminCreate(req, body){
  await requireAdmin(req);
  const { errors, value } = D.validateNomination(body, { requirePhone: false });
  if (Object.keys(errors).length) throw invalid(errors);

  if (!D.inWindow(value.date)){
    throw conflict("That date is outside the seven-day booking window.", { slotState: "OUT_OF_WINDOW" });
  }
  if (D.hasPassed(value.date, value.slot)){
    throw conflict("That slot is not available — it is passed. Choose another slot.", { slotState: "PASSED" });
  }

  const result = await repo.insertSession({
    id: uid(), date: value.date, slot: value.slot,
    status: D.STATUS.PUBLISHED,
    topic: value.topic, description: value.description,
    speakerName: value.speakerName, speakerPhone: value.speakerPhone,
    speakerEmail: value.speakerEmail, meetingLink: value.meetingLink,
    source: "admin"
  });
  if (!result.ok){
    throw conflict("That slot is not available — it is already taken. Choose another slot.",
                   { slotState: "TAKEN" });
  }
  return { session: adminSession(result.session) };
}

/* ============================================================== demo routes */
function requireDemo(){
  if (!DEMO_ROUTES_ENABLED) throw notFound("Demo routes are disabled.");
}
async function demoReset(){
  requireDemo();
  await repo._resetAll();
  await repo.seedIfEmpty(() => require("./seed").demoSessions());
  return { ok: true, calendar: await getCalendar() };
}
async function demoFillSlots(){
  requireDemo();
  const sessions = await windowSessions();
  for (const date of D.windowDates()){
    for (const meta of D.SLOTS){
      if (D.slotState(sessions, date, meta.id) === "AVAILABLE"){
        const r = await repo.insertSession({
          id: uid(), date, slot: meta.id, status: D.STATUS.RESERVED,
          topic: "Placeholder nomination", description: "",
          speakerName: "Demo Speaker", speakerPhone: "+91 90000 00000", speakerEmail: "",
          meetingLink: "https://meet.google.com/demo-fill-slot", source: "speaker"
        });
        if (r.ok) sessions.push(r.session);
      }
    }
  }
  return { ok: true };
}
async function demoClearPublished(){
  requireDemo();
  for (const s of await repo.publishedUpcoming()){
    await repo.transition(s.id, D.STATUS.PUBLISHED, D.STATUS.CANCELLED);
  }
  return { ok: true };
}

module.exports = {
  HttpError, DEMO_ROUTES_ENABLED,
  getBootstrap, getCalendar, getPublishedList, getSession,
  createNomination, getNomination, registerParticipant,
  adminLogin, adminLogout, adminMe, adminDashboard, adminGetSession,
  adminApprove, adminReject, adminCancel, adminCreate,
  demoReset, demoFillSlots, demoClearPublished,
  upcomingPublished
};
