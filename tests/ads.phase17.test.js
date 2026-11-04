// Phase 17 server extras: key refetch throttling, foreign ad units, nonce rules, extra spins.
const crypto = require('crypto');
const axios = require('axios');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const { setKeysForTest, verifySsv } = require('../src/services/ssv.service');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = '3335741209';
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const sign = (params, keyId = KEY_ID) => {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.sign('sha256', Buffer.from(qs), privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${qs}&signature=${sig}&key_id=${keyId}`;
};
const params = (customData, tx, adUnit = '1234567890') => ({
  ad_network: '5450213213286189855',
  ad_unit: adUnit,
  custom_data: customData,
  reward_amount: '999999',
  reward_item: 'credits',
  timestamp: String(Date.now()),
  transaction_id: tx,
  user_id: 'x',
});
const session = async (token, purpose = 'credits') =>
  (await request(app).post('/ads/session').set('Authorization', `Bearer ${token}`).send({ purpose })).body.data;
const ssv = q => request(app).get(`/ads/ssv?${q}`);

beforeAll(startDb);
afterAll(stopDb);
beforeEach(() => setKeysForTest(new Map([[KEY_ID, PEM]])));
afterEach(async () => {
  await clearDb();
  jest.restoreAllMocks();
  env.ADMOB_REWARDED_AD_UNITS.length = 0;
});

describe('SSV key handling', () => {
  test('BUG FIX: unknown key ids refetch Google keys at most once a minute', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { keys: [{ keyId: Number(KEY_ID), pem: PEM }] } });
    for (let i = 0; i < 20; i++) {
      const r = await verifySsv(sign(params('a:b', `t${i}`), `999${i}`));
      expect(r.valid).toBe(false);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('a rotated key is picked up (refetch finds the new key)', async () => {
    setKeysForTest(new Map([['111', 'old']]));
    jest.spyOn(axios, 'get').mockResolvedValue({ data: { keys: [{ keyId: Number(KEY_ID), pem: PEM }] } });
    expect((await verifySsv(sign(params('a:b', 't1')))).valid).toBe(true);
  });

  test('cache older than 24h is refreshed', async () => {
    setKeysForTest(new Map([[KEY_ID, PEM]]), Date.now() - 25 * 3600e3);
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: { keys: [{ keyId: Number(KEY_ID), pem: PEM }] } });
    await verifySsv(sign(params('a:b', 't1')));
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('tampered query (amount added after signing) is refused', async () => {
    const q = sign(params('a:b', 't1')).replace('reward_amount=999999', 'reward_amount=1');
    expect((await ssv(q)).status).toBe(403);
  });
});

describe('reward rules', () => {
  test('P17.T11 amount always from config (250), never from reward_amount', async () => {
    const { user, token } = await createUser();
    const s = await session(token);
    await ssv(sign(params(s.customData, 'tx1')));
    expect(await credits(user.id)).toBe(250);
  });

  test('BUG FIX: ads from a foreign ad unit pay nothing when our units are configured', async () => {
    env.ADMOB_REWARDED_AD_UNITS.push('1234567890');
    const { user, token } = await createUser();
    const s1 = await session(token);
    expect((await ssv(sign(params(s1.customData, 'f1', '5555555555')))).status).toBe(200);
    expect(await credits(user.id)).toBe(0);
    const s2 = await session(token);
    await ssv(sign(params(s2.customData, 'f2', '1234567890')));
    expect(await credits(user.id)).toBe(250);
  });

  test("a nonce cannot be reused, expire, or be spent by another user", async () => {
    const a = await createUser();
    const b = await createUser();
    const s = await session(a.token);
    await ssv(sign(params(`${b.user.id}:${s.nonce}`, 'x1'))); // b tries a's nonce
    expect(await credits(b.user.id)).toBe(0);
    await query("UPDATE ad_sessions SET expires_at = now() - interval '1 second'");
    await ssv(sign(params(s.customData, 'x2')));
    expect(await credits(a.user.id)).toBe(0);
  });

  test('blocked / rewards-disabled users get nothing', async () => {
    const { user, token } = await createUser();
    const s = await session(token);
    await query('UPDATE users SET rewards_disabled = TRUE WHERE id = $1', [user.id]);
    await ssv(sign(params(s.customData, 'b1')));
    expect(await credits(user.id)).toBe(0);
  });

  test('emulator header blocks new ad sessions', async () => {
    const { token } = await createUser();
    const r = await request(app)
      .post('/ads/session')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Device-Integrity', 'emulator=1;rooted=0')
      .send({});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('REWARDS_DISABLED');
  });

  test('extra_spin ad unlocks one spin (no credits), max 5 a day', async () => {
    const { user, token } = await createUser();
    const s = await session(token, 'extra_spin');
    await ssv(sign(params(s.customData, 's1')));
    expect(await credits(user.id)).toBe(0);
    const st = await request(app).get('/spin/status').set('Authorization', `Bearer ${token}`);
    expect(st.body.data.extraSpinsAvailable).toBe(1);
    for (let i = 0; i < 4; i++) {
      await query(
        "INSERT INTO ad_rewards (user_id, transaction_id, purpose, created_at) VALUES ($1, $2, 'extra_spin', now())",
        [user.id, `more${i}`],
      );
    }
    const r = await request(app).post('/ads/session').set('Authorization', `Bearer ${token}`).send({ purpose: 'extra_spin' });
    expect(r.body.code).toBe('SPIN_DAILY_CAP');
  });

  test('GET /ads/status shows x/20 and the next allowed time after a reward', async () => {
    const { token } = await createUser();
    const s = await session(token);
    await ssv(sign(params(s.customData, 'st1')));
    const r = await request(app).get('/ads/status').set('Authorization', `Bearer ${token}`);
    expect(r.body.data).toMatchObject({ todayCount: 1, max: 20, remaining: 19 });
    expect(new Date(r.body.data.nextAvailableAt).getTime()).toBeGreaterThan(Date.now());
    expect(await queryOne('SELECT used_at FROM ad_sessions WHERE nonce = $1', [s.nonce])).toMatchObject({ used_at: expect.any(Date) });
  });
});
