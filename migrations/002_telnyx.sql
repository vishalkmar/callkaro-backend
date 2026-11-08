-- Second calling provider (Telnyx), switched by USE_TELNYX. Twilio rows keep working unchanged.

-- Which provider carried the call. Old rows are Twilio.
ALTER TABLE calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'twilio';
-- Telnyx: call_control_id of the app (WebRTC) leg. The PSTN leg's call_control_id goes in child_call_sid.
ALTER TABLE calls ADD COLUMN provider_leg_id TEXT;
CREATE INDEX calls_provider_leg_idx ON calls (provider_leg_id) WHERE provider_leg_id IS NOT NULL;
CREATE INDEX calls_child_sid_idx ON calls (child_call_sid) WHERE child_call_sid IS NOT NULL;

-- One Telnyx telephony credential per user (Telnyx: "a separate telephony credential per device/user").
-- The SIP password is never stored: the app logs in with a short-lived JWT minted from the credential.
CREATE TABLE telnyx_credentials (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credential_id  TEXT NOT NULL,
  sip_username   TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
