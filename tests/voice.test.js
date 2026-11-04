const twilio = require('twilio');
const request = require('supertest');
const app = require('../src/app');
const voice = require('../src/services/voice.service');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

const getCall = callSid => queryOne('SELECT * FROM calls WHERE call_sid = $1', [callSid]);

const BASE = 'https://api.test.local';
const AUTH = 'twilio-auth-token';

// Sends a webhook exactly like Twilio would (urlencoded + valid X-Twilio-Signature).
const twilioPost = (path, params) =>
  request(app)
    .post(path)
    .type('form')
    .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(AUTH, `${BASE}${path}`, params))
    .send(params);

const sid = n => `CA${String(n).padStart(32, '0')}`;

beforeAll(async () => {
  await startDb();
});
beforeEach(async () => {
  await voice.syncCallerPool();
});
afterAll(stopDb);
afterEach(clearDb);

describe('voice webhooks', () => {
  test('unsigned webhook is rejected', async () => {
    const r = await request(app).post('/voice/outbound').type('form').send({ To: '+919876543210' });
    expect(r.status).toBe(403);
  });

  test('normal call -> Dial with timeLimit from credits and an owned caller ID', async () => {
    const { user } = await createUser({ credits: 2250 });
    const r = await twilioPost('/voice/outbound', { CallSid: sid(1), From: `client:${user.id}`, To: '9876543210' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('timeLimit="135"');
    expect(r.text).toMatch(/callerId="\+91114000000[12]"/);
    expect(r.text).toContain('<Number');
    expect(r.text).toContain('+919876543210');
    const call = await getCall(sid(1));
    expect(call.max_seconds).toBe(135);
  });

  test('insufficient balance -> message + hangup, nothing billed', async () => {
    const { user } = await createUser({ credits: 999 });
    const r = await twilioPost('/voice/outbound', { CallSid: sid(2), From: `client:${user.id}`, To: '+919876543210' });
    expect(r.text).toContain('balance is too low');
    expect(r.text).toContain('<Hangup');
    expect(r.text).not.toContain('<Dial');
  });

  test('blocked / opted-out number -> no Dial', async () => {
    const { user } = await createUser({ credits: 5000 });
    await query("INSERT INTO blocked_numbers (e164, reason) VALUES ('+919876500000', 'opt_out')");
    const r = await twilioPost('/voice/outbound', { CallSid: sid(3), From: `client:${user.id}`, To: '+919876500000' });
    expect(r.text).not.toContain('<Dial');
  });

  test('emergency number -> told to use the phone dialer', async () => {
    const { user } = await createUser({ credits: 5000 });
    const r = await twilioPost('/voice/outbound', { CallSid: sid(4), From: `client:${user.id}`, To: '112' });
    expect(r.text).toContain('phone dialer');
    expect(r.text).not.toContain('<Dial');
  });

  test('dial-complete bills per second, idempotent on callSid', async () => {
    const { user } = await createUser({ credits: 5000 });
    await twilioPost('/voice/outbound', { CallSid: sid(5), From: `client:${user.id}`, To: '+919876543210' });
    const params = { CallSid: sid(5), DialCallSid: sid(55), DialCallStatus: 'completed', DialCallDuration: '61' };
    await twilioPost('/voice/dial-complete', params);
    await twilioPost('/voice/dial-complete', params); // webhook retry
    expect(await credits(user.id)).toBe(5000 - 1017);
    expect((await queryOne("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE type = 'call_charge' AND ref_id = $1", [sid(5)])).n).toBe(1);
    const call = await getCall(sid(5));
    expect(call.billed).toBe(true);
    expect(call.talk_seconds).toBe(61);
  });

  test('busy / no-answer -> 0 credits', async () => {
    const { user } = await createUser({ credits: 5000 });
    await twilioPost('/voice/outbound', { CallSid: sid(6), From: `client:${user.id}`, To: '+919876543210' });
    await twilioPost('/voice/dial-complete', { CallSid: sid(6), DialCallStatus: 'busy', DialCallDuration: '0' });
    expect(await credits(user.id)).toBe(5000);
    expect((await getCall(sid(6))).status).toBe('busy');
  });

  test('status webhook records answer time', async () => {
    const { user } = await createUser({ credits: 5000 });
    await twilioPost('/voice/outbound', { CallSid: sid(7), From: `client:${user.id}`, To: '+919876543210' });
    await twilioPost('/voice/status', { CallSid: sid(77), ParentCallSid: sid(7), CallStatus: 'in-progress' });
    const call = await getCall(sid(7));
    expect(call.status).toBe('in-progress');
    expect(call.answered_at).toBeTruthy();
    expect(call.child_call_sid).toBe(sid(77));
  });

  test('inbound call-back plays the identification message', async () => {
    const r = await twilioPost('/voice/inbound', { From: '+919800000000', To: '+911140000001' });
    expect(r.text).toContain('used by');
    expect(r.text).toContain('internet calls');
  });

  test('voice token requires >= 1000 credits', async () => {
    const { token } = await createUser({ credits: 500 });
    const r = await request(app).get('/voice/token').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('INSUFFICIENT_CREDITS');
    const { token: t2 } = await createUser({ credits: 1000 });
    const ok = await request(app).get('/voice/token').set('Authorization', `Bearer ${t2}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.maxSeconds).toBe(60);
    expect(ok.body.data.token.split('.')).toHaveLength(3);
  });

  test('max 3 calls per hour to the same number', async () => {
    const { user } = await createUser({ credits: 50000 });
    for (let i = 0; i < 3; i++) {
      await query(
        "INSERT INTO calls (user_id, call_sid, to_number, status, billed) VALUES ($1, $2, '+919876543210', 'completed', TRUE)",
        [user.id, sid(100 + i)],
      );
    }
    const r = await twilioPost('/voice/outbound', { CallSid: sid(200), From: `client:${user.id}`, To: '+919876543210' });
    expect(r.text).not.toContain('<Dial');
  });
});
