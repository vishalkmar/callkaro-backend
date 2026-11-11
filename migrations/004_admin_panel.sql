-- Admin panel: admin accounts with password + 2FA (email code or authenticator app), sessions, an audit trail.

CREATE TABLE admins (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT NOT NULL UNIQUE,              -- stored lower-case
  password_hash        TEXT NOT NULL,                     -- bcrypt
  email                TEXT NOT NULL,                     -- where email login codes go
  totp_secret          TEXT,                              -- AES-GCM encrypted base32 secret (authenticator app)
  totp_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts      INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 2 of a login: the password was right, a second factor is still owed.
CREATE TABLE admin_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash   TEXT,                                       -- bcrypt of the emailed code (NULL for authenticator)
  attempts    INT NOT NULL DEFAULT 0,
  ip          TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Logged-in browser sessions (only a SHA-256 of the cookie token is stored).
CREATE TABLE admin_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  ip            TEXT,
  user_agent    TEXT,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id, created_at DESC);

-- Everything an admin does (and every login attempt).
CREATE TABLE admin_audit (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID REFERENCES admins(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);
