// Telnyx calling (used when USE_TELNYX=true). Same business rules as Twilio - voice.admitCall() decides
// IF / HOW LONG / FROM WHICH number, voice.billCall() bills - only the provider plumbing differs:
//
//   app (Telnyx WebRTC SDK, logged in with a JWT of the user's telephony credential)
//     -> newCall(+91..., header X-CK-Ref) -> the app leg is PARKED on our Credential Connection
//   call.initiated (app leg)  -> admitCall -> POST /calls (PSTN leg, time_limit_secs = balance) from a pool number
//   call.answered  (PSTN leg) -> bridge app leg <-> PSTN leg
//   call.hangup    (PSTN leg) -> bill once, hang up the app leg
//   call.hangup    (app leg)  -> hang up the PSTN leg (billing follows its hangup) / close an unanswered call
const crypto = require('crypto');
const axios = require('axios');
const { env } = require('../config/env');
const economy = require('../config/economy');
const { query, queryOne } = require('../config/db');
const voice = require('./voice.service');
const alerts = require('./alert.service');
const { errors } = require('../utils/response');
const logger = require('../utils/logger');

const log = logger.child ? logger.child({ provider: 'telnyx' }) : logger;

let client = null;
/** Telnyx REST v2 (Bearer API key). Tests swap it with setApiForTest(). */
const api = () => {
  if (!client) {
    client = axios.create({
      baseURL: env.TELNYX_API_BASE,
      timeout: 10000,
      headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    });
  }
  return client;
};
const setApiForTest = c => {
  client = c;
};

const url = path => `${env.PUBLIC_BASE_URL}${path}`;
const WEBHOOK_PATH = '/voice/telnyx/webhook';
const REF_HEADER = 'X-CK-Ref';
const REF_TTL_SECONDS = 600; // same life as a Twilio access token
const CREDENTIAL_DAYS = 30;

const isConfigured = () =>
  !!(env.TELNYX_API_KEY && env.TELNYX_CONNECTION_ID && env.TELNYX_CALL_CONTROL_APP_ID && env.TELNYX_CALLER_ID_POOL.length);

// ---------------- call reference (who placed the call) ----------------
// The app gets a signed reference with its token and sends it as a SIP header on the call. It ties the parked
// leg to the user without trusting anything else the client says: userId.callId.expiry.hmac(secret).

const sign = text => crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`telnyx-ref:${text}`).digest('hex').slice(0, 32);

const createCallRef = (userId, now = Date.now()) => {
  const id = crypto.randomBytes(16).toString('hex');
  const exp = Math.floor(now / 1000) + REF_TTL_SECONDS;
  const body = `${userId}.${id}.${exp}`;
  return { ref: `${body}.${sign(body)}`, callSid: `TX${id}` };
};

/** -> { userId, callSid } or null when forged / expired / malformed. */
const readCallRef = (ref, now = Date.now()) => {
  const parts = String(ref || '').split('.');
  if (parts.length !== 4) {
    return null;
  }
  const [userId, id, exp, mac] = parts;
  const expected = sign(`${userId}.${id}.${exp}`);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  if (!/^[a-f0-9]{32}$/.test(id) || Number(exp) * 1000 < now) {
    return null;
  }
  return { userId, callSid: `TX${id}` };
};

const headerValue = (headers, name) => {
  const h = (headers || []).find(x => String(x?.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
};

// ---------------- credentials + login token ----------------

const createCredential = async userId => {
  const expiresAt = new Date(Date.now() + CREDENTIAL_DAYS * 86400 * 1000);
  const { data } = await api().post('/telephony_credentials', {
    connection_id: env.TELNYX_CONNECTION_ID,
    name: `callingkaro-${userId}`,
    expires_at: expiresAt.toISOString(),
  });
  const cred = data.data;
  await query(
    `INSERT INTO telnyx_credentials (user_id, credential_id, sip_username, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET credential_id = $2, sip_username = $3, expires_at = $4, created_at = now()`,
    [userId, cred.id, cred.sip_username, cred.expires_at || expiresAt],
  );
  return cred.id;
};

const mintToken = async credentialId => {
  const res = await api().post(`/telephony_credentials/${credentialId}/token`, null, { responseType: 'text' });
  return typeof res.data === 'string' ? res.data.trim() : String(res.data);
};

/** One credential per user, renewed a day before it expires; a credential deleted on Telnyx is recreated. */
const loginTokenFor = async userId => {
  const row = await queryOne('SELECT * FROM telnyx_credentials WHERE user_id = $1', [userId]);
  let credentialId = row && new Date(row.expires_at) > new Date(Date.now() + 86400 * 1000) ? row.credential_id : null;
  if (!credentialId) {
    credentialId = await createCredential(userId);
  }
  try {
    return await mintToken(credentialId);
  } catch (e) {
    if (e.response?.status !== 404) {
      throw e;
    }
    return mintToken(await createCredential(userId));
  }
};

/** GET /voice/token when Telnyx is on. Balance / abuse checks already passed in voice.createAccessToken. */
const createAccessToken = async (user, { credits, maxSeconds }) => {
  if (!isConfigured()) {
    throw errors.unavailable('VOICE_NOT_CONFIGURED', 'Calling is not configured yet');
  }
  let token;
  try {
    token = await loginTokenFor(user.id);
  } catch (e) {
    log.error({ status: e.response?.status, err: e.message }, 'telnyx token failed');
    throw errors.unavailable('VOICE_UNAVAILABLE', 'Calling is temporarily unavailable. Please try again.');
  }
  const { ref, callSid } = createCallRef(user.id);
  return {
    provider: 'telnyx',
    token,
    identity: user.id,
    ttl: REF_TTL_SECONDS,
    credits,
    maxSeconds,
    callSid, // the app knows the call id up front (Twilio gives it on ringing)
    sipHeaders: [{ name: REF_HEADER, value: ref }],
  };
};

// ---------------- call control ----------------

const action = (callControlId, name, body = {}) =>
  api()
    .post(`/calls/${encodeURIComponent(callControlId)}/actions/${name}`, body)
    .catch(e => {
      // 422 = the leg is already gone (normal when both sides hang up together)
      if (e.response?.status !== 422) {
        log.warn({ name, status: e.response?.status, err: e.message }, 'telnyx action failed');
      }
      return null;
    });

const hangup = callControlId => (callControlId ? action(callControlId, 'hangup') : null);

const encodeState = obj => Buffer.from(JSON.stringify(obj)).toString('base64');
const decodeState = s => {
  try {
    return JSON.parse(Buffer.from(String(s || ''), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
};

/** Telnyx hangup_cause -> our dial status (same words as Twilio's DialCallStatus, so billCall works as is). */
const dialStatusFor = (cause, answered) => {
  if (answered) {
    return 'completed'; // normal_clearing, time_limit, ... - talk time is what is billed
  }
  if (cause === 'user_busy' || cause === 'call_rejected') {
    return 'busy';
  }
  if (cause === 'timeout' || cause === 'no_answer') {
    return 'no-answer';
  }
  if (cause === 'originator_cancel') {
    return 'canceled';
  }
  return 'failed';
};

const findByLeg = id =>
  queryOne("SELECT * FROM calls WHERE provider = 'telnyx' AND (provider_leg_id = $1 OR child_call_sid = $1) LIMIT 1", [id]);

/** call.initiated on our Credential Connection = the app placed a call. */
const onAppLegInitiated = async p => {
  const appLeg = p.call_control_id;
  const ref = readCallRef(headerValue(p.custom_headers, REF_HEADER));
  if (!ref) {
    log.warn('app call without a valid reference - hanging up');
    return hangup(appLeg);
  }
  const cred = await queryOne('SELECT sip_username FROM telnyx_credentials WHERE user_id = $1', [ref.userId]);
  // The reference must come from the same user's own login (a leaked ref cannot be used from another account).
  if (cred && p.from && String(p.from).includes('gencred') && !String(p.from).includes(cred.sip_username)) {
    log.warn({ callSid: ref.callSid }, 'reference used from another credential - hanging up');
    return hangup(appLeg);
  }

  const admitted = await voice.admitCall({
    userId: ref.userId,
    callSid: ref.callSid,
    to: p.to,
    provider: 'telnyx',
    providerLegId: appLeg,
  });
  if (!admitted.ok) {
    log.info({ callSid: ref.callSid }, `call refused: ${admitted.message}`);
    return hangup(appLeg);
  }
  if (admitted.retry) {
    return null; // webhook retried: the PSTN leg was already dialled (command_id would dedupe it too)
  }

  try {
    const { data } = await api().post('/calls', {
      connection_id: env.TELNYX_CALL_CONTROL_APP_ID,
      to: admitted.to,
      from: admitted.callerId,
      time_limit_secs: Math.max(30, admitted.maxSeconds), // hard stop when the balance is used up
      timeout_secs: economy.RING_TIMEOUT_SECONDS,
      webhook_url: url(WEBHOOK_PATH),
      client_state: encodeState({ k: ref.callSid }),
      command_id: `dial-${ref.callSid}`,
    });
    await query("UPDATE calls SET child_call_sid = $2, status = 'ringing', updated_at = now() WHERE call_sid = $1", [
      ref.callSid,
      data.data.call_control_id,
    ]);
  } catch (e) {
    log.error({ callSid: ref.callSid, status: e.response?.status, err: e.message }, 'telnyx dial failed');
    await voice.billCall({ callSid: ref.callSid, dialStatus: 'failed', dialSeconds: 0 });
    await hangup(appLeg);
    alerts.notify(`Telnyx dial failed (${e.response?.status || e.message})`, { dedupeKey: 'telnyx-dial' }).catch(() => {});
  }
  return null;
};

const callForPstnEvent = async p => {
  const byLeg = await findByLeg(p.call_control_id);
  if (byLeg) {
    return byLeg;
  }
  const state = decodeState(p.client_state);
  return state?.k ? voice.getCall(state.k) : null;
};

const onPstnAnswered = async p => {
  const call = await callForPstnEvent(p);
  if (!call || call.billed) {
    return hangup(p.call_control_id);
  }
  await query(
    `UPDATE calls SET status = 'in-progress', child_call_sid = $2, answered_at = COALESCE(answered_at, now()), updated_at = now()
      WHERE id = $1`,
    [call.id, p.call_control_id],
  );
  const bridged = await action(call.provider_leg_id, 'bridge', { call_control_id: p.call_control_id });
  if (!bridged) {
    // the app already left: do not keep a PSTN call running on our bill
    await hangup(p.call_control_id);
  }
  return null;
};

const onHangup = async p => {
  const call = await callForPstnEvent(p);
  if (!call) {
    return null;
  }
  const isPstn = call.child_call_sid === p.call_control_id || decodeState(p.client_state)?.k === call.call_sid;
  if (isPstn) {
    const answered = !!call.answered_at;
    const seconds = answered ? Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000) : 0;
    if (p.hangup_cause === 'time_limit') {
      await query("UPDATE calls SET end_reason = 'balance_finished' WHERE id = $1", [call.id]);
    }
    await voice.billCall({ callSid: call.call_sid, dialStatus: dialStatusFor(p.hangup_cause, answered), dialSeconds: seconds });
    return hangup(call.provider_leg_id);
  }
  // App leg ended (user hung up / lost internet).
  if (call.child_call_sid) {
    return hangup(call.child_call_sid); // its hangup event bills the call
  }
  if (!call.billed) {
    await voice.billCall({ callSid: call.call_sid, dialStatus: 'canceled', dialSeconds: 0 });
  }
  return null;
};

/** POST /voice/telnyx/webhook (signature already verified). Always answered 200 - work is idempotent. */
const handleWebhook = async body => {
  const event = body?.data || {};
  const p = event.payload || {};
  const type = event.event_type;
  if (type === 'call.initiated') {
    // Only calls the app places on our credential connection; the PSTN legs we dial come back here too.
    if (p.connection_id === env.TELNYX_CONNECTION_ID && p.direction === 'incoming') {
      return onAppLegInitiated(p);
    }
    return null;
  }
  if (type === 'call.answered') {
    const call = await callForPstnEvent(p);
    if (call && call.provider_leg_id !== p.call_control_id) {
      return onPstnAnswered(p);
    }
    return null;
  }
  if (type === 'call.hangup') {
    return onHangup(p);
  }
  return null;
};

// ---------------- webhook signature (Ed25519 over "timestamp|raw body") ----------------

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_SKEW_SECONDS = 300;

const verifySignature = ({ rawBody, signature, timestamp, publicKey = env.TELNYX_PUBLIC_KEY, now = Date.now() }) => {
  if (!rawBody || !signature || !timestamp || !publicKey) {
    return false;
  }
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    return false; // replay window
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(`${timestamp}|${rawBody.toString('utf8')}`), key, Buffer.from(signature, 'base64'));
  } catch (e) {
    return false;
  }
};

/** Safety job: a Telnyx call whose hangup webhook never arrived. */
const isLegAlive = async callControlId => {
  try {
    const { data } = await api().get(`/calls/${encodeURIComponent(callControlId)}`);
    return !!data?.data?.is_alive;
  } catch (e) {
    if (e.response?.status === 404 || e.response?.status === 422) {
      return false;
    }
    throw e;
  }
};

module.exports = {
  isConfigured,
  createAccessToken,
  createCallRef,
  readCallRef,
  handleWebhook,
  verifySignature,
  isLegAlive,
  dialStatusFor,
  setApiForTest,
  REF_HEADER,
  WEBHOOK_PATH,
};
