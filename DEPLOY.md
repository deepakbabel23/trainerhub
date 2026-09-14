# Deploying TrainerHub Phase 2

Two paths. Pick by how long the URL needs to live.

| | **Render** (recommended) | **Cloudflare Tunnel** |
|---|---|---|
| Time to a live URL | ~10 min, once | ~2 min |
| Lives on after you close your laptop | Yes | No |
| Account needed | Free Render + GitHub | None |
| HTTPS | Yes, automatic | Yes, automatic |
| Good for | A tester link you share for days | One live session this afternoon |

---

## Before either path: one non-negotiable

**Change the admin password.** `admin123` is printed in the README, so anyone who
finds your URL could approve, reject and cancel sessions.

The server enforces this for you: with `NODE_ENV=production` and the default
password still set, **it refuses to start** and tells you why. That is deliberate —
a deployment that silently ships a known admin password is worse than one that
won't come up.

---

## Path A — Render (a durable tester URL)

### 1. Get the code into GitHub

```bash
cd trainerhub-p2
git init && git add -A
git commit -m "TrainerHub Phase 2"
```

Create an empty repo on github.com (private is fine), then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/trainerhub.git
git branch -M main && git push -u origin main
```

`.gitignore` already excludes `data/` and `.env`, so no local test data or secrets ship.

### 2. Create the service

1. Sign in at **render.com** → **New** → **Web Service**
2. Connect your GitHub account and pick the repo
3. Render auto-detects Node. Confirm these:

| Field | Value |
|---|---|
| Runtime | Node |
| Build command | *(leave empty — there are no dependencies to install)* |
| Start command | `node server.js` |
| Instance type | Free |
| Health check path | `/api/healthz` |

### 3. Set the environment variables

Under **Environment**, add:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRAINERHUB_ADMIN_EMAIL` | your email |
| `TRAINERHUB_ADMIN_PASSWORD` | something private |

Do **not** set `HOST` or `PORT` — the server reads Render's port automatically and
binds `0.0.0.0` on its own when `NODE_ENV=production`.

### 4. Deploy

Click **Create Web Service**. You get `https://trainerhub-xxxx.onrender.com`.
Watch the log for:

```
TrainerHub Phase 2 listening on 0.0.0.0:10000 (production)
Secure cookies ON — the session cookie requires HTTPS.
Demo routes disabled.
```

If instead you see the `REFUSING TO START` banner, the password variable did not
take — set it and redeploy.

### 5. Smoke-test before sharing

```bash
curl https://YOUR-URL.onrender.com/api/healthz          # {"ok":true,...}
curl https://YOUR-URL.onrender.com/api/sessions         # published sessions, no links
curl -i https://YOUR-URL.onrender.com/api/admin/dashboard   # must be 401
```

Then open it, sign in with your new password, and run one nomination end to end.

### Two Render free-tier behaviours to plan around

**It sleeps after 15 minutes idle.** The next visitor waits ~30–60s for a cold
start. It will not sleep mid-session while testers are active, but the *first*
tester of the day hits the delay. Open the URL yourself a minute before a session
starts to warm it.

**The disk is ephemeral.** On sleep or redeploy, `data/trainerhub.json` is lost and
the demo data reseeds. For a usability round that is usually fine — you want a
clean slate per tester anyway. If you need nominations to survive, add a Render
**Disk** (paid), mount it at `/data`, and set `TRAINERHUB_DATA_DIR=/data`.

### Keep it at one instance

`render.yaml` pins `numInstances: 1`. Don't raise it. The slot-uniqueness
guarantee comes from Node handling one request at a time; two instances sharing a
data file would bring back the double-booking race Phase 2 exists to close. That
needs a database constraint — Phase 3.

---

## Path B — Cloudflare Tunnel (a URL in two minutes)

For a test session happening today. Runs on your machine; the URL dies when you
stop it.

**1. Install `cloudflared`**

```bash
brew install cloudflared                    # macOS
winget install --id Cloudflare.cloudflared  # Windows
```

**2. Start TrainerHub with a real password**

```bash
cd trainerhub-p2
NODE_ENV=production TRAINERHUB_ADMIN_PASSWORD='pick-something-private' node server.js
```

**3. In a second terminal, open the tunnel**

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a URL like `https://random-words-here.trycloudflare.com`. Share that.
No account, no signup, HTTPS included.

**Caveats:** the URL changes every restart, dies when you close the terminal or
your laptop sleeps, and all traffic runs through your machine.

---

## Why not Vercel, Netlify, or Lambda

Not a preference — those platforms would break this app's correctness:

- **No persistent process.** Admin sessions live in memory, so every request could
  land on a fresh instance. Admins would be signed out constantly.
- **No writable filesystem.** The JSON store cannot persist.
- **Many parallel instances.** The slot-uniqueness guarantee assumes one process.
  Concurrent nominations across instances would double-book slots — the exact bug
  Phase 2 fixed.

Serverless becomes viable in Phase 3, once state lives in a database with a unique
constraint and sessions are persisted. Today, TrainerHub needs a long-running
process: Render, Railway, Fly.io, or any small VPS.

---

## Deployment checklist

- [ ] `TRAINERHUB_ADMIN_PASSWORD` set to something private
- [ ] `NODE_ENV=production` set
- [ ] Log shows `Secure cookies ON` and `Demo routes disabled`
- [ ] `/api/admin/dashboard` returns 401 in a signed-out browser
- [ ] `/api/sessions` shows no meeting links
- [ ] Instance count is 1
- [ ] One nomination → approve → register run through end to end
- [ ] Testers warned that data may reset between sessions on the free tier

---

## If something is wrong

**"No open ports detected"** — `HOST` is overriding the default. Remove it, or set
`HOST=0.0.0.0`.

**`REFUSING TO START`** — the password env var is missing or still `admin123`.

**Admin login appears to succeed but you stay signed out** — the browser is
dropping a `Secure` cookie sent over plain HTTP. Use the HTTPS URL. Only if you are
deliberately serving plain HTTP should you set `TRAINERHUB_SECURE_COOKIES=0`.

**Prototype controls pill is missing** — expected. Demo routes are off in
production. Set `TRAINERHUB_DEMO=on` to bring them back, but not on a shared URL:
any tester could then wipe the data mid-session for everyone else.

**Data disappeared** — free-tier ephemeral disk, or the daily reseed. Add a
persistent disk and set `TRAINERHUB_DATA_DIR`.
