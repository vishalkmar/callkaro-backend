// Spin -> rewarded ad -> credits. The prize is decided first and paid only after the ad: verified by Google's
// SSV callback once real ad units are configured, or reported by the app while test ads are used.
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const economy = require('../src/config/economy');
const { env } = require('../src/config/env');
const { setKeysForTest } = require('../src/services/ssv.service');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = '3335741209';
const signedQuery = params => {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto
    .sign('sha256', Buffer.from(qs), privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${qs}&signature=${sig}&key_id=${KEY_ID}`;
};
const ssv = (customData, transactionId) =>
  request(app).get(
    `/ads/ssv?${signedQuery({
      ad_network: '5450213213286189855',
      ad_unit: '1234567890',
      custom_data: customData,
      reward_amount: '999999',
      reward_item: 'credits',
      timestamp: String(Date.now()),
      transaction_id: transactionId,
      user_id: 'x',
    })}`,
  );

const auth = token => ({ Authorization: `Bearer ${token}` });
const play = token => request(app).post('/spin/play').set(auth(token)).send({});
const session = (token, body) => request(app).post('/ads/session').set(auth(token)).send(body);

let savedUnits;
beforeAll(async () => {
  await startDb();
  setKeysForTest(new Map([[KEY_ID, publicKey.export({ type: 'spki', format: 'pem' })]]));
  savedUnits = [...env.ADMOB_REWARDED_AD_UNITS];
});
beforeEach(() => {
  economy.SPIN_NEEDS_AD = true;
});
afterEach(async () => {
  economy.SPIN_NEEDS_AD = false;
  env.ADMOB_REWARDED_AD_UNITS.splice(0, env.ADMOB_REWARDED_AD_UNITS.length, ...savedUnits);
  await clearDb();
});
afterAll(stopDb);

const realAds = () => env.ADMOB_REWARDED_AD_UNITS.splice(0, env.ADMOB_REWARDED_AD_UNITS.length, '1234567890');

describe('spin: prize first, credits after the ad', () => {
  test('the spin decides the prize but adds no credits yet; status shows it waiting', async () => {
    const { user, token } = await createUser({ credits: 0 });
    const r = (await play(token)).body.data;
    expect(r).toMatchObject({ claimRequired: true, claimVia: 'app', balance: 0 });
    expect(r.credits).toBeGreaterThan(0);
    expect(await credits(user.id)).toBe(0);
    const st = (await request(app).get('/spin/status').set(auth(token))).body.data;
    expect(st.pendingClaim).toMatchObject({ spinId: r.spinId, credits: r.credits });
  });

  test('test-ad mode: the app reports the watched ad -> credits once', async () => {
    const { user, token } = await createUser({ credits: 0 });
    const r = (await play(token)).body.data;
    const c = await request(app).post('/spin/claim').set(auth(token)).send({ spinId: r.spinId });
    expect(c.status).toBe(200);
    expect(await credits(user.id)).toBe(r.credits);
    const again = await request(app).post('/spin/claim').set(auth(token)).send({ spinId: r.spinId });
    expect(again.body.code).toBe('SPIN_NOT_CLAIMABLE');
    expect(await credits(user.id)).toBe(r.credits);
    expect((await request(app).get('/spin/status').set(auth(token))).body.data.pendingClaim).toBeNull();
  });

  test('real ads: the app can NOT claim by itself - only the verified SSV callback pays', async () => {
    realAds();
    const { user, token } = await createUser({ credits: 0 });
    const r = (await play(token)).body.data;
    expect(r.claimVia).toBe('ssv');
    expect((await request(app).post('/spin/claim').set(auth(token)).send({ spinId: r.spinId })).body.code).toBe('AD_REQUIRED');

    const s = (await session(token, { purpose: 'spin_claim', refId: r.spinId })).body.data;
    expect((await ssv(s.customData, 'spin-txn-1')).status).toBe(200);
    expect(await credits(user.id)).toBe(r.credits); // the spin's prize, never reward_amount from the request
    await ssv(s.customData, 'spin-txn-1'); // Google retry
    expect(await credits(user.id)).toBe(r.credits);
    expect((await queryOne("SELECT credits FROM ad_rewards WHERE purpose = 'spin_claim'")).credits).toBe(r.credits);
  });

  test('a second ad cannot pay the same spin twice', async () => {
    realAds();
    const { user, token } = await createUser({ credits: 0 });
    const r = (await play(token)).body.data;
    const s1 = (await session(token, { purpose: 'spin_claim', refId: r.spinId })).body.data;
    const s2 = (await session(token, { purpose: 'spin_claim', refId: r.spinId })).body.data;
    await ssv(s1.customData, 'a');
    await ssv(s2.customData, 'b');
    expect(await credits(user.id)).toBe(r.credits);
  });

  test('cannot open an ad session for someone else\'s, collected or expired spin', async () => {
    const a = await createUser({ credits: 0 });
    const b = await createUser({ credits: 0 });
    const r = (await play(a.token)).body.data;
    expect((await session(b.token, { purpose: 'spin_claim', refId: r.spinId })).body.code).toBe('SPIN_NOT_CLAIMABLE');
    await query("UPDATE spins SET created_at = now() - interval '25 hours' WHERE id = $1", [r.spinId]);
    expect((await session(a.token, { purpose: 'spin_claim', refId: r.spinId })).body.code).toBe('SPIN_NOT_CLAIMABLE');
    expect((await session(a.token, { purpose: 'spin_claim' })).status).toBe(400); // refId required
  });

  test('a spin ad is not blocked by the rewarded-video gap (it pays a prize already won)', async () => {
    realAds();
    const { user, token } = await createUser({ credits: 0 });
    const v = (await session(token, { purpose: 'credits' })).body.data;
    await ssv(v.customData, 'video-1'); // +250 just now -> the video gap starts
    const r = (await play(token)).body.data;
    const s = (await session(token, { purpose: 'spin_claim', refId: r.spinId })).body.data;
    await ssv(s.customData, 'spin-2');
    expect(await credits(user.id)).toBe(250 + r.credits);
  });

  test('SPIN_NEEDS_AD=false keeps the old instant credit', async () => {
    economy.SPIN_NEEDS_AD = false;
    const { user, token } = await createUser({ credits: 0 });
    const r = (await play(token)).body.data;
    expect(r.claimRequired).toBeUndefined();
    expect(await credits(user.id)).toBe(r.credits);
  });
});

describe('unlimited ads and spins (0 = no limit)', () => {
  const saved = {};
  beforeEach(() => {
    saved.max = economy.MAX_AD_REWARDS_PER_DAY;
    saved.interval = economy.FREE_SPIN_INTERVAL_HOURS;
  });
  afterEach(() => {
    economy.MAX_AD_REWARDS_PER_DAY = saved.max;
    economy.FREE_SPIN_INTERVAL_HOURS = saved.interval;
  });

  test('MAX_AD_REWARDS_PER_DAY=0: no daily cap - the 21st video still pays', async () => {
    economy.MAX_AD_REWARDS_PER_DAY = 0;
    realAds();
    const { user, token } = await createUser({ credits: 0 });
    for (let i = 0; i < 20; i++) {
      await query(
        "INSERT INTO ad_rewards (user_id, transaction_id, purpose, credits, created_at) VALUES ($1, $2, 'credits', 250, now() - interval '5 minutes')",
        [user.id, `old-${i}`],
      );
    }
    const st = (await request(app).get('/ads/status').set(auth(token))).body.data;
    expect(st).toMatchObject({ unlimited: true, remaining: null, todayCount: 20 });
    const s = (await session(token, { purpose: 'credits' })).body.data;
    await ssv(s.customData, 'video-21');
    expect(await credits(user.id)).toBe(250);
  });

  test('FREE_SPIN_INTERVAL_HOURS=0 with the ad step: spin again right away, every prize waits for its ad', async () => {
    economy.FREE_SPIN_INTERVAL_HOURS = 0;
    const { user, token } = await createUser({ credits: 0 });
    const a = await play(token);
    const b = await play(token);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await credits(user.id)).toBe(0); // nothing without the ads
    const st = (await request(app).get('/spin/status').set(auth(token))).body.data;
    expect(st).toMatchObject({ freeAvailable: true, freeIntervalHours: 0 });
  });

  test('safety: interval 0 but the ad step switched off -> back to one spin per 24 h', async () => {
    economy.FREE_SPIN_INTERVAL_HOURS = 0;
    economy.SPIN_NEEDS_AD = false;
    const { token } = await createUser({ credits: 0 });
    expect((await play(token)).status).toBe(200);
    expect((await play(token)).body.code).toBe('NO_SPINS');
  });

  test('a video right after collecting a spin is not refused by the video gap', async () => {
    realAds();
    const { user, token } = await createUser({ credits: 0 });
    const r = (await play(token)).body.data;
    const s = (await session(token, { purpose: 'spin_claim', refId: r.spinId })).body.data;
    await ssv(s.customData, 'spin-x');
    const v = (await session(token, { purpose: 'credits' })).body.data;
    await ssv(v.customData, 'video-x');
    expect(await credits(user.id)).toBe(r.credits + 250);
  });
});

describe('rewarded video pays a random 10-50, mostly low', () => {
  test('always within the range, skewed to the low end', () => {
    const counts = { low: 0, high: 0 };
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = economy.pickAdReward(10, 50);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(50);
      sum += v;
      if (v <= 20) counts.low += 1;
      if (v > 40) counts.high += 1;
    }
    expect(counts.low / 20000).toBeGreaterThan(0.45); // about half pay 10-20
    expect(counts.high / 20000).toBeLessThan(0.18); // big ones are rare
    expect(sum / 20000).toBeLessThan(27);
  });

  test('edges: smallest and largest random numbers map to min and max; a fixed range pays that amount', () => {
    expect(economy.pickAdReward(10, 50, () => 0)).toBe(10);
    expect(economy.pickAdReward(10, 50, () => 999999)).toBe(50);
    expect(economy.pickAdReward(250, 250)).toBe(250);
  });

  test('the SSV callback credits a random amount in the range (reward_amount from Google is ignored)', async () => {
    const saved = [economy.AD_REWARD_MIN, economy.AD_REWARD_MAX];
    economy.AD_REWARD_MIN = 10;
    economy.AD_REWARD_MAX = 50;
    try {
      realAds();
      const { user, token } = await createUser({ credits: 0 });
      const st = (await request(app).get('/ads/status').set(auth(token))).body.data;
      expect(st).toMatchObject({ rewardMin: 10, rewardMax: 50 });
      const s = (await session(token, { purpose: 'credits' })).body.data;
      await ssv(s.customData, 'video-random');
      const got = await credits(user.id);
      expect(got).toBeGreaterThanOrEqual(10);
      expect(got).toBeLessThanOrEqual(50);
    } finally {
      [economy.AD_REWARD_MIN, economy.AD_REWARD_MAX] = saved;
    }
  });
});

describe('switched off: auto-block after reports, accounts-per-phone limit', () => {
  const { env: envCfg } = require('../src/config/env');
  test('REPORTS_TO_AUTOBLOCK=0: many reports block nobody, but a "do not call me" opt-out still does', async () => {
    const saved = economy.REPORTS_TO_AUTOBLOCK;
    economy.REPORTS_TO_AUTOBLOCK = 0;
    try {
      const abuse = require('../src/services/abuse.service');
      const target = await createUser();
      for (let i = 0; i < 5; i++) {
        const r = await queryOne(
          "INSERT INTO reports (target_user_id, target_number, reason, details) VALUES ($1, '+919800000001', 'harassment', 'x') RETURNING *",
          [target.user.id],
        );
        await abuse.evaluateReports(r);
      }
      expect((await queryOne('SELECT status FROM users WHERE id = $1', [target.user.id])).status).toBe('active');
      const opt = await queryOne(
        "INSERT INTO reports (target_number, reporter_contact, reason, details) VALUES ('+919800000002', '+919800000002', 'opt_out', 'IVR') RETURNING *",
      );
      expect(await abuse.evaluateReports(opt)).toMatchObject({ optedOut: true });
      expect(await queryOne("SELECT 1 FROM blocked_numbers WHERE e164 = '+919800000002'")).toBeTruthy();
    } finally {
      economy.REPORTS_TO_AUTOBLOCK = saved;
    }
  });

  test('ACCOUNTS_PER_DEVICE=0: any number of accounts on one phone, welcome bonus still only once', async () => {
    const saved = envCfg.ACCOUNTS_PER_DEVICE;
    envCfg.ACCOUNTS_PER_DEVICE = 0;
    try {
      const auth = require('../src/services/auth.service');
      const bcrypt = require('bcryptjs');
      const bonuses = [];
      for (let i = 0; i < 4; i++) {
        const email = `phone${i}@example.com`;
        await query(
          "INSERT INTO otps (email, otp_hash, expires_at, attempts, send_times, purge_at) VALUES ($1, $2, now() + interval '5 minutes', 0, '{}', now() + interval '1 hour')",
          [email, await bcrypt.hash('123456', 4)],
        );
        const r = await auth.verifyOtp({ email, otp: '123456', deviceId: 'same-phone' });
        bonuses.push(Number(r.wallet.credits));
      }
      expect(bonuses.filter(c => c > 0)).toHaveLength(1); // 4 accounts, one welcome bonus
    } finally {
      envCfg.ACCOUNTS_PER_DEVICE = saved;
    }
  });
});
