"use strict";
/* ============================================================================
   TrainerHub — Phase 2 server
   Zero dependencies. Node 18+.   Run:  node server.js
   ========================================================================== */

const http = require("http");
const fs   = require("fs");
const path = require("path");

const api   = require("./src/api");
const auth  = require("./src/auth");
const repo  = require("./src/repo");
const seed  = require("./src/seed");

const PORT = Number(process.env.PORT || 3000);
/* Containers and PaaS platforms route traffic to the container's external
   interface, so a production process bound to 127.0.0.1 accepts nothing and
   the platform reports "no open ports". Bind wide in production, narrow
   locally so a dev server is not exposed to the local network by accident. */
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 64 * 1024;            // nothing this API accepts is large

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon"
};

/* ------------------------------------------------------------------ utils */
function sendJson(res, status, payload){
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendError(res, err){
  if (err && err.status){
    return sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
  }
  console.error("[server] unhandled:", err);
  return sendJson(res, 500, { error: "INTERNAL", message: "Something went wrong on our end." });
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY){ reject(new api.HttpError(413, "TOO_LARGE", "Request body too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new api.HttpError(400, "BAD_JSON", "Request body must be valid JSON.")); }
    });
    req.on("error", reject);
  });
}

/* -------------------------------------------------------------- static files */
function serveStatic(req, res, urlPath){
  // Single-page app: unknown non-API paths fall through to index.html so the
  // client router can handle them.
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!resolved.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "FORBIDDEN" });

  fs.readFile(resolved, (err, data) => {
    if (err){
      if (path.extname(resolved)) return sendJson(res, 404, { error: "NOT_FOUND" });
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) return sendJson(res, 404, { error: "NOT_FOUND" });
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(html);
      });
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ router */
const ROUTES = [
  // platform health check
  /* Liveness. Deliberately does NOT touch the database.
     Render polls this continuously while the service is awake. If it queried
     Postgres, it would hold Neon's compute open around the clock and burn
     through the free plan's 100 CU-hours mid-month — at which point Neon
     suspends compute and the app cannot connect at all. Liveness answers
     "is the process up"; readiness answers "can it reach its database". */
  ["GET",  /^\/api\/healthz$/,                      ()             => ({ ok: true, storage: repo.backend, uptime: Math.round(process.uptime()) })],
  /* Readiness. Actually queries the database — use it for verification, never
     as a monitoring endpoint you poll on a schedule. */
  ["GET",  /^\/api\/readyz$/,                       async ()       => {
     const ok = await repo.healthy();
     if (!ok) throw new api.HttpError(503, "NOT_READY", "The database is not reachable.");
     return { ok: true, storage: repo.backend, uptime: Math.round(process.uptime()) };
  }],
  // public
  ["GET",  /^\/api\/bootstrap$/,                    (req)          => api.getBootstrap(req)],
  ["GET",  /^\/api\/calendar$/,                     ()             => api.getCalendar()],
  ["GET",  /^\/api\/sessions$/,                     ()             => api.getPublishedList()],
  ["GET",  /^\/api\/sessions\/([\w-]+)$/,           (req,res,m)    => api.getSession(m[1])],
  ["POST", /^\/api\/nominations$/,                  (req,res,m,b)  => api.createNomination(b)],
  ["GET",  /^\/api\/nominations\/([\w-]+)$/,        (req,res,m)    => api.getNomination(m[1])],
  ["POST", /^\/api\/sessions\/([\w-]+)\/register$/, (req,res,m,b)  => api.registerParticipant(m[1], b)],

  // admin
  ["POST", /^\/api\/admin\/login$/,                 (req,res,m,b)  => api.adminLogin(req, b, res)],
  ["POST", /^\/api\/admin\/logout$/,                (req,res)      => api.adminLogout(req, res)],
  ["GET",  /^\/api\/admin\/me$/,                    (req)          => api.adminMe(req)],
  ["GET",  /^\/api\/admin\/dashboard$/,             (req)          => api.adminDashboard(req)],
  ["GET",  /^\/api\/admin\/sessions\/([\w-]+)$/,    (req,res,m)    => api.adminGetSession(req, m[1])],
  ["POST", /^\/api\/admin\/sessions\/([\w-]+)\/approve$/, (req,res,m) => api.adminApprove(req, m[1])],
  ["POST", /^\/api\/admin\/sessions\/([\w-]+)\/reject$/,  (req,res,m) => api.adminReject(req, m[1])],
  ["POST", /^\/api\/admin\/sessions\/([\w-]+)\/cancel$/,  (req,res,m) => api.adminCancel(req, m[1])],
  ["POST", /^\/api\/admin\/sessions$/,              (req,res,m,b)  => api.adminCreate(req, b)],

  // demo affordances
  ["POST", /^\/api\/demo\/reset$/,                  ()             => api.demoReset()],
  ["POST", /^\/api\/demo\/fill-slots$/,             ()             => api.demoFillSlots()],
  ["POST", /^\/api\/demo\/clear-published$/,        ()             => api.demoClearPublished()]
];

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { return sendJson(res, 400, { error: "BAD_URL" }); }

  if (!urlPath.startsWith("/api/")) return serveStatic(req, res, urlPath);

  // Match the path first so a wrong verb reports 405 rather than 404.
  const pathMatches = ROUTES.filter(([, re]) => re.test(urlPath));
  if (!pathMatches.length) return sendJson(res, 404, { error: "NOT_FOUND", message: "No such endpoint." });

  const route = pathMatches.find(([method]) => method === req.method);
  if (!route){
    res.setHeader("Allow", pathMatches.map(([m]) => m).join(", "));
    return sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: `Use ${pathMatches.map(([m]) => m).join(" or ")}.` });
  }

  try {
    const [, re, handler] = route;
    const m = re.exec(urlPath);
    const body = req.method === "POST" ? await readBody(req) : {};
    const payload = await handler(req, res, m, body);
    sendJson(res, req.method === "POST" && /nominations$|admin\/sessions$/.test(urlPath) ? 201 : 200, payload);
  } catch (err){
    sendError(res, err);
  }
});

if (require.main === module){
  /* Boot guard: never let a publicly deployed instance run with the password
     that is printed in the README. Failing to start is the right behaviour —
     a deployment that silently ships a known admin password is worse than one
     that refuses to come up with a clear message. */
  if (IS_PRODUCTION && auth.USING_DEFAULT_PASSWORD){
    console.error(`
┌───────────────────────────────────────────────────────────────┐
│  REFUSING TO START                                            │
│                                                               │
│  NODE_ENV=production but TRAINERHUB_ADMIN_PASSWORD is still   │
│  the default demo password, which is published in the README. │
│  Anyone could sign in as an administrator.                    │
│                                                               │
│  Set TRAINERHUB_ADMIN_PASSWORD to something private, then     │
│  redeploy. To override deliberately (do not do this on a      │
│  public URL), set TRAINERHUB_ALLOW_DEFAULT_PASSWORD=1.        │
└───────────────────────────────────────────────────────────────┘
`);
    if (process.env.TRAINERHUB_ALLOW_DEFAULT_PASSWORD !== "1") process.exit(1);
  }

  repo.assertProductionSafe();

  (async () => {
    try {
      const info = await repo.init();
      console.log(`Storage: ${info.backend}${info.sessionCount != null ? ` (${info.sessionCount} sessions)` : ""}`);
      if (seed.seedRequested()){
        const r = await repo.seedIfEmpty(() => seed.demoSessions());
        console.log(r.seeded
          ? `Seeded ${r.count} demo sessions into an empty store.`
          : `Seed skipped — store already holds ${r.existing} sessions.`);
      }
    } catch (err){
      console.error("\nFAILED TO INITIALISE STORAGE:", err.message);
      console.error("The server will not start without working storage.\n");
      process.exit(1);
    }

    server.listen(PORT, HOST, () => {
      console.log(`TrainerHub Phase 3 listening on ${HOST}:${PORT}${IS_PRODUCTION ? " (production)" : ""}`);
      console.log(`Admin email: ${auth.ADMIN_EMAIL}`);
      if (!IS_PRODUCTION && auth.USING_DEFAULT_PASSWORD) console.log(`Admin password: admin123 (demo default)`);
      if (auth.SECURE_COOKIES) console.log("Secure cookies ON — the session cookie requires HTTPS.");
      console.log(`Login rate limit: ${auth.MAX_FAILED_ATTEMPTS} failures per ${auth.ATTEMPT_WINDOW_MIN} min per IP.`);
      console.log(api.DEMO_ROUTES_ENABLED
        ? "Demo routes ENABLED. Anyone can reset the data — keep them off on a shared URL."
        : "Demo routes disabled.");
    });
  })();

  // Platforms send SIGTERM on redeploy; close cleanly so the last write lands.
  for (const sig of ["SIGTERM", "SIGINT"]){
    process.on(sig, () => {
      console.log(`\n${sig} received — shutting down.`);
      server.close(async () => { try { await repo.close(); } catch {} process.exit(0); });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = { server, PORT, HOST };
