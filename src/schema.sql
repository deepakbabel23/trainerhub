-- ============================================================================
-- TrainerHub — Postgres schema (Phase 3)
--
-- Idempotent. Runs on every boot; safe to re-run against an existing database.
-- Never drops or truncates anything — this holds real bookings.
-- ============================================================================

-- ---------------------------------------------------------------- sessions
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT        PRIMARY KEY,
  session_date   DATE        NOT NULL,
  slot           TEXT        NOT NULL CHECK (slot IN ('11:00', '19:00')),   -- RULE-001
  status         TEXT        NOT NULL CHECK (status IN ('RESERVED','PUBLISHED','REJECTED','CANCELLED')),
  topic          TEXT        NOT NULL,
  description    TEXT        NOT NULL DEFAULT '',
  speaker_name   TEXT        NOT NULL,
  speaker_phone  TEXT        NOT NULL DEFAULT '',
  speaker_email  TEXT        NOT NULL DEFAULT '',
  meeting_link   TEXT        NOT NULL,
  source         TEXT        NOT NULL DEFAULT 'speaker',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ
);

-- THE constraint this whole phase exists for.
--
-- FR-003 / RULE-005 / RULE-006 / P0-001: a slot may hold at most one ACTIVE
-- session. REJECTED and CANCELLED rows are excluded, so rejecting or
-- cancelling genuinely frees the slot (RULE-012, RULE-013) while keeping the
-- historical row.
--
-- Phase 2 enforced this by checking-then-writing inside one Node process,
-- which only held because Node runs one handler at a time. Here the database
-- decides. Two concurrent inserts for the same slot cannot both win no matter
-- how many application instances are running.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_slot_uniq
  ON sessions (session_date, slot)
  WHERE status IN ('RESERVED', 'PUBLISHED');

CREATE INDEX IF NOT EXISTS sessions_status_date_idx ON sessions (status, session_date, slot);

-- ----------------------------------------------------------- registrations
CREATE TABLE IF NOT EXISTS registrations (
  id               TEXT        PRIMARY KEY,
  session_id       TEXT        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_name TEXT        NOT NULL,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registrations_session_idx ON registrations (session_id);

-- --------------------------------------------------------- admin sessions
-- Phase 2 kept these in a Map, so every restart signed the administrator out.
-- On a free tier that spins down every 15 minutes, that was unusable.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT        PRIMARY KEY,
  email      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);

-- ---------------------------------------------------------- login attempts
-- Rate limiting. Irrelevant for a private demo, necessary for a public URL
-- whose admin console is protected by a single password.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL   PRIMARY KEY,
  ip         TEXT        NOT NULL,
  successful BOOLEAN     NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_ip_time_idx ON login_attempts (ip, attempted_at DESC);
