// Phase 27: tests for the parts coverage showed as weak - alerts, daily stats, admin routes,
// error mapping, abuse limits, account deletion.
const twilio = require('twilio');
const axios = require('axios');
const express = require('express');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const voice = require('../src/services/voice.service');
const alerts = require('../src/services/alert.service');
const { dailyStats } = require('../src/services/stats.service');
const spendGuard = require('../src/jobs/spendGuard.job');
const { errorHandler } = require('../src/middlewares/error');
const walletService = require('../src/services/wallet.service');
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
const admin = { 'X-Admin-Key': env.ADMIN_API_KEY };

beforeAll(startDb);
beforeEach(() => voice.syncCallerPool());
afterAll(stopDb);
afterEach(async () => {
  await clearDb();
  jest.restoreAllMocks();
});

describe('alert service', () => {
  const realIsTest = env.isTest;
  afterEach(() => {
    env.isTest = realIsTest;
    env.ALERT_WEBHOOK_URL = undefined;
    alerts._lastSent.clear();
  });

  test('posts to the webhook, de-duplicates, never throws when the webhook is down', async () => {
    env.isTest = false;
    env.ALERT_WEBHOOK_URL = 'https://hooks.example/abc';
    const postSpy = jest.spyOn(axios, 'post').mockResolvedValue({});
    await alerts.notify('Spend high', { dedupeKey: 'spend' });
    await alerts.notify('Spend high again', { dedupeKey: 'spend' });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][1].text).toBe('[CallingKaro] Spend high');
    postSpy.mockRejectedValueOnce(new Error('down'));
    await expect(alerts.notify('other', { dedupeKey: 'x' })).resolves.toBeUndefined();
  });

  test('BUG FIX: the de-duplication map stays bounded with many unique alerts', async () => {
    env.isTest = false;
    env.ALERT_WEBHOOK_URL = 'https://hooks.example/abc';
    jest.spyOn(axios, 'post').mockResolvedValue({});
    for (let i = 0; i < 2000; i++) {
      await alerts.notify(`Billing failed for call ${i}`);
    }
    expect(alerts._lastSent.size).toBeLessThanOrEqual(501);
  });
});

describe('daily stats + spend guard', () => {
  test('counts users, calls, minutes, revenue, ad rewards and margin for today', async () => {
    const { user } = await createUser({ credits: 100000 });
    await post('/voice/outbound', { CallSid: sid(1), From: `client:${user.id}`, To: '+919876543210' });
    await post('/voice/dial-complete', { CallSid: sid(1), DialCallStatus: 'completed', DialCallDuration: '120' });
    await query(
      `INSERT INTO orders (user_id, package_id, amount_paise, credits, minutes, provider, status, paid_at)
       VALUES ($1, 'minutes_80', 10000, 80000, 80, 'play', 'paid', now())`,
      [user.id],
    );
    await query(
      "INSERT INTO ad_rewards (user_id, transaction_id, purpose, credits) VALUES ($1, 'ad1', 'credits', 250)",
      [user.id],
    );
    const s = await dailyStats();
    expect(s).toMatchObject({
      newUsers: 1,
      calls: 1,
      talkMinutes: 2,
      creditsCharged: 2000,
      orders: 1,
      revenueInr: 100,
      adRewards: 1,
      adCreditsGiven: 250,
    });
    expect(s.estProviderCostInr).toBe((2 * env.PROVIDER_COST_PAISE_PER_MIN) / 100);
    expect(s.estGrossMarginInr).toBeCloseTo(100 - s.estProviderCostInr);
  });

  test('spend guard alerts only above the threshold', async () => {
    const spy = jest.spyOn(alerts, 'notify').mockResolvedValue();
    await spendGuard.run();
    expect(spy).not.toHaveBeenCalled();
    const saved = env.DAILY_TELEPHONY_SPEND_ALERT_INR;
    env.DAILY_TELEPHONY_SPEND_ALERT_INR = -1;
    await spendGuard.run();
    env.DAILY_TELEPHONY_SPEND_ALERT_INR = saved;
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/Telephony spend/), expect.any(Object));
  });
});

describe('admin routes', () => {
  test('block + unblock a user; blocked user is locked out at once', async () => {
    const { user, token } = await createUser();
    const r = await request(app).post(`/admin/users/${user.id}/block`).set(admin).send({ reason: 'abuse' });
    expect(r.body.data.status).toBe('blocked');
    expect((await request(app).get('/wallet').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    await request(app).post(`/admin/users/${user.id}/block`).set(admin).send({ reason: 'ok', unblock: true });
    expect((await queryOne('SELECT status FROM users WHERE id = $1', [user.id])).status).toBe('active');
    expect((await request(app).post('/admin/users/not-a-uuid/block').set(admin).send({ reason: 'x' })).status).toBe(404);
  });

  test('block a number for N days; normalised to E.164', async () => {
    const r = await request(app).post('/admin/numbers/block').set(admin).send({ number: '098765 43210', days: 7, reason: 'harassment' });
    expect(r.body.data.e164).toBe('+919876543210');
    const row = await queryOne("SELECT reason, until FROM blocked_numbers WHERE e164 = '+919876543210'");
    expect(row.reason).toBe('harassment');
    expect(new Date(row.until) - Date.now()).toBeGreaterThan(6 * 86400e3);
    expect((await request(app).post('/admin/numbers/block').set(admin).send({ number: '12' })).status).toBe(400);
  });

  test('open reports list + daily stats endpoint', async () => {
    const { token } = await createUser();
    await request(app).post('/report').set('Authorization', `Bearer ${token}`).send({ reason: 'app_problem', details: 'x' });
    const reports = await request(app).get('/admin/reports').set(admin);
    expect(reports.body.data).toHaveLength(1);
    const stats = await request(app).get('/admin/stats/daily').set(admin);
    expect(stats.body.data).toHaveProperty('estGrossMarginInr');
  });
});

describe('error mapping', () => {
  const run = err => {
    const a = express();
    a.get('/x', () => {
      throw err;
    });
    a.use(errorHandler);
    return request(a).get('/x');
  };
  test('BUG FIX: Postgres bad-input errors are 400 / duplicates 409, not 500', async () => {
    expect((await run(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }))).status).toBe(400);
    expect((await run(Object.assign(new Error('duplicate key'), { code: '23505' }))).body.code).toBe('CONFLICT');
  });
  test('unknown errors -> 500 without leaking details', async () => {
    const r = await run(new Error('secret internal detail'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('secret internal detail');
  });
});

describe('abuse limits', () => {
  test('max distinct numbers per day', async () => {
    const saved = require('../src/config/economy').MAX_DISTINCT_NUMBERS_PER_DAY;
    require('../src/config/economy').MAX_DISTINCT_NUMBERS_PER_DAY = 2;
    try {
      const { user } = await createUser({ credits: 50000 });
      for (const [n, to] of [
        [1, '+919000000001'],
        [2, '+919000000002'],
      ]) {
        await post('/voice/outbound', { CallSid: sid(n), From: `client:${user.id}`, To: to });
        await post('/voice/dial-complete', { CallSid: sid(n), DialCallStatus: 'busy', DialCallDuration: '0' });
      }
      const third = await post('/voice/outbound', { CallSid: sid(3), From: `client:${user.id}`, To: '+919000000003' });
      expect(third.text).not.toContain('<Dial');
      const again = await post('/voice/outbound', { CallSid: sid(4), From: `client:${user.id}`, To: '+919000000001' });
      expect(again.text).toContain('<Dial'); // a number already called today is still fine
    } finally {
      require('../src/config/economy').MAX_DISTINCT_NUMBERS_PER_DAY = saved;
    }
  });

  test('max calls per hour -> voice token refused', async () => {
    const { user, token } = await createUser({ credits: 50000 });
    Object.assign(env, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_KEY_SID: 'SK1', TWILIO_API_KEY_SECRET: 's', TWILIO_TWIML_APP_SID: 'AP1' });
    for (let i = 0; i < 30; i++) {
      await query(
        "INSERT INTO calls (user_id, call_sid, to_number, status, billed) VALUES ($1, $2, '+919000000009', 'busy', TRUE)",
        [user.id, sid(100 + i)],
      );
    }
    const r = await request(app).get('/voice/token').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('HOURLY_CALL_LIMIT');
  });
});

describe('account deletion (DPDP)', () => {
  test('profile anonymised, sessions removed, billing rows kept, no second welcome bonus on the same phone', async () => {
    const { user, token } = await createUser({ credits: 3000, deviceId: 'phone-1' });
    await walletService.applyChange(user.id, -1000, 'call_charge', 'CAkept');
    const r = await request(app).delete('/me').set('Authorization', `Bearer ${token}`);
    expect(r.body.data.deleted).toBe(true);
    const u = await queryOne('SELECT * FROM users WHERE id = $1', [user.id]);
    expect(u.status).toBe('deleted');
    expect(u.email).toMatch(/@deleted\.invalid$/);
    expect((await queryOne('SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1', [user.id])).n).toBe(0);
    expect((await queryOne("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE ref_id = 'CAkept'")).n).toBe(1);
    expect((await request(app).get('/wallet').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect(await credits(user.id)).toBe(2000); // kept for the legally required records, not usable
  });
});
