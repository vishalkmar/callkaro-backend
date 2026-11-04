// DB rows (snake_case) -> API objects (camelCase). The API shape is unchanged from v1.
const publicUser = u => ({
  id: u.id,
  email: u.email,
  name: u.name || '',
  status: u.status,
  termsVersion: u.terms_version || null,
  referralCode: u.referral_code || null,
  createdAt: u.created_at,
  lastLoginAt: u.last_login_at,
});

const publicCall = c => ({
  callSid: c.call_sid,
  to: c.to_number,
  callerId: c.caller_id,
  status: c.status,
  startedAt: c.started_at,
  answeredAt: c.answered_at || null,
  endedAt: c.ended_at || null,
  talkSeconds: c.talk_seconds || 0,
  credits: Number(c.credits) || 0,
  billed: !!c.billed,
  endReason: c.end_reason || null,
  hasRecording: !!c.recording_sid && !c.recording_deleted_at,
});

module.exports = { publicUser, publicCall };
