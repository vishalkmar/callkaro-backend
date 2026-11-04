const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { setKeysForTest } = require('../src/services/ssv.service');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

// Our own EC key pair stands in for Google's published verifier key.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = '3335741209';

const signedQuery = params => {
  const qs = new URLSearchParams(params).toString();
  const sig = crypto.sign('sha256', Buffer.from(qs), privateKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${qs}&signature=${sig}&key_id=${KEY_ID}`;
};

const ssvParams = (customData, transactionId) => ({
  ad_network: '5450213213286189855',
  ad_unit: '1234567890',
  custom_data: customData,
  reward_amount: '999999', // must be ignored: the server decides the amount
  reward_item: 'credits',
  timestamp: String(Date.now()),
  transaction_id: transactionId,
  user_id: 'x',
});

beforeAll(async () => {
  await startDb();
  setKeysForTest(new Map([[KEY_ID, publicKey.export({ type: 'spki', format: 'pem' })]]));
});
afterAll(stopDb);
afterEach(clearDb);

const newSession = async token => (await request(app).post('/ads/session').set('Authorization', `Bearer ${token}`).send({ purpose: 'credits' })).body.data;

describe('rewarded ads SSV', () => {
  test('valid signature credits the configured amount once', async () => {
    const { user, token } = await createUser();
    const s = await newSession(token);
    expect(s.customData).toBe(`${user.id}:${s.nonce}`);

    const q = signedQuery(ssvParams(s.customData, 'txn-1'));
    expect((await request(app).get(`/ads/ssv?${q}`)).status).toBe(200);
    expect(await credits(user.id)).toBe(250);

    // replay of the same transaction -> no double credit
    expect((await request(app).get(`/ads/ssv?${q}`)).status).toBe(200);
    expect(await credits(user.id)).toBe(250);
    expect((await queryOne('SELECT COUNT(*)::int AS n FROM ad_rewards')).n).toBe(1);
  });

  test('invalid signature is rejected and nothing is credited', async () => {
    const { user, token } = await createUser();
    const s = await newSession(token);
    const q = signedQuery(ssvParams(s.customData, 'txn-2')).replace('transaction_id=txn-2', 'transaction_id=txn-forged');
    const r = await request(app).get(`/ads/ssv?${q}`);
    expect(r.status).toBe(403);
    expect(await credits(user.id)).toBe(0);
  });

  test('daily cap (20) is enforced', async () => {
    const { user, token } = await createUser();
    for (let i = 0; i < 20; i++) {
      await query(
        "INSERT INTO ad_rewards (user_id, transaction_id, purpose, credits, created_at) VALUES ($1, $2, 'credits', 250, now())", // 'today' even just after IST midnight
        [user.id, `old-${i}`],
      );
    }
    const r = await request(app).post('/ads/session').set('Authorization', `Bearer ${token}`).send({ purpose: 'credits' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('AD_DAILY_CAP');
  });

  test('minimum 30s gap between rewards', async () => {
    const { user, token } = await createUser();
    const s1 = await newSession(token);
    await request(app).get(`/ads/ssv?${signedQuery(ssvParams(s1.customData, 'a1'))}`);
    const s2 = await newSession(token);
    await request(app).get(`/ads/ssv?${signedQuery(ssvParams(s2.customData, 'a2'))}`);
    expect(await credits(user.id)).toBe(250);
  });

  test('console verification ping without custom data returns 200', async () => {
    expect((await request(app).get('/ads/ssv')).status).toBe(200);
  });
});
