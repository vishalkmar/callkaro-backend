// Phase 20 extras: atomic one-call-per-user, cancelled-while-ringing, no unbillable calls,
// caller-ID pool, report auto-block, token content, signature rules.
const twilio = require('twilio');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const voice = require('../src/services/voice.service');
const { env } = require('../src/config/env');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

const BASE = 'https://api.test.local';
const AUTH = 'twilio-auth-token';
const post = (path, params) =>
  request(app)
    .post(path)
    .type('form')
    .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(AUTH, `${BASE}${path}`, params))
    .send(params);
const sid = n => `CA${String(n).padStart(32, '0')}`;
const outbound = (userId, n, to = '+919876543210') =>
  post('/voice/outbound', { CallSid: sid(n), From: `client:${userId}`, To: to, AccountSid: 'AC1' });
const getCall = callSid => queryOne('SELECT * FROM calls WHERE call_sid = $1', [callSid]);

beforeAll(startDb);
beforeEach(() => voice.syncCallerPool());
afterAll(stopDb);
afterEach(async () => {
  await clearDb();
  jest.restoreAllMocks();
});

describe('one call at a time (P20.T16)', () => {
  test('BUG FIX: two devices dialling at the same moment -> only ONE call gets a Dial', async () => {
    const { user } = await createUser({ credits: 5000 });
    const [a, b] = await Promise.all([outbound(user.id, 1), outbound(user.id, 2, '+918888888888')]);
    const dials = [a.text, b.text].filter(x => x.includes('<Dial'));
    expect(dials).toHaveLength(1);
    expect((await queryOne("SELECT COUNT(*)::int AS n FROM calls WHERE status = 'initiated'")).n).toBe(1);
  });

  test('BUG FIX: hanging up while it rings closes the call at once (0 credits) so the next call works', async () => {
    const { user } = await createUser({ credits: 5000 });
    await outbound(user.id, 3);
    await post('/voice/status', { CallSid: sid(3), CallStatus: 'completed' }); // parent leg ended, no Dial action
    const c = await getCall(sid(3));
    expect(c).toMatchObject({ billed: true, status: 'canceled', talk_seconds: 0 });
    expect(Number(c.credits)).toBe(0);
    expect((await outbound(user.id, 4)).text).toContain('<Dial');
    expect(await credits(user.id)).toBe(5000);
  });

  test('parent leg ending AFTER answer waits for dial-complete to bill the real duration', async () => {
    const { user } = await createUser({ credits: 5000 });
    await outbound(user.id, 5);
    await post('/voice/status', { CallSid: 'CAchild5', ParentCallSid: sid(5), CallStatus: 'in-progress' });
    await post('/voice/status', { CallSid: sid(5), CallStatus: 'completed' });
    expect((await getCall(sid(5))).billed).toBe(false);
    await post('/voice/dial-complete', { CallSid: sid(5), DialCallStatus: 'completed', DialCallDuration: '61' });
    expect(await credits(user.id)).toBe(5000 - 1017);
  });

  test('BUG FIX: if the call row cannot be saved, the call is NOT dialled (it could never be billed)', async () => {
    const { user } = await createUser({ credits: 5000 });
    await query("ALTER TABLE calls ADD CONSTRAINT tmp_fail CHECK (to_number <> '+919876543210')");
    try {
      const r = await outbound(user.id, 6);
      expect(r.text).not.toContain('<Dial');
      expect(r.text).toContain('<Hangup');
    } finally {
      await query('ALTER TABLE calls DROP CONSTRAINT tmp_fail');
    }
  });

  test('Twilio retrying the same CallSid gets the same Dial (the live call is not cut)', async () => {
    const { user } = await createUser({ credits: 5000 });
    const first = await outbound(user.id, 7);
    const retry = await outbound(user.id, 7);
    expect(retry.text).toBe(first.text);
    expect((await queryOne('SELECT COUNT(*)::int AS n FROM calls')).n).toBe(1);
  });
});

describe('caller ID + TwiML (P20.T03, T10-T11)', () => {
  test('caller ID only from the owned pool, least recently used first', async () => {
    env.CALLER_ID_POOL.splice(0, env.CALLER_ID_POOL.length, '+911140000001', '+911140000002');
    await voice.syncCallerPool();
    const a = await createUser({ credits: 5000 });
    const b = await createUser({ credits: 5000 });
    const ra = await outbound(a.user.id, 10);
    const rb = await outbound(b.user.id, 11);
    const ids = [ra.text, rb.text].map(t => /callerId="([^"]+)"/.exec(t)[1]);
    expect(new Set(ids)).toEqual(new Set(['+911140000001', '+911140000002']));
    expect(ra.text).toMatch(/timeLimit="300"/); // 5000 credits = 5 min
    expect(ra.text).toMatch(/action="https:\/\/api.test.local\/voice\/dial-complete"/);
  });

  test('a To number the user typed can never become TwiML/XML', async () => {
    const { user } = await createUser({ credits: 5000 });
    const r = await outbound(user.id, 12, '98765"/><Dial><Number>+911</Number>');
    expect(r.text).not.toContain('<Dial');
  });

  test('exactly 59 seconds of balance (983 credits) is refused; 1000 is allowed', async () => {
    const low = await createUser({ credits: 983 });
    expect((await outbound(low.user.id, 13)).text).not.toContain('<Dial');
    const ok = await createUser({ credits: 1000 });
    expect((await outbound(ok.user.id, 14)).text).toMatch(/timeLimit="60"/);
  });
});

describe('token + signatures (P20.T07-T08)', () => {
  test('voice token: Twilio JWT for this user, outgoing only, 10 min', async () => {
    Object.assign(env, { TWILIO_ACCOUNT_SID: 'AC123', TWILIO_API_KEY_SID: 'SK123', TWILIO_API_KEY_SECRET: 'secret', TWILIO_TWIML_APP_SID: 'AP123' });
    const { user, token } = await createUser({ credits: 2500 });
    const r = await request(app).get('/voice/token').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.maxSeconds).toBe(150);
    const decoded = jwt.decode(r.body.data.token);
    expect(decoded.grants.identity).toBe(user.id);
    expect(decoded.grants.voice.outgoing.application_sid).toBe('AP123');
    expect(decoded.grants.voice.incoming?.allow).toBeFalsy();
    expect(decoded.exp - decoded.iat).toBe(600);
  });

  test('signature over a different URL (replay to another endpoint) is refused', async () => {
    const params = { CallSid: sid(20), DialCallStatus: 'completed', DialCallDuration: '9999' };
    const sig = twilio.getExpectedTwilioSignature(AUTH, `${BASE}/voice/status`, params);
    const r = await request(app).post('/voice/dial-complete').type('form').set('X-Twilio-Signature', sig).send(params);
    expect(r.status).toBe(403);
  });
});

describe('reports (P20.T17)', () => {
  test('3 public reports against the same caller auto-block the user and revoke sessions', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    await outbound(user.id, 30, '+917000000001');
    for (const n of ['+917000000001', '+917000000001', '+917000000001']) {
      await request(app).post('/report/public').send({ myNumber: n, reason: 'harassment' });
    }
    expect((await queryOne('SELECT status FROM users WHERE id = $1', [user.id])).status).toBe('blocked');
    const r = await request(app).get('/wallet').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
  });
});
