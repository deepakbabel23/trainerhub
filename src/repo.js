"use strict";
/* ============================================================================
   TrainerHub — repository selector (Phase 3)

   One line decides where data lives: if DATABASE_URL is set, Postgres;
   otherwise the local JSON file.

   Everything above this file — api.js, domain.js, serialize.js, the client —
   is identical either way. That is the point: the storage migration is
   confined to this directory, which is why the existing test suite still
   proves the behaviour above it is unchanged.
   ========================================================================== */

const db = require("./db");

const impl = db.isEnabled() ? require("./repo-pg") : require("./repo-file");

/* Production must not run on the file backend — it loses every booking on
   restart, and on a free tier that happens several times a day. */
function assertProductionSafe(){
  if (process.env.NODE_ENV === "production" && impl.backend === "file"){
    console.error(`
┌───────────────────────────────────────────────────────────────┐
│  REFUSING TO START                                            │
│                                                               │
│  NODE_ENV=production but DATABASE_URL is not set, so          │
│  TrainerHub would store bookings in a local file. On Render   │
│  that file is deleted every time the service restarts or      │
│  spins down — real nominations would silently disappear.      │
│                                                               │
│  Set DATABASE_URL to your Neon connection string.             │
│  To override deliberately (data WILL be lost), set            │
│  TRAINERHUB_ALLOW_FILE_STORE=1.                               │
└───────────────────────────────────────────────────────────────┘
`);
    if (process.env.TRAINERHUB_ALLOW_FILE_STORE !== "1") process.exit(1);
  }
}

module.exports = new Proxy(impl, {
  get(target, prop){
    if (prop === "assertProductionSafe") return assertProductionSafe;
    return target[prop];
  }
});
