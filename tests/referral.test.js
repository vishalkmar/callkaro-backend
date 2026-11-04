// P25.T17 referral: both users get the bonus only after the referee's FIRST verified paid purchase.
jest.mock('../src/services/brevo.service', () => ({ sendOtpEmail: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const app = require('../src/app');
const economy = require('../src/config/economy');
const payments = require('../src/services/payment.service');
const brevo = require('../src/services/brevo.service');
const { startDb, stopDb, clearDb, createUser, credits, queryOne } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(async () => {
  await clearDb();
  brevo.sendOtpEmail.mockClear();
});

const google = () => ({
  request: jest.fn(async ({ url }) =>
    url.endsWith(':consume') ? { data: {} } : { data: { purchaseState: 0, consumptionState: 0, orderId: `GPA.${Math.random()}` } },
  ),
});

const signUp = async (email, deviceId, referralCode) => {
  await request(app).post('/auth/send-otp').send({ email });
  const code = brevo.sendOtpEmail.mock.calls.at(-1)[0].code;
  const r = await request(app).post('/auth/verify-otp').send({ email, otp: code, deviceId, referralCode });
  return r.body.data;
};

test('referral bonus for both only after the first paid purchase, once', async () => {
  const inviter = await createUser();
  const code = (await queryOne('SELECT referral_code FROM users WHERE id = $1', [inviter.user.id])).referral_code;
  expect(code).toBeNull(); // test helper users have no code; give one
  await queryOne("UPDATE users SET referral_code = 'ABCD1234' WHERE id = $1 RETURNING id", [inviter.user.id]);

  const friend = await signUp('friend@example.com', 'friend-device-1', 'abcd1234'); // case-insensitive
  const before = await credits(friend.user.id);
  expect(await credits(inviter.user.id)).toBe(0); // nothing just for signing up

  payments.setPlayClientForTest(google());
  const auth = { Authorization: `Bearer ${friend.tokens.accessToken}` };
  await request(app).post('/orders/verify-play').set(auth).send({ productId: 'minutes_80', purchaseToken: 'p1' });
  expect(await credits(friend.user.id)).toBe(before + 80000 + economy.REFERRAL_BONUS_CREDITS);
  expect(await credits(inviter.user.id)).toBe(economy.REFERRAL_BONUS_CREDITS);

  await request(app).post('/orders/verify-play').set(auth).send({ productId: 'minutes_80', purchaseToken: 'p2' });
  expect(await credits(inviter.user.id)).toBe(economy.REFERRAL_BONUS_CREDITS); // second purchase: no new bonus
});

test('unknown referral code is ignored, signup still works', async () => {
  const u = await signUp('solo@example.com', 'solo-device-1', 'NOPE0000');
  expect(u.user.email).toBe('solo@example.com');
  expect((await queryOne('SELECT referred_by FROM users WHERE id = $1', [u.user.id])).referred_by).toBeNull();
});

test('new users get their own referral code', async () => {
  const u = await signUp('me@example.com', 'me-device-1');
  expect(u.user.referralCode).toMatch(/^[0-9A-F]{8}$/);
});
