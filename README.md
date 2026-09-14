# TrainerHub — Phase 3

A real server and HTTP API implementing **PRD v0.1** and **Product & UX Specification v0.1 + Critical TDD**.
Same fifteen screens and same behaviour as the Phase 1 prototype — but the product rules now live on the
server, and the browser holds no truth.

Node 18+. One dependency (`pg`). Data lives in Postgres.

```bash
npm install
node server.js          # http://127.0.0.1:3000  (file store, for local dev)
npm test                # 80 tests: 43 API + 25 client-render + 12 db contract
DATABASE_URL='postgres://...' npm run test:pg    # against a real database
```

**Going live? See [NEON-SETUP.md](NEON-SETUP.md).** In production the app
refuses to start without `DATABASE_URL`, because a file store on Render loses
every booking when the service spins down.

Admin sign-in: `admin@trainerhub.app` / `admin123`

**Deploying this for testers? See [DEPLOY.md](DEPLOY.md).** Set a real
`TRAINERHUB_ADMIN_PASSWORD` first — with `NODE_ENV=production` the server refuses to
start on the default password, because it is published right here.

---

## What changed from Phase 1, and why it matters

Phase 1 was an honest prototype: every rule was enforced in the browser, which means none of them were
really enforced at all. Phase 2 closes three specific holes.

| | Phase 1 | Phase 2 |
|---|---|---|
| **Meeting-link privacy** (FR-011, P0-008) | Link absent from the rendered UI, but the whole mock dataset shipped to the browser — readable from memory | The link is never serialised into any public response. It exists in exactly one response body: the reply to a participant's own registration |
| **Slot uniqueness** (FR-003, P0-001) | Check-then-write in one browser tab. Two users racing would both win | Re-checked inside the server write path. The suite fires 12 simultaneous nominations at one slot and asserts exactly one wins |
| **Admin authorisation** (P0-010) | A boolean in browser memory | Salted scrypt credential check, random session token in an httpOnly cookie, verified server-side on every admin route. Forged cookies get 401 |

---

## Architecture

```
server.js              HTTP server, routing, static files
src/domain.js          The product rules. Slot engine, 7-day window, validation
src/store.js           JSON file persistence with atomic writes
src/serialize.js       The privacy boundary — see below
src/api.js             Endpoint handlers, lifecycle transitions, admin guard
public/index.html      App shell
public/app.js          Client. Renders; owns no product state
public/styles.css      Kinetic Clarity design system
test/acceptance.js     43 API tests over real HTTP
test/ui-render.js      25 client tests — real views, real API, DOM shim
```

### The privacy boundary

`src/serialize.js` is the only place a session row becomes an API response, and each serialiser builds a
fresh object from an explicit field list rather than spreading the row:

- `publicSession()` — omits `meetingLink`, `speakerPhone`, `speakerEmail`
- `registeredSession()` — adds the link. Called from one place: a successful registration
- `adminSession()` — full row, behind the auth guard

Leaking the link would require a deliberate edit to that file. It cannot happen by someone adding a field
to a session row somewhere else.

### Why the concurrency fix works (Phase 3)

The database decides, not the application:

```sql
CREATE UNIQUE INDEX sessions_active_slot_uniq
  ON sessions (session_date, slot)
  WHERE status IN ('RESERVED', 'PUBLISHED');
```

Claiming a slot is an INSERT. If another request already holds it, Postgres raises a unique violation
which becomes the existing `409 SLOT_TAKEN`. Rejected and cancelled rows sit outside the index, so
releasing a slot is genuinely releasing it while the history is kept. **This holds across any number of
instances** — the Phase 2 single-process caveat is gone.

### Storage backends

`src/repo.js` picks one: Postgres when `DATABASE_URL` is set, otherwise a local JSON file for
development and tests. Everything above it — `api.js`, `domain.js`, `serialize.js`, the client — is
identical either way, which is how the 68 pre-existing tests still prove the migration changed no
behaviour.

---

## API reference

### Public

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/bootstrap` | Calendar + published sessions + admin state |
| `GET` | `/api/calendar` | 7-day grid: `AVAILABLE` / `RESERVED` / `PUBLISHED` / `PASSED` |
| `GET` | `/api/sessions` | Published sessions only. No links |
| `GET` | `/api/sessions/:id` | One published session. 404 if reserved or cancelled |
| `POST` | `/api/nominations` | Creates a nomination → `RESERVED`. `409` if taken, `422` if invalid |
| `GET` | `/api/nominations/:id` | The speaker's own confirmation view |
| `POST` | `/api/sessions/:id/register` | `{ participantName }` → **returns the meeting link** |

### Admin — all require a valid session cookie, all return `401` without one

| Method | Path |
|---|---|
| `POST` | `/api/admin/login` · `/api/admin/logout` |
| `GET` | `/api/admin/me` · `/api/admin/dashboard` · `/api/admin/sessions/:id` |
| `POST` | `/api/admin/sessions/:id/approve` · `/reject` · `/cancel` |
| `POST` | `/api/admin/sessions` — manual creation, publishes immediately |

### Demo routes

`POST /api/demo/reset` · `/fill-slots` · `/clear-published` — prototype affordances for demonstrating the
error and empty states the spec requires. **Not product features.** On by default locally; **off by default
in production** (opt in with `TRAINERHUB_DEMO=on`), because any visitor could otherwise wipe the data.

### Error shape

```json
{ "error": "SLOT_TAKEN", "message": "This slot was just reserved by another speaker...", "slotState": "RESERVED" }
```

Codes: `VALIDATION_FAILED` (422, with a per-field `errors` object) · `SLOT_TAKEN` (409) ·
`UNAUTHORIZED` (401) · `BAD_CREDENTIALS` (401) · `NOT_FOUND` (404) · `INVALID_TRANSITION` (400)

---

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `127.0.0.1`, or `0.0.0.0` when `NODE_ENV=production` | Rarely needs setting; leave unset on a PaaS |
| `TRAINERHUB_ADMIN_EMAIL` | `admin@trainerhub.app` | |
| `TRAINERHUB_ADMIN_PASSWORD` | `admin123` | **Change this before exposing the server** |
| `TRAINERHUB_DATA_DIR` | `./data` | |
| `TRAINERHUB_DEMO` | `on` locally, **`off` in production** | `on` to opt in; anyone can reset the data, so keep it off on a shared URL |
| `TRAINERHUB_SECURE_COOKIES` | auto (on when `NODE_ENV=production`) | `0` to allow the session cookie over plain HTTP |
| `NODE_ENV` | — | `production` binds `0.0.0.0`, enables Secure cookies, disables demo routes, and enforces the password guard |

---

## Tests

`npm test` runs both suites. They start their own server on a throwaway port and temp data directory, so
they never touch your running instance or its data.

**`test/acceptance.js`** — 43 assertions over real HTTP. All 14 P0s, plus: the 12-way concurrency race,
12 invalid-nomination cases, a link-leakage scan across every public endpoint *and* the served HTML and
JS bundle, forged-cookie rejection, double-approval refusal, malformed JSON, and wrong HTTP verbs.

**`test/ui-render.js`** — loads the real `public/app.js` in a DOM shim pointed at a live server and
inspects the HTML each view produces. This catches what the API suite structurally cannot: a view reading
a field the serialiser does not send. It drives the genuine submit handlers, so the nomination and
registration it performs are real POSTs.

---

## Known limitations — what Phase 3 is for

Honest list. None of these are bugs; they are the boundary of "a real server, single process, file store".

- **Single-process concurrency only.** The slot guarantee comes from Node's single-threaded handler model.
  Run two instances against one data file and the race returns. Phase 3 needs a unique database constraint
  on `(date, slot)` for occupying statuses — the guarantee belongs in the database, not the runtime.
- **One hard-coded administrator.** No user table, no roles, no password reset.
- **Sessions are in memory.** Restarting the server signs admins out.
- **No rate limiting** on login or nomination. A determined attacker can brute-force the password or flood
  nominations.
- **No CSRF token.** `SameSite=Strict` on the session cookie is the only mitigation; adequate for a
  single-origin demo, not for production.
- **JSON file store.** Fine for a demo; no transactions, no indexes, no concurrent-writer safety.
- **Participant registrations are anonymous rows.** No dedupe, so one person can register repeatedly.
- **HTTP only.** Terminate TLS in front of it before exposing it anywhere — Render and Cloudflare Tunnel both do this for you (see DEPLOY.md).

---

## Traceability

| Requirement | Enforced in | Test |
|---|---|---|
| FR-001, FR-002 | `domain.buildCalendar` | P0-002 |
| FR-003 | `api.createNomination` inside `store.mutate` | P0-001, P0-001b |
| FR-004, FR-005, FR-006 | `api.createNomination`, `domain.validateNomination` | P0-004, P0-005 |
| FR-007, FR-008 | `api.adminApprove`, `api.adminReject` | P0-011, P0-012 |
| FR-009 | `api.publishedSessions` | P0-007 |
| FR-010, FR-012 | `api.registerParticipant` | P0-009 |
| FR-011 | `serialize.publicSession` | P0-008, P0-008b, P0-008c |
| FR-013, FR-014 | `api.adminCancel` | P0-013 |
| FR-015 | `api.adminCreate` | FR-015, FR-015b |
| RULE-007 | `auth.currentAdmin` | P0-010, P0-010b/c/d |
