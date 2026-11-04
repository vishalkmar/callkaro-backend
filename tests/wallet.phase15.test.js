// Phase 15 API-level checks on Postgres: wallet endpoints, ledger paging, check-in, config,
// admin adjust, client can never choose amounts, package validation, limits.
const request = require('supertest');
const app = require('../src/app');
const economy = require('../src/config/economy');
const walletService = require('../src/services/wallet.service');
const { env } = require('../src/config/env');
const { startDb, stopDb, clearDb, createUser, credits, queryOne } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

const auth = token => ({ Authorization: `Bearer ${token}` });

describe('GET /wallet and /wallet/ledger (P15.T06-T07)', () => {
  test('balance, floor(minutes), last 5 entries newest first', async () => {
    const { user, token } = await createUser({ credits: 2999 });
    for (let i = 1; i <= 6; i++) {
      await walletService.applyChange(user.id, 10 * i, 'ad_reward', `t${i}`);
    }
    const r = await request(app).get('/wallet').set(auth(token));
    expect(r.status).toBe(200);
    expect(r.body.data.credits).toBe(2999 + 210);
    expect(r.body.data.minutes).toBe(3);
    expect(r.body.data.lastEntries).toHaveLength(5);
    expect(r.body.data.lastEntries[0].refId).toBe('t6');
    expect(r.body.data.lastEntries[0]).toMatchObject({ type: 'ad_reward', amount: 60, balanceAfter: 3209 });
  });

  test('ledger pages of 30 without gaps or repeats', async () => {
    const { user, token } = await createUser();
    for (let i = 0; i < 65; i++) {
      await walletService.applyChange(user.id, 1, 'ad_reward', `p${i}`);
    }
    const pages = [];
    for (let p = 1; p <= 3; p++) {
      pages.push((await request(app).get(`/wallet/ledger?page=${p}`).set(auth(token))).body.data);
    }
    expect(pages.map(p => p.items.length)).toEqual([30, 30, 5]);
    expect(pages.map(p => p.hasMore)).toEqual([true, true, false]);
    const ids = pages.flatMap(p => p.items.map(i => i.refId));
    expect(new Set(ids).size).toBe(65);
    expect((await request(app).get('/wallet/ledger?page=0').set(auth(token))).status).toBe(400);
  });

  test('another user never sees my ledger', async () => {
    const a = await createUser({ credits: 5000 });
    const b = await createUser();
    const r = await request(app).get('/wallet/ledger').set(auth(b.token));
    expect(r.body.data.items).toEqual([]);
    expect(a.user.id).not.toBe(b.user.id);
  });
});

describe('config + check-in (P15.T17-T18)', () => {
  test('GET /wallet/config lists packages, ad + spin status, check-in', async () => {
    const { token } = await createUser();
    const r = await request(app).get('/wallet/config').set(auth(token));
    expect(r.body.data.creditsPerMinute).toBe(1000);
    expect(r.body.data.packages.map(p => [p.id, p.priceInr, p.minutes, p.credits])).toEqual([
      ['minutes_80', 100, 80, 80000],
      ['minutes_170', 200, 170, 170000],
      ['minutes_270', 300, 270, 270000],
      ['minutes_475', 500, 475, 475000],
    ]);
    expect(r.body.data.packages[2].badge).toBe('Best value');
    expect(r.body.data.ads).toMatchObject({ todayCount: 0, max: 20, rewardCredits: 250 });
    expect(r.body.data.spin.freeAvailable).toBe(true);
    expect(r.body.data.checkin).toEqual({ credits: 100, claimedToday: false });
  });

  test('check-in once per India day, returns the new balance', async () => {
    const { user, token } = await createUser();
    const first = await request(app).post('/wallet/checkin').set(auth(token));
    expect(first.body.data).toEqual({ credits: 100, balance: 100 });
    const again = await request(app).post('/wallet/checkin').set(auth(token));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_CLAIMED');
    expect(await credits(user.id)).toBe(100);
  });

  test('P15.T15 amounts sent by the app are ignored', async () => {
    const { user, token } = await createUser();
    const r = await request(app).post('/wallet/checkin').set(auth(token)).send({ credits: 1000000, amount: 999999 });
    expect(r.body.data.credits).toBe(100);
    expect(await credits(user.id)).toBe(100);
  });
});

describe('admin adjust (P15.T11)', () => {
  test('needs the admin key; idempotent on refId; negative beyond balance refused', async () => {
    const { user } = await createUser({ credits: 1000 });
    const body = { userId: user.id, amount: 5000, reason: 'ticket 1', refId: 'T-1', type: 'refund' };
    expect((await request(app).post('/admin/wallet/adjust').send(body)).status).toBe(401);
    const key = { 'X-Admin-Key': env.ADMIN_API_KEY };
    const r1 = await request(app).post('/admin/wallet/adjust').set(key).send(body);
    const r2 = await request(app).post('/admin/wallet/adjust').set(key).send(body);
    expect(r1.body.data).toEqual({ balance: 6000, duplicate: false });
    expect(r2.body.data).toEqual({ balance: 6000, duplicate: true });
    const neg = await request(app)
      .post('/admin/wallet/adjust')
      .set(key)
      .send({ ...body, amount: -99999, refId: 'T-2' });
    expect(neg.status).toBe(402);
    const huge = await request(app)
      .post('/admin/wallet/adjust')
      .set(key)
      .send({ ...body, amount: 1e12, refId: 'T-3' });
    expect(huge.status).toBe(400);
    const e = await queryOne("SELECT meta FROM ledger_entries WHERE ref_id = 'admin:T-1'");
    expect(e.meta.reason).toBe('ticket 1');
  });
});

describe('limits + package config', () => {
  test('BUG FIX: absurd amounts are refused before touching the DB', async () => {
    const { user } = await createUser();
    await expect(walletService.applyChange(user.id, 2 ** 60, 'admin_adjust', 'x')).rejects.toMatchObject({
      code: 'BAD_AMOUNT',
    });
  });

  test('BUG FIX: a broken PACKAGES_JSON falls back to safe defaults', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [
      '{not json',
      '[{"id":"a","priceInr":100}]', // no minutes -> credits would be NaN
      '[{"id":"a","priceInr":100,"minutes":80},{"id":"a","priceInr":200,"minutes":170}]', // duplicate id
      '[{"id":"a","priceInr":-5,"minutes":80}]',
      '[]',
    ];
    for (const json of cases) {
      process.env.PACKAGES_JSON = json;
      expect(economy.parsePackages().map(p => p.id)).toEqual(['minutes_80', 'minutes_170', 'minutes_270', 'minutes_475']);
    }
    process.env.PACKAGES_JSON = '[{"id":"mini_10","priceInr":15,"minutes":10}]';
    expect(economy.parsePackages()).toEqual([{ id: 'mini_10', priceInr: 15, minutes: 10 }]);
    delete process.env.PACKAGES_JSON;
    warn.mockRestore();
  });

  test('package credits = minutes x 1000 and price in paise', () => {
    for (const p of economy.packages) {
      expect(p.credits).toBe(p.minutes * 1000);
      expect(p.amountPaise).toBe(p.priceInr * 100);
    }
    // NOTE (owner decision, see docs/MEMORY.md ECON-01): after 18% GST + 15% Play fee these packages earn
    // Rs0.76-0.90/min, below the configured PROVIDER_COST_PAISE_PER_MIN. Prices are NOT changed by code.
  });
});
