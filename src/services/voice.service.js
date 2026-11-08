const twilio = require('twilio');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { env } = require('../config/env');
const economy = require('../config/economy');
const { query, queryOne, tx } = require('../config/db');
const walletService = require('./wallet.service');
const abuse = require('./abuse.service');
const { chargeForSeconds, maxSecondsForCredits, canStartCall } = require('./billing.service');
const { validateCallable, toE164India } = require('../utils/phone');
const { errors } = require('../utils/response');
const { UUID_RE } = require('../middlewares/auth');
const logger = require('../utils/logger');
const alerts = require('./alert.service');

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;
const VOICE = { voice: 'Polly.Aditi', language: 'en-IN' };

let restClient = null;
const rest = () => {
  if (!restClient) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET) {
      throw errors.unavailable('VOICE_NOT_CONFIGURED', 'Calling is not configured yet');
    }
    restClient = twilio(env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, { accountSid: env.TWILIO_ACCOUNT_SID });
  }
  return restClient;
};
const setRestClientForTest = c => {
  restClient = c;
};

const url = path => `${env.PUBLIC_BASE_URL}${path}`;

const getCall = callSid => queryOne('SELECT * FROM calls WHERE call_sid = $1', [callSid]);

// ---------------- caller ID pool (owned / verified numbers ONLY) ----------------

/**
 * Syncs CALLER_ID_POOL into caller_numbers at boot. The env list is the truth: numbers removed from it (e.g. an
 * old placeholder) are switched off, otherwise the provider rejects them as caller ID (Twilio 13214) and calls die.
 */
const syncCallerPool = async () => {
  // Each provider can only present its own numbers: Twilio numbers from CALLER_ID_POOL, Telnyx numbers
  // from TELNYX_CALLER_ID_POOL.
  for (const [provider, pool] of [
    ['twilio', env.CALLER_ID_POOL],
    ['telnyx', env.TELNYX_CALLER_ID_POOL],
  ]) {
    for (const e164 of pool) {
      await query(
        `INSERT INTO caller_numbers (e164, provider, active) VALUES ($1, $2, TRUE)
         ON CONFLICT (e164) DO UPDATE SET active = TRUE, provider = EXCLUDED.provider`,
        [e164, provider],
      );
    }
    await query('UPDATE caller_numbers SET active = FALSE WHERE provider = $1 AND active = TRUE AND NOT (e164 = ANY($2::text[]))', [
      provider,
      pool,
    ]);
  }
};

/** Least-recently-used active pool number of that provider. Never a random / user-supplied / spoofed number. */
const pickCallerId = async (provider = 'twilio') => {
  const n = await queryOne(
    `UPDATE caller_numbers SET last_used_at = now()
      WHERE e164 = (SELECT e164 FROM caller_numbers WHERE active = TRUE AND provider = $1
                    ORDER BY last_used_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING e164`,
    [provider],
  );
  return n ? n.e164 : null;
};

// ---------------- access token ----------------

const createAccessToken = async user => {
  const wallet = await walletService.getWallet(user.id);
  if (!canStartCall(wallet.credits)) {
    throw errors.payment('INSUFFICIENT_CREDITS', 'You need at least 1 minute (1000 credits) to call', { credits: wallet.credits });
  }
  const check = await abuse.checkUserCanCall(user.id);
  if (!check.ok) {
    throw errors.tooMany(check.code, check.message);
  }
  if (env.USE_TELNYX) {
    // USE_TELNYX=true wins: every new call goes through Telnyx. Required lazily (telnyx.service uses this file).
    // eslint-disable-next-line global-require
    return require('./telnyx.service').createAccessToken(user, {
      credits: wallet.credits,
      maxSeconds: maxSecondsForCredits(wallet.credits),
    });
  }
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_API_KEY_SID || !env.TWILIO_API_KEY_SECRET || !env.TWILIO_TWIML_APP_SID) {
    throw errors.unavailable('VOICE_NOT_CONFIGURED', 'Calling is not configured yet');
  }
  const ttl = 600; // short-lived (10 min)
  const token = new AccessToken(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, {
    identity: user.id,
    ttl,
  });
  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: env.TWILIO_TWIML_APP_SID,
      incomingAllow: false,
      ...(env.TWILIO_PUSH_CREDENTIAL_SID ? { pushCredentialSid: env.TWILIO_PUSH_CREDENTIAL_SID } : {}),
    }),
  );
  return {
    provider: 'twilio',
    token: token.toJwt(),
    identity: user.id,
    ttl,
    credits: wallet.credits,
    maxSeconds: maxSecondsForCredits(wallet.credits),
  };
};

// ---------------- TwiML ----------------

const sayAndHangup = message => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say(VOICE, message);
  vr.hangup();
  return vr.toString();
};

const emptyResponse = () => new twilio.twiml.VoiceResponse().toString();

const identityFrom = from => String(from || '').replace(/^client:/, '');

const insertCall = (fields, extra = {}) => {
  const f = { ...fields, ...extra };
  return query(
    `INSERT INTO calls (user_id, call_sid, to_number, status, caller_id, max_seconds, recording_status, billed, end_reason, ended_at,
                        provider, provider_leg_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (call_sid) DO NOTHING`,
    [
      f.userId,
      f.callSid,
      f.to,
      f.status,
      f.callerId || null,
      f.maxSeconds || null,
      f.recordingStatus || null,
      !!f.billed,
      f.endReason || null,
      f.endedAt || null,
      f.provider || 'twilio',
      f.providerLegId || null,
    ],
  ).catch(e => logger.error({ err: e.message }, 'call insert failed'));
};

/**
 * Decides IF a call may happen, HOW LONG and FROM WHICH caller ID - the same rules for every provider:
 * active user, callable number, balance, caller ID, one call at a time, abuse limits. Stores the call row
 * (the insert is NOT best-effort: without a row the call could never be billed).
 * Returns { ok: true, callerId, maxSeconds, to } or { ok: false, message } (row already stored as refused).
 */
const admitCall = async ({ userId, callSid, to, record = false, provider = 'twilio', providerLegId = null }) => {
  const v = validateCallable(to);
  const base = { userId, callSid, to: v.e164 || String(to || '').slice(0, 20) };
  const refused = (status, endReason) =>
    insertCall({ ...base, status }, { billed: true, endReason, endedAt: new Date(), provider, providerLegId });

  if (!UUID_RE.test(userId) || !(await queryOne("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [userId]))) {
    return { ok: false, message: 'Sorry, this call could not be placed.' };
  }
  if (!v.ok) {
    await refused('blocked', `invalid_number:${v.reason}`);
    return {
      ok: false,
      message:
        v.reason === 'emergency'
          ? 'Emergency and short code numbers cannot be called from this app. Please use your phone dialer.'
          : 'The number you dialled is not valid. Please check and try again.',
    };
  }
  const wallet = await walletService.getWallet(userId);
  const maxSeconds = Math.min(maxSecondsForCredits(wallet.credits), 14400); // both providers cap a leg at 4h
  if (maxSeconds < 60) {
    await refused('insufficient-credit', 'insufficient_balance');
    return { ok: false, message: 'Your balance is too low to make this call. Please add minutes in the app.' };
  }
  const callerId = await pickCallerId(provider);
  if (!callerId) {
    logger.error({ provider }, 'no caller id configured');
    await refused('failed', 'no_caller_id');
    return { ok: false, message: 'Calling is temporarily unavailable. Please try again later.' };
  }

  // Limits check + call row insert under a per-user lock: two devices dialling at the same moment
  // cannot both pass the "1 active call" rule and each get the full balance as talk time.
  let refusal = null;
  let dialWith = { callerId, maxSeconds };
  try {
    await tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
      // Providers may retry the webhook for the same call: answer with the same dial again.
      const [same] = await c.q('SELECT * FROM calls WHERE call_sid = $1', [callSid]);
      if (same) {
        if (same.user_id === userId && same.status === 'initiated' && !same.billed) {
          dialWith = { callerId: same.caller_id, maxSeconds: same.max_seconds, retry: true };
        } else {
          refusal = { code: 'DUPLICATE_CALL_SID' };
        }
        return;
      }
      const [{ active }] = await c.q(
        "SELECT COUNT(*)::int AS active FROM calls WHERE user_id = $1 AND status = ANY($2) AND started_at >= now() - interval '3 hours'",
        [userId, abuse.ACTIVE],
      );
      const allowed = active > 0 ? { ok: false, code: 'CALL_IN_PROGRESS' } : await abuse.checkCallAllowed(userId, v.e164);
      if (!allowed.ok) {
        refusal = allowed;
        return;
      }
      await c.q(
        `INSERT INTO calls (user_id, call_sid, to_number, status, caller_id, max_seconds, recording_status, provider, provider_leg_id)
         VALUES ($1, $2, $3, 'initiated', $4, $5, $6, $7, $8)`,
        [userId, callSid, v.e164, callerId, maxSeconds, record ? 'armed' : null, provider, providerLegId],
      );
    });
  } catch (e) {
    logger.error({ err: e.message, callSid }, 'could not store call - not dialling');
    return { ok: false, message: 'Calling is temporarily unavailable. Please try again later.' };
  }
  if (refusal) {
    if (refusal.code !== 'DUPLICATE_CALL_SID') {
      await refused('blocked', refusal.code);
    }
    return { ok: false, message: 'This call cannot be placed right now. Please try again later.' };
  }
  return { ok: true, to: v.e164, ...dialWith };
};

/**
 * POST /voice/outbound (TwiML App Voice URL). Decides IF the call may happen, HOW LONG and FROM WHICH caller ID.
 */
const handleOutbound = async body => {
  const userId = identityFrom(body.From || body.Caller);
  const record = body.Record === 'true' || body.record === 'true';
  const dialWith = await admitCall({ userId, callSid: body.CallSid, to: body.To, record });
  if (!dialWith.ok) {
    return sayAndHangup(dialWith.message);
  }
  const v = { e164: dialWith.to };

  const vr = new twilio.twiml.VoiceResponse();
  const dial = vr.dial({
    callerId: dialWith.callerId,
    timeLimit: dialWith.maxSeconds, // hard guarantee: the provider cuts the call when credits run out
    timeout: economy.RING_TIMEOUT_SECONDS,
    answerOnBridge: true,
    action: url('/voice/dial-complete'),
    method: 'POST',
  });
  dial.number(
    {
      statusCallback: url('/voice/status'),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      // Runs on the callee's side right after answer: plays the recording notice when recording is armed.
      url: url('/voice/answer-hook'),
      method: 'POST',
    },
    v.e164,
  );
  return vr.toString();
};

const STATUS_MAP = {
  queued: 'initiated',
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in-progress',
  answered: 'in-progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no-answer',
  failed: 'failed',
  canceled: 'canceled',
};
const TERMINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

/** POST /voice/status - progress of the PSTN (child) leg. */
const handleStatus = async body => {
  const parentSid = body.ParentCallSid || body.CallSid;
  const status = STATUS_MAP[body.CallStatus] || body.CallStatus;
  await query(
    `UPDATE calls SET child_call_sid = $2,
       status = CASE WHEN $3 IN ('ringing', 'in-progress') THEN $3 ELSE status END,
       answered_at = CASE WHEN $3 = 'in-progress' AND answered_at IS NULL THEN now() ELSE answered_at END,
       ended_at = CASE WHEN $3 = ANY($4) THEN COALESCE(ended_at, now()) ELSE ended_at END,
       updated_at = now()
     WHERE call_sid = $1 AND billed = FALSE`,
    [parentSid, body.CallSid, status, TERMINAL],
  );
  // Parent (app) leg ended before the callee answered - e.g. the user hung up while it was ringing.
  // Twilio does not call the Dial action then, so close the call now (0 credits) instead of leaving it
  // "in progress" and blocking the user's next call until the safety job runs.
  if (!body.ParentCallSid && TERMINAL.includes(status)) {
    const call = await getCall(body.CallSid);
    if (call && !call.billed && !call.answered_at) {
      await billCall({ callSid: body.CallSid, dialStatus: 'canceled', dialSeconds: 0 });
    }
    return;
  }
  // Recording armed before answer -> start it now (the callee hears the notice via /voice/answer-hook).
  if (status === 'in-progress') {
    const call = await getCall(parentSid);
    if (call?.recording_status === 'armed') {
      await startRecordingOnProvider(call).catch(e => logger.error({ err: e.message }, 'auto-record start failed'));
    }
  }
};

/** Bills a finished call exactly once (ref = callSid). Not answered / busy / failed -> 0 credits. */
const billCall = async ({ callSid, dialStatus, dialSeconds }) => {
  const call = await getCall(callSid);
  if (!call) {
    logger.warn({ callSid }, 'billing: unknown call');
    return null;
  }
  if (call.billed) {
    return call; // idempotent
  }
  const answered = dialStatus === 'completed' || dialStatus === 'answered';
  const talkSeconds = answered ? Math.min(Math.max(0, parseInt(dialSeconds, 10) || 0), call.max_seconds || Infinity) : 0;
  const credits = chargeForSeconds(talkSeconds);
  const status = STATUS_MAP[dialStatus] || (answered ? 'completed' : 'failed');
  const endReason = talkSeconds > 0 && call.max_seconds && talkSeconds >= call.max_seconds - 1 ? 'balance_finished' : call.end_reason;
  let billed = false;
  let billingError = null;
  try {
    if (credits > 0) {
      // partial: if the balance shrank meanwhile (refund reversal), take what is left and flag the user.
      await walletService.applyChange(call.user_id, -credits, 'call_charge', callSid, {
        partial: true,
        meta: { to: call.to_number, talkSeconds },
      });
    }
    billed = true;
  } catch (e) {
    billingError = e.message;
    logger.error({ callSid, err: e.message }, 'billing failed - will retry');
    alerts.notify(`Billing failed for call ${callSid}: ${e.message}`).catch(() => {});
  }
  return queryOne(
    `UPDATE calls SET status = $2, talk_seconds = $3, ended_at = COALESCE(ended_at, now()), billing_attempts = billing_attempts + 1,
       end_reason = $4, credits = CASE WHEN $5 THEN $6 ELSE credits END, billed = $5, billing_error = $7, updated_at = now()
     WHERE call_sid = $1 RETURNING *`,
    [callSid, status, talkSeconds, endReason, billed, credits, billingError],
  );
};

/** POST /voice/dial-complete (Dial action) - final result of the PSTN leg. */
const handleDialComplete = async body => {
  await billCall({ callSid: body.CallSid, dialStatus: body.DialCallStatus, dialSeconds: body.DialCallDuration });
  const vr = new twilio.twiml.VoiceResponse();
  vr.hangup();
  return vr.toString();
};

/** POST /voice/answer-hook - whisper to the callee on answer (recording notice when armed). */
const handleAnswerHook = async body => {
  const call = await getCall(body.ParentCallSid);
  const vr = new twilio.twiml.VoiceResponse();
  if (call?.recording_status === 'armed') {
    vr.say(VOICE, 'This call is being recorded.');
  }
  return vr.toString();
};

/** POST /voice/inbound - people calling back a pool number hear who we are + can opt out. */
const handleInbound = async () => {
  const vr = new twilio.twiml.VoiceResponse();
  const gather = vr.gather({ numDigits: 1, action: url('/voice/inbound/optout'), method: 'POST', timeout: 6 });
  gather.say(
    VOICE,
    `This number is used by ${env.BREVO_SENDER_NAME} for internet calls. To report misuse, visit ${env.REPORT_URL}. ` +
      `To stop receiving calls from ${env.BREVO_SENDER_NAME} on this phone number, press 1.`,
  );
  vr.say(VOICE, 'Thank you. Goodbye.');
  vr.hangup();
  return vr.toString();
};

const handleInboundOptOut = async body => {
  const vr = new twilio.twiml.VoiceResponse();
  const from = toE164India(body.From);
  if (body.Digits === '1' && from) {
    const report = await queryOne(
      "INSERT INTO reports (target_number, reporter_contact, reason, details) VALUES ($1, $1, 'opt_out', 'IVR opt-out') RETURNING *",
      [from],
    );
    await abuse.evaluateReports(report);
    vr.say(VOICE, 'Your number has been added to our do not call list. Goodbye.');
  } else {
    vr.say(VOICE, 'Goodbye.');
  }
  vr.hangup();
  return vr.toString();
};

// ---------------- recording ----------------

const startRecordingOnProvider = async call => {
  const rec = await rest()
    .calls(call.call_sid)
    .recordings.create({
      recordingChannels: 'dual',
      recordingStatusCallback: url('/voice/recording-status'),
      recordingStatusCallbackEvent: ['in-progress', 'completed'],
    });
  await query("UPDATE calls SET recording_sid = $2, recording_status = 'in-progress', updated_at = now() WHERE id = $1", [
    call.id,
    rec.sid,
  ]);
  return rec;
};

const findOwnCall = async (userId, callSid) => {
  const call = await queryOne('SELECT * FROM calls WHERE call_sid = $1 AND user_id = $2', [callSid, userId]);
  if (!call) {
    throw errors.notFound('CALL_NOT_FOUND', 'Call not found');
  }
  return call;
};

/** Recording is built on Twilio's recording API; Telnyx calls say so instead of failing half-way. */
const assertRecordable = call => {
  if (call.provider === 'telnyx') {
    throw errors.badRequest('RECORDING_UNAVAILABLE', 'Recording is not available on this calling line yet.');
  }
};

const setRecordingStatus = (id, status) =>
  query('UPDATE calls SET recording_status = $2, updated_at = now() WHERE id = $1', [id, status]);

/**
 * POST /voice/recording/start - legal rule: both sides must hear the notice. The callee notice is played on
 * answer, so recording can be ARMED only before the call is answered; after answer it can only resume a
 * recording that was armed earlier.
 */
const startRecording = async (userId, callSid) => {
  const call = await findOwnCall(userId, callSid);
  assertRecordable(call);
  if (TERMINAL.includes(call.status)) {
    throw errors.conflict('CALL_ENDED', 'The call has already ended');
  }
  if (call.status !== 'in-progress') {
    await setRecordingStatus(call.id, 'armed');
    return { recordingStatus: 'armed' };
  }
  if (call.recording_sid && call.recording_status === 'paused') {
    await rest().calls(callSid).recordings(call.recording_sid).update({ status: 'in-progress' });
    await setRecordingStatus(call.id, 'in-progress');
    return { recordingStatus: 'in-progress' };
  }
  if (call.recording_status === 'in-progress') {
    return { recordingStatus: 'in-progress' };
  }
  throw errors.conflict(
    'RECORDING_NEEDS_NOTICE',
    'Recording must be turned on before the call is answered so both sides hear the announcement. Turn on "Record all calls" in Settings.',
  );
};

const stopRecording = async (userId, callSid) => {
  const call = await findOwnCall(userId, callSid);
  assertRecordable(call);
  let next = call.recording_status;
  if (call.recording_status === 'armed') {
    next = null;
  } else if (call.recording_sid && call.recording_status === 'in-progress') {
    await rest().calls(callSid).recordings(call.recording_sid).update({ status: 'paused' });
    next = 'paused';
  }
  await setRecordingStatus(call.id, next);
  return { recordingStatus: next || 'off' };
};

/** POST /voice/recording-status */
const handleRecordingStatus = async body => {
  await query(
    `UPDATE calls SET recording_sid = $2, recording_status = $3,
       recording_duration = COALESCE($4, recording_duration), recording_url = COALESCE($5, recording_url), updated_at = now()
     WHERE call_sid = $1`,
    [body.CallSid, body.RecordingSid, body.RecordingStatus, body.RecordingDuration ? parseInt(body.RecordingDuration, 10) : null, body.RecordingUrl || null],
  );
};

/** Short-lived (5 min) signed download URL - streams through our server so Twilio creds never leave it. */
const recordingUrlFor = async (userId, callSid) => {
  const call = await findOwnCall(userId, callSid);
  if (!call.recording_sid || call.recording_deleted_at || call.recording_status !== 'completed') {
    throw errors.notFound('NO_RECORDING', 'Recording not available');
  }
  const token = jwt.sign({ csid: callSid, uid: String(userId), typ: 'rec' }, env.JWT_ACCESS_SECRET, { expiresIn: '5m' });
  return { url: url(`/recordings/download/${token}`), expiresInSeconds: 300, durationSec: call.recording_duration || 0 };
};

const streamRecording = async (token, res) => {
  let p;
  try {
    p = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch (e) {
    throw errors.unauthorized('LINK_EXPIRED', 'Download link expired');
  }
  if (p.typ !== 'rec') {
    throw errors.unauthorized('LINK_EXPIRED', 'Download link expired');
  }
  const call = await queryOne('SELECT * FROM calls WHERE call_sid = $1 AND user_id = $2', [p.csid, p.uid]);
  if (!call?.recording_sid || call.recording_deleted_at) {
    throw errors.notFound('NO_RECORDING', 'Recording not available');
  }
  const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Recordings/${call.recording_sid}.mp3`;
  const upstream = await axios.get(mediaUrl, {
    responseType: 'stream',
    auth: { username: env.TWILIO_API_KEY_SID, password: env.TWILIO_API_KEY_SECRET },
    timeout: 30000,
  });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `attachment; filename="${call.call_sid}.mp3"`);
  upstream.data.pipe(res);
};

module.exports = {
  admitCall,
  syncCallerPool,
  pickCallerId,
  createAccessToken,
  handleOutbound,
  handleStatus,
  handleDialComplete,
  handleAnswerHook,
  handleInbound,
  handleInboundOptOut,
  handleRecordingStatus,
  billCall,
  getCall,
  startRecording,
  stopRecording,
  recordingUrlFor,
  streamRecording,
  emptyResponse,
  rest,
  setRestClientForTest,
};
