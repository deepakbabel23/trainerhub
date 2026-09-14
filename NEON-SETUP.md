# Going live with Neon Postgres

TrainerHub Phase 3. Real trainers, real bookings, data that persists.

**Total time: about 10 minutes.** You do steps 1–3; the app does the rest.

---

## Why Postgres and not Upstash Redis

Not a style preference. The slot-uniqueness guarantee is the hardest thing in
this product, and Postgres lets the *database* enforce it:

```sql
CREATE UNIQUE INDEX sessions_active_slot_uniq
  ON sessions (session_date, slot)
  WHERE status IN ('RESERVED', 'PUBLISHED');
```

Two trainers clicking the same 7 PM slot in the same second cannot both win —
one insert succeeds, the other gets a unique violation that becomes the
existing `409 SLOT_TAKEN`. No application lock, no race, no matter how many
instances run.

In Redis the same guarantee is a hand-rolled `SET NX` lock you have to get
right and keep right. And bookings are relational data you will want to query:
who taught what, how many registered, which slots go unused.

---

## Step 1 — Create the Neon database

1. Sign up at **neon.tech** (free tier, no card)
2. **Create project** — name it `trainerhub`, pick the region closest to your
   Render service (Render's default is Oregon / US West; Singapore or Mumbai is
   better if your Render region is Singapore)
3. On the dashboard, click **Connect** and copy the connection string. It looks
   like:

```
postgresql://neondb_owner:XXXXXXXX@ep-something-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

**Keep `?sslmode=require`.** Neon needs TLS and the app expects it.

> Region matters more than it looks. Every query is a round trip, so a Render
> service in Oregon talking to a Neon database in Mumbai adds ~200ms to each
> one. Put them on the same continent.

---

## Step 2 — Add it to Render

Render → your service → **Environment** → add:

| Key | Value |
|---|---|
| `DATABASE_URL` | the connection string from step 1 |

Keep everything you already have: `NODE_ENV=production`,
`TRAINERHUB_ADMIN_EMAIL`, `TRAINERHUB_ADMIN_PASSWORD`, `TZ=Asia/Kolkata`.

Confirm the build command is `npm install` — Phase 3 has a real dependency now
(`pg`), so the install step actually does something.

---

## Step 3 — Deploy

The app creates its own tables on boot. No migration command to run.

Watch the log for:

```
Storage: postgres (0 sessions)
TrainerHub Phase 3 listening on 0.0.0.0:10000 (production)
Secure cookies ON — the session cookie requires HTTPS.
Demo routes disabled.
```

`Storage: postgres` is the line that matters. If it says `file`, the
`DATABASE_URL` did not reach the process.

If `DATABASE_URL` is missing entirely in production, **the app refuses to
start** and tells you why — rather than quietly storing real bookings in a file
Render deletes a few times a day.

---

## Step 4 — Verify (recommended)

```bash
npm run verify -- https://your-app.onrender.com --email you@x.com --password 'your-password'
```

And the database-specific suite, from your machine:

```bash
npm install
DATABASE_URL='postgresql://...' npm run test:pg
```

That one proves the parts only a real database can: 20 genuinely concurrent
inserts where exactly one wins, rejection and cancellation actually freeing the
slot, and bookings surviving every connection being dropped.

It refuses to run against a database that already holds sessions unless you
pass `--allow-dirty`, so you cannot accidentally point it at live data.

---

## What changed, and what it means for you

| | Phase 2 (file) | Phase 3 (Postgres) |
|---|---|---|
| Bookings survive a spin-down | ❌ lost | ✅ persist |
| Bookings survive a redeploy | ❌ lost | ✅ persist |
| Admin stays signed in across a restart | ❌ signed out | ✅ stays in |
| Two trainers race for one slot | safe on one instance only | ✅ safe, enforced by the database |
| Demo data | reseeded daily | never — seeds only into an empty database |
| Login brute force | unthrottled | ✅ 8 attempts / 15 min per IP |
| Scale past one instance | would double-book | ✅ safe |

**The daily reseed is gone.** In Phase 2 the app rebuilt demo data whenever the
date changed. That was right for a throwaway demo and would have deleted real
bookings every midnight. Seeding now happens only into a completely empty
database, and only when you ask for it with `TRAINERHUB_SEED=demo`.

---

## Free tier limits, honestly

**Neon free:** 0.5 GB storage, one project. A booking row is well under 1 KB —
two slots a day is ~730 rows a year, so storage is a non-issue for years.

**Neon autosuspends** an idle database after ~5 minutes. The first query after
that takes an extra ~500ms while it wakes. Combined with Render's own 15-minute
spin-down, a first visitor after a quiet period may wait a couple of seconds.
Both wake automatically; nothing is lost.

**Render free** still spins down after 15 minutes — but now that only costs a
cold start, not your data. That was the whole point.

---

## Backups

Neon's free tier keeps a short restore window (currently ~6 hours of
point-in-time recovery). For a system holding real bookings that is thin.

Cheap insurance, run from anywhere with `psql`:

```bash
pg_dump "$DATABASE_URL" > trainerhub-$(date +%F).sql
```

Worth doing weekly, or on a schedule, once trainers depend on it.

---

## Still open before you would call this production-grade

Stated plainly rather than buried:

- **One administrator, one shared password.** No user accounts, no roles, no
  password reset. Fine while you are the only admin; not fine for a team.
- **No CSRF token.** `SameSite=Strict` on the session cookie is the only
  defence. Adequate for a single-origin app, not a substitute for a token.
- **Meeting links are stored in plain text.** Anyone with database access can
  read them. Same for trainer phone numbers and emails.
- **You are now holding personal data** — trainer names, phone numbers,
  emails, participant names. Decide who may access it, how long you keep it,
  and how someone asks for deletion. There is no retention policy in the code.
- **No audit trail.** You can see a session's current status, but not who
  approved it or when it changed hands.

None of these block a launch to trainers you know. All of them matter before
this is open to strangers.
