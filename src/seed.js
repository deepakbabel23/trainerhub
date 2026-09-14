"use strict";
/* ============================================================================
   TrainerHub — demo seed data (Phase 3)

   Only ever inserted into an EMPTY store, and only when explicitly requested
   with TRAINERHUB_SEED=demo.

   Phase 2 reseeded whenever the stored date changed, which kept an ephemeral
   demo looking right. Against a real database that same logic would delete
   every real booking at midnight. It is gone.
   ========================================================================== */

const crypto = require("crypto");
const D = require("./domain");

const uid = () => crypto.randomBytes(6).toString("hex");

function demoSessions(now = new Date()){
  const W = D.windowDates(now);
  const mk = (date, slot, status, topic, description, name, phone, email, link) => ({
    id: uid(), date, slot, status, topic, description,
    speakerName: name, speakerPhone: phone, speakerEmail: email || "",
    meetingLink: link, source: "speaker"
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

/** Should demo data be planted on boot? */
function seedRequested(){
  if (process.env.TRAINERHUB_SEED === "demo") return true;
  if (process.env.TRAINERHUB_SEED === "off")  return false;
  // Default: seed only outside production, so a dev machine is useful
  // immediately and a live database is never polluted by accident.
  return process.env.NODE_ENV !== "production";
}

module.exports = { demoSessions, seedRequested };
