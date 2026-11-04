// Phase 24 server: missed-webhook billing job, alerts, reconciliation, /calls for the app.
const twilio = require('twilio');
const request = require('supertest');
const app = require('../src/app');
const voice = require('../src/services/voice.service');
const alerts = require('../src/services/alert.service');
const unbilled = require('../src/jobs/unbilledCalls.job');
const spendGuard = require('../src/jobs/spendGuard.job');
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
const getCall = s => queryOne('SELECT * FROM calls WHERE call_sid = $1', [s]);
const age = (n, minutes) =>
  query("UPDATE calls SET started_at = now() - ($1 || ' minutes')::interval WHERE call_sid = $2", [String(minutes), sid(n)]);

const children = {};
const fakeRest = {
  calls: callSid => ({
    fetch: async () => {
      const c = children[callSid];
      if (!c) {
        throw Object.assign(new Error('not found'), { status: 404 });
      }
      return c;
    },
  }),
};

beforeAll(startDb);
beforeEach(async () => {
  await voice.syncCallerPool();
  voice.setRestClientForTest(fakeRest);
  Object.keys(children).forEach(k => delete children[k]);
  jest.spyOn(alerts, 'notify').mockResolvedValue(undefined);
});
afterAll(stopDb);
afterEach(async () => {
  await clearDb();
  jest.restoreAllMocks();
});

const dial = (user, n) => post('/voice/outbound', { CallSid: sid(n), From: `client:${user.id}`, To: '+919876543210' });
const answered = n => post('/voice/status', { CallSid: `CAchild${n}`, ParentCallSid: sid(n), CallStatus: 'in-progress' });

describe('unbilled calls job (P24.T18-T19)', () => {
  test('dial-complete webhook lost -> job bills the real duration from the provider', async () => {
    const { user } = await createUser({ credits: 5000 });
    await dial(user, 1);
    await answered(1);
    children.CAchild1 = { status: 'completed', duration: '61' };
    await age(1, 10);
    expect(await unbilled.run()).toEqual({ found: 1, billed: 1, failed: 0 });
    expect(await credits(user.id)).toBe(5000 - 1017);
    expect(await getCall(sid(1))).toMatchObject({ billed: true, talk_seconds: 61 });
  });

  test('a long call still running is left alone', async () => {
    const { user } = await createUser({ credits: 50000 });
    await dial(user, 2);
    await answered(2);
    children.CAchild2 = { status: 'in-progress', duration: null };
    await age(2, 20);
    expect(await unbilled.run()).toEqual({ found: 1, billed: 0, failed: 0 });
    expect((await getCall(sid(2))).billed).toBe(false);
  });

  test('never reached the callee -> closed as no-answer with 0 credits', async () => {
    const { user } = await createUser({ credits: 5000 });
    await dial(user, 3);
    await age(3, 10);
    await unbilled.run();
    expect(await getCall(sid(3))).toMatchObject({ billed: true, status: 'no-answer' });
    expect(await credits(user.id)).toBe(5000);
  });

  test('fresh calls (< 5 min) are not touched; already billed never charged twice', async () => {
    const { user } = await createUser({ credits: 5000 });
    await dial(user, 4);
    expect((await unbilled.run()).found).toBe(0);
    await post('/voice/dial-complete', { CallSid: sid(4), DialCallStatus: 'completed', DialCallDuration: '30' });
    await age(4, 30);
    expect((await unbilled.run()).found).toBe(0);
    expect(await credits(user.id)).toBe(5000 - 500);
  });

  test('provider lookup fails -> attempt counted, alert sent, retried next run', async () => {
    const { user } = await createUser({ credits: 5000 });
    await dial(user, 5);
    await answered(5); // child CAchild5 unknown to the fake provider -> 404
    await age(5, 10);
    expect(await unbilled.run()).toEqual({ found: 1, billed: 0, failed: 1 });
    expect((await getCall(sid(5))).billing_attempts).toBe(1);
    expect(alerts.notify).toHaveBeenCalledWith(expect.stringMatching(/could not be billed/), expect.any(Object));
    children.CAchild5 = { status: 'completed', duration: '10' };
    expect((await unbilled.run()).billed).toBe(1);
  });

  test('a call that was answered for longer than the balance allowed is capped at maxSeconds', async () => {
    const { user } = await createUser({ credits: 1000 }); // maxSeconds 60
    await dial(user, 6);
    await answered(6);
    children.CAchild6 = { status: 'completed', duration: '75' };
    await age(6, 10);
    await unbilled.run();
    expect(await credits(user.id)).toBe(0);
    expect((await getCall(sid(6))).talk_seconds).toBe(60);
  });
});

describe('reconciliation + alerts', () => {
  test('nightly reconcile alerts on a wallet that does not match its ledger', async () => {
    const { user } = await createUser({ credits: 1000 });
    expect(await spendGuard.reconcile()).toEqual([]);
    await query('UPDATE wallets SET credits = credits + 5 WHERE user_id = $1', [user.id]); // simulated corruption
    expect(await spendGuard.reconcile()).toEqual([expect.objectContaining({ userId: user.id, diff: 5 })]);
    expect(alerts.notify).toHaveBeenCalledWith(expect.stringMatching(/reconciliation/i), expect.any(Object));
  });
});

describe('GET /calls (P24.T07-T08)', () => {
  test('own calls only, newest first, paged; refused (blocked) calls hidden', async () => {
    const a = await createUser({ credits: 50000 });
    const b = await createUser({ credits: 50000 });
    for (let i = 10; i < 13; i++) {
      await dial(a.user, i);
      await post('/voice/dial-complete', { CallSid: sid(i), DialCallStatus: 'completed', DialCallDuration: '5' });
    }
    await dial(b.user, 20);
    await post('/voice/outbound', { CallSid: sid(21), From: `client:${a.user.id}`, To: '112' }); // refused
    const r = await request(app).get('/calls?limit=2').set('Authorization', `Bearer ${a.token}`);
    expect(r.body.data).toMatchObject({ total: 3, hasMore: true });
    expect(r.body.data.items).toHaveLength(2);
    const one = await request(app).get(`/calls/${sid(20)}`).set('Authorization', `Bearer ${a.token}`);
    expect(one.status).toBe(404);
    const mine = await request(app).get(`/calls/${sid(10)}`).set('Authorization', `Bearer ${a.token}`);
    expect(mine.body.data).toMatchObject({ billed: true, talkSeconds: 5, credits: 84, status: 'completed' });
  });
});
