// Telnyx as the second calling provider (USE_TELNYX=true): token, signed call reference, the full
// parked-leg -> dial -> bridge -> hangup -> bill flow, refusals, retries, signatures and the safety job.
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const voice = require('../src/services/voice.service');
const telnyx = require('../src/services/telnyx.service');
const alerts = require('../src/services/alert.service');
const unbilledJob = require('../src/jobs/unbilledCalls.job');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

// ---- fake Telnyx REST API ----
const calls = [];
let dialCount = 0;
let alive = false;
const fakeApi = {
  post: jest.fn(async (path, body) => {
    calls.push({ path, body });
    if (path === '/telephony_credentials') {
      return { data: { data: { id: `cred-${calls.length}`, sip_username: `gencred${calls.length}`, expires_at: null } } };
    }
    if (/^\/telephony_credentials\/.+\/token$/.test(path)) {
      return { data: 'jwt-login-token' };
    }
    if (path === '/calls') {
      dialCount += 1;
      return { data: { data: { call_control_id: `pstn-${dialCount}` } } };
    }
    return { data: { data: { result: 'ok' } } };
  }),
  get: jest.fn(async () => ({ data: { data: { is_alive: alive } } })),
};
const actions = name => calls.filter(c => c.path.endsWith(`/actions/${name}`)).map(c => c.path.split('/')[2]);

// ---- signed webhooks ----
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const RAW_PUBLIC = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const signed = (body, { ts = Math.floor(Date.now() / 1000), key = privateKey } = {}) => {
  const raw = JSON.stringify(body);
  const sig = crypto.sign(null, Buffer.from(`${ts}|${raw}`), key).toString('base64');
  return { raw, headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': String(ts), 'content-type': 'application/json' } };
};
const hook = (event_type, payload) => {
  const { raw, headers } = signed({ data: { event_type, payload } });
  return request(app).post('/voice/telnyx/webhook').set(headers).send(raw);
};

const APP_CONN = 'cred-conn-1';
const appLeg = n => `app-${n}`;
const getCall = sid => queryOne('SELECT * FROM calls WHERE call_sid = $1', [sid]);

const tokenFor = async token => (await request(app).get('/voice/token').set('Authorization', `Bearer ${token}`)).body;
/** Places a call like the app: token -> call.initiated on the credential connection with the ref header. */
const placeCall = async (token, n, to = '+919876543210') => {
  const t = await tokenFor(token);
  await hook('call.initiated', {
    call_control_id: appLeg(n),
    connection_id: APP_CONN,
    direction: 'incoming',
    from: 'sip:gencred1@sip.telnyx.com',
    to,
    custom_headers: t.data.sipHeaders,
  });
  return t.data;
};

const saved = {};
beforeAll(async () => {
  await startDb();
  for (const k of ['USE_TELNYX', 'TELNYX_API_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_CALL_CONTROL_APP_ID', 'TELNYX_PUBLIC_KEY']) {
    saved[k] = env[k];
  }
  saved.pool = [...env.TELNYX_CALLER_ID_POOL];
  Object.assign(env, {
    USE_TELNYX: true,
    TELNYX_API_KEY: 'KEY_test',
    TELNYX_CONNECTION_ID: APP_CONN,
    TELNYX_CALL_CONTROL_APP_ID: 'voice-app-1',
    TELNYX_PUBLIC_KEY: RAW_PUBLIC,
  });
  env.TELNYX_CALLER_ID_POOL.splice(0, env.TELNYX_CALLER_ID_POOL.length, '+918045000001');
  telnyx.setApiForTest(fakeApi);
});
beforeEach(async () => {
  calls.length = 0;
  dialCount = 0;
  alive = false;
  jest.clearAllMocks();
  await voice.syncCallerPool();
});
afterEach(clearDb);
afterAll(async () => {
  Object.assign(env, saved);
  env.TELNYX_CALLER_ID_POOL.splice(0, env.TELNYX_CALLER_ID_POOL.length, ...saved.pool);
  await stopDb();
});

describe('flag + token', () => {
  test('USE_TELNYX=true: the app gets a Telnyx login token, the call id and a signed SIP header', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    const t = await tokenFor(token);
    expect(t.data).toMatchObject({ provider: 'telnyx', token: 'jwt-login-token', maxSeconds: 300 });
    expect(t.data.callSid).toMatch(/^TX[a-f0-9]{32}$/);
    expect(t.data.sipHeaders[0].name).toBe('X-CK-Ref');
    expect(telnyx.readCallRef(t.data.sipHeaders[0].value)).toEqual({ userId: user.id, callSid: t.data.callSid });
  });

  test('one credential per user is reused, and recreated when Telnyx deleted it', async () => {
    const { token } = await createUser({ credits: 5000 });
    await tokenFor(token);
    await tokenFor(token);
    expect(calls.filter(c => c.path === '/telephony_credentials')).toHaveLength(1);
    fakeApi.post.mockImplementationOnce(async () => {
      throw Object.assign(new Error('gone'), { response: { status: 404 } });
    });
    expect((await tokenFor(token)).data.token).toBe('jwt-login-token');
    expect(calls.filter(c => c.path === '/telephony_credentials')).toHaveLength(2);
  });

  test('balance rule is the same as Twilio: under 1 minute -> no token', async () => {
    const { token } = await createUser({ credits: 999 });
    const r = await request(app).get('/voice/token').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(402);
    expect(fakeApi.post).not.toHaveBeenCalled();
  });

  test('USE_TELNYX=false: Twilio exactly as before', async () => {
    env.USE_TELNYX = false;
    try {
      const { token } = await createUser({ credits: 5000 });
      const t = await tokenFor(token);
      expect(t.data.provider).toBe('twilio');
      expect(fakeApi.post).not.toHaveBeenCalled();
    } finally {
      env.USE_TELNYX = true;
    }
  });

  test('Telnyx switched on but not configured -> clear 503, not a crash', async () => {
    const keep = env.TELNYX_API_KEY;
    env.TELNYX_API_KEY = '';
    try {
      const { token } = await createUser({ credits: 5000 });
      const r = await request(app).get('/voice/token').set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('VOICE_NOT_CONFIGURED');
    } finally {
      env.TELNYX_API_KEY = keep;
    }
  });
});

describe('call reference', () => {
  test('forged, altered or expired references are refused', () => {
    const { ref } = telnyx.createCallRef('11111111-1111-4111-8111-111111111111');
    expect(telnyx.readCallRef(ref)).not.toBeNull();
    expect(telnyx.readCallRef(ref.replace('11111111-1111', '22222222-2222'))).toBeNull(); // other user
    expect(telnyx.readCallRef(`${ref.slice(0, -1)}0`)).toBeNull();
    expect(telnyx.readCallRef('nonsense')).toBeNull();
    const old = telnyx.createCallRef('11111111-1111-4111-8111-111111111111', Date.now() - 11 * 60 * 1000).ref;
    expect(telnyx.readCallRef(old)).toBeNull();
  });
});

describe('call flow', () => {
  test('dial with the balance as hard time limit, bridge on answer, bill once on hangup', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 1);
    const dial = calls.find(c => c.path === '/calls').body;
    expect(dial).toMatchObject({
      connection_id: 'voice-app-1',
      to: '+919876543210',
      from: '+918045000001',
      time_limit_secs: 300,
      webhook_url: 'https://api.test.local/voice/telnyx/webhook',
    });
    expect(await getCall(t.callSid)).toMatchObject({ provider: 'telnyx', provider_leg_id: 'app-1', child_call_sid: 'pstn-1', status: 'ringing' });

    await hook('call.answered', { call_control_id: 'pstn-1', client_state: dial.client_state });
    expect(actions('bridge')).toEqual(['app-1']);
    expect(calls.find(c => c.path.endsWith('/actions/bridge')).body).toEqual({ call_control_id: 'pstn-1' });
    expect((await getCall(t.callSid)).status).toBe('in-progress');

    await query("UPDATE calls SET answered_at = now() - interval '61 seconds' WHERE call_sid = $1", [t.callSid]);
    await hook('call.hangup', { call_control_id: 'pstn-1', hangup_cause: 'normal_clearing', client_state: dial.client_state });
    await hook('call.hangup', { call_control_id: 'pstn-1', hangup_cause: 'normal_clearing', client_state: dial.client_state }); // retry
    const c = await getCall(t.callSid);
    expect(c).toMatchObject({ billed: true, status: 'completed', talk_seconds: 61 });
    expect(await credits(user.id)).toBe(5000 - 1017);
    expect(actions('hangup')).toContain('app-1');
  });

  test('balance used up (time_limit) -> marked balance_finished', async () => {
    const { token } = await createUser({ credits: 1000 });
    const t = await placeCall(token, 2);
    await hook('call.answered', { call_control_id: 'pstn-1' });
    await query("UPDATE calls SET answered_at = now() - interval '60 seconds' WHERE call_sid = $1", [t.callSid]);
    await hook('call.hangup', { call_control_id: 'pstn-1', hangup_cause: 'time_limit' });
    expect(await getCall(t.callSid)).toMatchObject({ end_reason: 'balance_finished', talk_seconds: 60 });
  });

  test('user hangs up while it rings -> PSTN leg is cut, 0 credits', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 3);
    await hook('call.hangup', { call_control_id: 'app-3', hangup_cause: 'normal_clearing' });
    expect(actions('hangup')).toEqual(['pstn-1']);
    await hook('call.hangup', { call_control_id: 'pstn-1', hangup_cause: 'originator_cancel' });
    expect(await getCall(t.callSid)).toMatchObject({ billed: true, status: 'canceled', talk_seconds: 0 });
    expect(await credits(user.id)).toBe(5000);
  });

  test.each([
    ['user_busy', 'busy'],
    ['timeout', 'no-answer'],
    ['call_rejected', 'busy'],
    ['unallocated_number', 'failed'],
  ])('not answered (%s) -> %s, free', async (cause, status) => {
    const { user, token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 4);
    await hook('call.hangup', { call_control_id: 'pstn-1', hangup_cause: cause });
    expect(await getCall(t.callSid)).toMatchObject({ billed: true, status });
    expect(await credits(user.id)).toBe(5000);
  });

  test('Telnyx retrying call.initiated does not dial twice', async () => {
    const { token } = await createUser({ credits: 5000 });
    const t = await tokenFor(token);
    const ev = { call_control_id: 'app-5', connection_id: APP_CONN, direction: 'incoming', to: '+919876543210', custom_headers: t.data.sipHeaders };
    await hook('call.initiated', ev);
    await hook('call.initiated', ev);
    expect(dialCount).toBe(1);
  });

  test('the PSTN leg we dialled (outgoing on the voice app) is not treated as a new app call', async () => {
    await hook('call.initiated', { call_control_id: 'pstn-x', connection_id: 'voice-app-1', direction: 'outgoing', to: '+919876543210' });
    expect(fakeApi.post).not.toHaveBeenCalled();
  });
});

describe('refusals hang up the app leg and never dial', () => {
  test('no / forged reference', async () => {
    await hook('call.initiated', { call_control_id: 'app-9', connection_id: APP_CONN, direction: 'incoming', to: '+919876543210' });
    expect(actions('hangup')).toEqual(['app-9']);
    expect(dialCount).toBe(0);
  });

  test('reference sent from another user\'s login', async () => {
    const { token } = await createUser({ credits: 5000 });
    const t = await tokenFor(token);
    await hook('call.initiated', {
      call_control_id: 'app-10',
      connection_id: APP_CONN,
      direction: 'incoming',
      from: 'sip:gencred999@sip.telnyx.com',
      to: '+919876543210',
      custom_headers: t.data.sipHeaders,
    });
    expect(dialCount).toBe(0);
    expect(actions('hangup')).toEqual(['app-10']);
  });

  test('emergency number', async () => {
    const { token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 11, '112');
    expect(dialCount).toBe(0);
    expect(await getCall(t.callSid)).toMatchObject({ status: 'blocked', billed: true });
  });

  test('balance spent between token and dial', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    const t = await tokenFor(token);
    await query('UPDATE wallets SET credits = 10 WHERE user_id = $1', [user.id]);
    await hook('call.initiated', { call_control_id: 'app-12', connection_id: APP_CONN, direction: 'incoming', to: '+919876543210', custom_headers: t.data.sipHeaders });
    expect(dialCount).toBe(0);
    expect((await getCall(t.data.callSid)).status).toBe('insufficient-credit');
  });

  test('dial rejected by Telnyx (e.g. India not allowed) -> call closed free, app leg hung up, admin alerted', async () => {
    const notify = jest.spyOn(alerts, 'notify').mockResolvedValue();
    const { user, token } = await createUser({ credits: 5000 });
    const t = await tokenFor(token);
    fakeApi.post.mockImplementationOnce(async () => {
      throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
    });
    await hook('call.initiated', { call_control_id: 'app-13', connection_id: APP_CONN, direction: 'incoming', to: '+919876543210', custom_headers: t.data.sipHeaders });
    expect(await getCall(t.data.callSid)).toMatchObject({ billed: true, status: 'failed' });
    expect(actions('hangup')).toEqual(['app-13']);
    expect(await credits(user.id)).toBe(5000);
    expect(notify).toHaveBeenCalled();
  });
});

describe('webhook signature', () => {
  const ev = { data: { event_type: 'call.hangup', payload: { call_control_id: 'x' } } };
  test('valid Ed25519 signature accepted; tampered body, wrong key, old timestamp refused', async () => {
    const ok = signed(ev);
    expect((await request(app).post('/voice/telnyx/webhook').set(ok.headers).send(ok.raw)).status).toBe(200);
    expect((await request(app).post('/voice/telnyx/webhook').set(ok.headers).send(ok.raw.replace('x', 'y'))).status).toBe(403);
    const other = signed(ev, { key: crypto.generateKeyPairSync('ed25519').privateKey });
    expect((await request(app).post('/voice/telnyx/webhook').set(other.headers).send(other.raw)).status).toBe(403);
    const old = signed(ev, { ts: Math.floor(Date.now() / 1000) - 600 });
    expect((await request(app).post('/voice/telnyx/webhook').set(old.headers).send(old.raw)).status).toBe(403);
    expect((await request(app).post('/voice/telnyx/webhook').send(ev)).status).toBe(403);
  });
});

describe('around the call', () => {
  test('recording on a Telnyx call says it is not available (instead of failing half-way)', async () => {
    const { token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 20);
    const r = await request(app).post('/voice/recording/start').set('Authorization', `Bearer ${token}`).send({ callSid: t.callSid });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('RECORDING_UNAVAILABLE');
  });

  test('the app can read its Telnyx call by the id it got with the token', async () => {
    const { token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 21);
    const r = await request(app).get(`/calls/${t.callSid}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  test('caller IDs stay per provider (a Twilio number is never sent to Telnyx)', async () => {
    expect(await voice.pickCallerId('telnyx')).toBe('+918045000001');
    expect(['+911140000001', '+911140000002']).toContain(await voice.pickCallerId('twilio'));
  });

  test('safety job: lost hangup webhook -> waits while alive, then bills 0 and alerts (never guesses)', async () => {
    const notify = jest.spyOn(alerts, 'notify').mockResolvedValue();
    const { user, token } = await createUser({ credits: 5000 });
    const t = await placeCall(token, 22);
    await hook('call.answered', { call_control_id: 'pstn-1' });
    await query("UPDATE calls SET started_at = now() - interval '20 minutes' WHERE call_sid = $1", [t.callSid]);
    alive = true;
    await unbilledJob.run();
    expect((await getCall(t.callSid)).billed).toBe(false);
    alive = false;
    await unbilledJob.run();
    expect(await getCall(t.callSid)).toMatchObject({ billed: true, talk_seconds: 0 });
    expect(await credits(user.id)).toBe(5000);
    expect(notify.mock.calls.map(c => c[0]).join(' ')).toMatch(/without a hangup webhook/);
  });
});

describe('env checks', () => {
  const { validate } = require('../src/config/env');
  const boot = over => {
    const keep = process.env;
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env = { ...keep, ...over };
      validate();
      return { exited: exit.mock.calls.length > 0, msg: err.mock.calls.flat().join(' ') };
    } finally {
      process.env = keep;
      exit.mockRestore();
      err.mockRestore();
    }
  };
  test('USE_TELNYX=true without its keys stops the server with the list of missing keys', () => {
    const r = boot({ USE_TELNYX: 'true', TELNYX_API_KEY: '', TELNYX_CONNECTION_ID: '' });
    expect(r.exited).toBe(true);
    expect(r.msg).toMatch(/TELNYX_API_KEY is missing/);
    expect(r.msg).toMatch(/TELNYX_CONNECTION_ID is missing/);
  });
  test('typo in the flag is caught', () => {
    expect(boot({ USE_TELNYX: 'yes' }).msg).toMatch(/USE_TELNYX must be true or false/);
  });
  test('production on Telnyx needs the webhook public key, but not the Twilio keys', () => {
    const base = {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'x'.repeat(64),
      JWT_REFRESH_SECRET: 'x'.repeat(64),
      PUBLIC_BASE_URL: 'https://api.callkaro.in',
      USE_TELNYX: 'true',
      TELNYX_API_KEY: 'k',
      TELNYX_CONNECTION_ID: 'c',
      TELNYX_CALL_CONTROL_APP_ID: 'a',
      TELNYX_CALLER_ID_POOL: '+918045000001',
      TWILIO_ACCOUNT_SID: 'AC1', // half a Twilio setup is fine while Telnyx is the provider
      TWILIO_API_KEY_SID: '',
    };
    expect(boot({ ...base, TELNYX_PUBLIC_KEY: '' }).msg).toMatch(/TELNYX_PUBLIC_KEY is missing/);
    expect(boot({ ...base, TELNYX_PUBLIC_KEY: RAW_PUBLIC }).exited).toBe(false);
  });
});
