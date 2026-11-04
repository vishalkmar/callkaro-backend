const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const payments = require('../src/services/payment.service');
const { startDb, stopDb, clearDb, createUser, credits, queryOne } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

const rzSig = (orderId, paymentId) => crypto.createHmac('sha256', 'rzp_secret').update(`${orderId}|${paymentId}`).digest('hex');

const seedRazorpayOrder = async userId =>
  queryOne(
    `INSERT INTO orders (user_id, package_id, amount_paise, credits, minutes, provider, provider_order_id)
     VALUES ($1, 'minutes_80', 10000, 80000, 80, 'razorpay', $2) RETURNING *`,
    [userId, `order_${Date.now()}${Math.random()}`],
  );

describe('orders - Razorpay', () => {
  test('verify success credits package credits (decided by server)', async () => {
    const { user, token } = await createUser();
    const order = await seedRazorpayOrder(user.id);
    const body = { razorpay_order_id: order.provider_order_id, razorpay_payment_id: 'pay_1', razorpay_signature: rzSig(order.provider_order_id, 'pay_1') };
    const r = await request(app).post('/orders/verify-razorpay').set('Authorization', `Bearer ${token}`).send(body);
    expect(r.status).toBe(200);
    expect(r.body.data.balance).toBe(80000);
    expect(r.body.data.order.status).toBe('paid');
  });

  test('bad signature fails and credits nothing', async () => {
    const { user, token } = await createUser();
    const order = await seedRazorpayOrder(user.id);
    const r = await request(app)
      .post('/orders/verify-razorpay')
      .set('Authorization', `Bearer ${token}`)
      .send({ razorpay_order_id: order.provider_order_id, razorpay_payment_id: 'pay_1', razorpay_signature: 'deadbeef' });
    expect(r.body.code).toBe('PAYMENT_VERIFICATION_FAILED');
    expect(await credits(user.id)).toBe(0);
  });

  test('duplicate verification + webhook never double credit', async () => {
    const { user, token } = await createUser();
    const order = await seedRazorpayOrder(user.id);
    const body = { razorpay_order_id: order.provider_order_id, razorpay_payment_id: 'pay_2', razorpay_signature: rzSig(order.provider_order_id, 'pay_2') };
    await request(app).post('/orders/verify-razorpay').set('Authorization', `Bearer ${token}`).send(body);
    await request(app).post('/orders/verify-razorpay').set('Authorization', `Bearer ${token}`).send(body);

    const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_2', order_id: order.provider_order_id } } } };
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha256', 'rzp_webhook_secret').update(raw).digest('hex');
    const wh = await request(app).post('/webhooks/payments/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).send(raw);
    expect(wh.status).toBe(200);
    expect(await credits(user.id)).toBe(80000);
  });

  test('webhook with bad signature is refused', async () => {
    const r = await request(app).post('/webhooks/payments/razorpay').set('X-Razorpay-Signature', 'x').send({ event: 'payment.captured' });
    expect(r.status).toBe(400);
  });

  test('refund webhook reverses credits down to 0 and flags the user', async () => {
    const { user, token } = await createUser();
    const order = await seedRazorpayOrder(user.id);
    await request(app)
      .post('/orders/verify-razorpay')
      .set('Authorization', `Bearer ${token}`)
      .send({ razorpay_order_id: order.provider_order_id, razorpay_payment_id: 'pay_3', razorpay_signature: rzSig(order.provider_order_id, 'pay_3') });
    // user spends most credits
    await require('../src/services/wallet.service').applyChange(user.id, -70000, 'call_charge', 'CAspent');
    await payments.handleRazorpayEvent({
      event: 'refund.processed',
      payload: { payment: { entity: { id: 'pay_3', order_id: order.provider_order_id } }, refund: { entity: { id: 'rfnd_1' } } },
    });
    expect(await credits(user.id)).toBe(0);
    expect((await queryOne('SELECT negative_usage FROM users WHERE id = $1', [user.id])).negative_usage).toBe(true);
    expect((await queryOne('SELECT status FROM orders WHERE id = $1', [order.id])).status).toBe('refunded');
  });
});

describe('orders - Google Play', () => {
  const fakeClient = state => ({
    request: jest.fn(async ({ url }) => {
      if (url.endsWith(':consume')) {
        return { data: {} };
      }
      return { data: { purchaseState: state, consumptionState: 0, orderId: 'GPA.1234' } };
    }),
  });

  test('purchased token is verified with Google, credited once, consumed', async () => {
    const client = fakeClient(0);
    payments.setPlayClientForTest(client);
    const { user, token } = await createUser();
    const body = { productId: 'minutes_170', purchaseToken: 'tok-abc' };
    const r1 = await request(app).post('/orders/verify-play').set('Authorization', `Bearer ${token}`).send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.data.balance).toBe(170000);
    expect(client.request.mock.calls.some(([o]) => o.url.endsWith(':consume'))).toBe(true);
    const r2 = await request(app).post('/orders/verify-play').set('Authorization', `Bearer ${token}`).send(body);
    expect(r2.body.data.alreadyCredited).toBe(true);
    expect(await credits(user.id)).toBe(170000);
  });

  test('pending / cancelled purchases are not credited', async () => {
    payments.setPlayClientForTest(fakeClient(2));
    const { token } = await createUser();
    const r = await request(app).post('/orders/verify-play').set('Authorization', `Bearer ${token}`).send({ productId: 'minutes_80', purchaseToken: 'tok-p' });
    expect(r.body.code).toBe('PAYMENT_PENDING');
    payments.setPlayClientForTest(fakeClient(1));
    const r2 = await request(app).post('/orders/verify-play').set('Authorization', `Bearer ${token}`).send({ productId: 'minutes_80', purchaseToken: 'tok-c' });
    expect(r2.body.code).toBe('PAYMENT_VERIFICATION_FAILED');
  });

  test('unknown product is refused', async () => {
    const { token } = await createUser();
    const r = await request(app).post('/orders/verify-play').set('Authorization', `Bearer ${token}`).send({ productId: 'free_money', purchaseToken: 't' });
    expect(r.body.code).toBe('BAD_PACKAGE');
  });
});
