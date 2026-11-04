// Phase 19 server: Play verification hardening, refunds via RTDN, receipts, order lookup.
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const payments = require('../src/services/payment.service');
const { startDb, stopDb, clearDb, createUser, credits, queryOne } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

const auth = t => ({ Authorization: `Bearer ${t}` });
const google = (over = {}, fail = null) => ({
  request: jest.fn(async ({ url }) => {
    if (fail) {
      throw Object.assign(new Error('google'), { response: { status: fail } });
    }
    if (url.endsWith(':consume')) {
      return { data: {} };
    }
    return { data: { purchaseState: 0, consumptionState: 0, orderId: `GPA.${Math.random()}`, ...over } };
  }),
});
const verify = (token, body) => request(app).post('/orders/verify-play').set(auth(token)).send(body);

describe('Play verification', () => {
  test('BUG FIX: an expensive order cannot be paid with a cheap purchase', async () => {
    payments.setPlayClientForTest(google());
    const { user, token } = await createUser();
    const big = (await request(app).post('/orders/create').set(auth(token)).send({ packageId: 'minutes_475', provider: 'play' })).body.data;
    const r = await verify(token, { orderId: big.order.id, productId: 'minutes_80', purchaseToken: 'cheap-1' });
    expect(r.status).toBe(200);
    expect(await credits(user.id)).toBe(80000); // what Google says was bought, not 475000
    expect((await queryOne('SELECT status FROM orders WHERE id = $1', [big.order.id])).status).toBe('created');
  });

  test('the matching order is used and gets a receipt number', async () => {
    payments.setPlayClientForTest(google());
    const { user, token } = await createUser();
    const o = (await request(app).post('/orders/create').set(auth(token)).send({ packageId: 'minutes_80', provider: 'play' })).body.data;
    expect(o.accountTag).toMatch(/^[0-9a-f]{40}$/);
    const r = await verify(token, { orderId: o.order.id, productId: 'minutes_80', purchaseToken: 'tok-1' });
    expect(r.body.data.order).toMatchObject({ id: o.order.id, status: 'paid', receiptNo: expect.stringMatching(/^CK-\d{8}-[0-9A-F]{6}$/) });
    const entry = await queryOne("SELECT meta FROM ledger_entries WHERE type = 'purchase' AND user_id = $1", [user.id]);
    expect(entry.meta).toMatchObject({ minutes: 80, receiptNo: r.body.data.order.receiptNo });
    const look = await request(app).get(`/orders/${o.order.id}`).set(auth(token));
    expect(look.body.data.status).toBe('paid');
  });

  test('a paid order cannot be reused for a second purchase', async () => {
    payments.setPlayClientForTest(google());
    const { user, token } = await createUser();
    const o = (await request(app).post('/orders/create').set(auth(token)).send({ packageId: 'minutes_80', provider: 'play' })).body.data;
    await verify(token, { orderId: o.order.id, productId: 'minutes_80', purchaseToken: 'a' });
    await verify(token, { orderId: o.order.id, productId: 'minutes_80', purchaseToken: 'b' });
    expect(await credits(user.id)).toBe(160000); // two real purchases -> two orders, both credited once
    expect((await queryOne('SELECT COUNT(*)::int AS n FROM orders WHERE user_id = $1', [user.id])).n).toBe(2);
  });

  test.each([400, 404, 410])('BUG FIX: Google says %s -> 400 "not valid", not a 500', async status => {
    payments.setPlayClientForTest(google({}, status));
    const { token } = await createUser();
    const r = await verify(token, { productId: 'minutes_80', purchaseToken: 'fake' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PAYMENT_VERIFICATION_FAILED');
  });

  test('Google down -> 503 "we will retry", nothing credited', async () => {
    payments.setPlayClientForTest(google({}, 503));
    const { user, token } = await createUser();
    const r = await verify(token, { productId: 'minutes_80', purchaseToken: 't' });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('PAYMENT_CHECK_UNAVAILABLE');
    expect(await credits(user.id)).toBe(0);
  });

  test("BUG FIX: another account's purchase (accountTag mismatch) is refused", async () => {
    const a = await createUser();
    const b = await createUser();
    payments.setPlayClientForTest(google({ obfuscatedExternalAccountId: payments.accountTag(a.user.id) }));
    const r = await verify(b.token, { productId: 'minutes_80', purchaseToken: 'stolen' });
    expect(r.body.code).toBe('TOKEN_USED');
    expect(await credits(b.user.id)).toBe(0);
    const ok = await verify(a.token, { productId: 'minutes_80', purchaseToken: 'stolen' });
    expect(ok.status).toBe(200);
  });

  test('BUG FIX: the same token sent twice in parallel credits once and both answer cleanly', async () => {
    payments.setPlayClientForTest(google());
    const { user, token } = await createUser();
    const body = { productId: 'minutes_170', purchaseToken: 'race-1' };
    const [r1, r2] = await Promise.all([verify(token, body), verify(token, body)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await credits(user.id)).toBe(170000);
  });
});

describe('Play refunds (RTDN)', () => {
  const push = (token, purchaseToken) =>
    request(app)
      .post(`/webhooks/payments/play?token=${token}`)
      .send({ message: { data: Buffer.from(JSON.stringify({ voidedPurchaseNotification: { purchaseToken } })).toString('base64') } });

  test('voided purchase removes the credits once; wrong token refused', async () => {
    env.PLAY_RTDN_TOKEN = 'rtdn-secret';
    payments.setPlayClientForTest(google());
    const { user, token } = await createUser();
    await verify(token, { productId: 'minutes_80', purchaseToken: 'v1' });
    expect((await push('nope', 'v1')).status).toBe(403);
    await push('rtdn-secret', 'v1');
    await push('rtdn-secret', 'v1');
    expect(await credits(user.id)).toBe(0);
    expect((await queryOne("SELECT status FROM orders WHERE purchase_token = 'v1'")).status).toBe('refunded');
  });
});
