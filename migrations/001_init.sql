-- CallKaro schema v1 (PostgreSQL 16 / Neon). Money columns are BIGINT credits (1000 credits = 1 minute).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'deleted')),
  blocked_reason     TEXT,
  terms_version      TEXT,
  device_id          TEXT,
  device_ids         TEXT[] NOT NULL DEFAULT '{}',
  last_login_at      TIMESTAMPTZ,
  referral_code      TEXT UNIQUE,
  referred_by        UUID REFERENCES users(id),
  referral_rewarded  BOOLEAN NOT NULL DEFAULT FALSE,
  rewards_disabled   BOOLEAN NOT NULL DEFAULT FALSE,
  negative_usage     BOOLEAN NOT NULL DEFAULT FALSE,
  last_free_spin_at  TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX users_device_ids_idx ON users USING GIN (device_ids);

-- One row per email; only a bcrypt hash of the code is stored.
CREATE TABLE otps (
  email         TEXT PRIMARY KEY,
  otp_hash      TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  last_sent_at  TIMESTAMPTZ,
  send_times    TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
  purge_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id           TEXT NOT NULL,
  refresh_token_hash  TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE wallets (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credits          BIGINT NOT NULL DEFAULT 0 CHECK (credits >= 0),
  lifetime_earned  BIGINT NOT NULL DEFAULT 0,
  lifetime_spent   BIGINT NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('purchase', 'ad_reward', 'spin_reward', 'welcome_bonus', 'checkin_reward',
                   'referral_bonus', 'call_charge', 'refund', 'payment_reversal', 'admin_adjust')),
  amount         BIGINT NOT NULL,
  balance_after  BIGINT NOT NULL,
  ref_id         TEXT NOT NULL,
  meta           JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, ref_id) -- idempotency: a payment / ad / call / spin is applied once
);
CREATE INDEX ledger_user_created_idx ON ledger_entries (user_id, created_at DESC, id DESC);

CREATE TABLE calls (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_sid              TEXT NOT NULL UNIQUE,
  child_call_sid        TEXT,
  to_number             TEXT NOT NULL,
  caller_id             TEXT,
  status                TEXT NOT NULL DEFAULT 'initiated',
  max_seconds           INT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at           TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  talk_seconds          INT NOT NULL DEFAULT 0,
  credits               BIGINT NOT NULL DEFAULT 0,
  billed                BOOLEAN NOT NULL DEFAULT FALSE,
  billing_attempts      INT NOT NULL DEFAULT 0,
  billing_error         TEXT,
  end_reason            TEXT,
  recording_sid         TEXT,
  recording_status      TEXT,
  recording_duration    INT,
  recording_url         TEXT,
  recording_deleted_at  TIMESTAMPTZ,
  anonymized            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX calls_user_started_idx ON calls (user_id, started_at DESC);
CREATE INDEX calls_to_started_idx ON calls (to_number, started_at DESC);
CREATE INDEX calls_unbilled_idx ON calls (billed, started_at) WHERE billed = FALSE;

CREATE TABLE orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id           TEXT NOT NULL,
  amount_paise         INT NOT NULL,
  credits              BIGINT NOT NULL,
  minutes              INT NOT NULL,
  provider             TEXT NOT NULL CHECK (provider IN ('play', 'razorpay')),
  provider_order_id    TEXT UNIQUE,
  purchase_token       TEXT UNIQUE,
  provider_payment_id  TEXT,
  status               TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'paid', 'failed', 'refunded')),
  paid_at              TIMESTAMPTZ,
  refunded_at          TIMESTAMPTZ,
  failure_reason       TEXT,
  receipt_no           TEXT UNIQUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);

CREATE TABLE ad_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nonce       TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL DEFAULT 'credits' CHECK (purpose IN ('credits', 'extra_spin')),
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ad_rewards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  TEXT NOT NULL UNIQUE,
  nonce           TEXT,
  purpose         TEXT NOT NULL DEFAULT 'credits' CHECK (purpose IN ('credits', 'extra_spin')),
  credits         INT NOT NULL DEFAULT 0,
  ad_unit         TEXT,
  spin_used       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ad_rewards_user_created_idx ON ad_rewards (user_id, created_at DESC);

CREATE TABLE spins (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  segment_index  INT NOT NULL,
  credits        INT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('free', 'ad')),
  ad_reward_id   UUID REFERENCES ad_rewards(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Caller IDs we OWN or have VERIFIED. No other number is ever presented.
CREATE TABLE caller_numbers (
  e164             TEXT PRIMARY KEY,
  provider         TEXT NOT NULL DEFAULT 'twilio',
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_to      UUID REFERENCES users(id),
  inbound_message  TEXT,
  last_used_at     TIMESTAMPTZ
);

CREATE TABLE reports (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  reporter_contact  TEXT,
  target_number     TEXT,
  target_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  call_sid          TEXT,
  reason            TEXT NOT NULL CHECK (reason IN ('harassment', 'fraud', 'spam', 'impersonation', 'abuse', 'opt_out',
                      'app_problem', 'billing', 'other')),
  details           TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reports_target_number_idx ON reports (target_number);
CREATE INDEX reports_target_user_idx ON reports (target_user_id);

-- Opt-outs and numbers blocked after reports.
CREATE TABLE blocked_numbers (
  e164        TEXT PRIMARY KEY,
  reason      TEXT NOT NULL CHECK (reason IN ('opt_out', 'reports', 'admin', 'harassment')),
  until       TIMESTAMPTZ,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
