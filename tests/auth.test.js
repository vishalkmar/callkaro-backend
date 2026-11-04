jest.mock('../src/services/brevo.service', () => ({ sendOtpEmail: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const { startDb, stopDb, clearDb, query, queryOne } = require('./helpers');
const brevo = require('../src/services/brevo.service');

beforeAll(startDb);
afterAll(stopDb);
afterEach(async () => {
  await clearDb();
  brevo.sendOtpEmail.mockClear();
});

const EMAIL = 'ravi@example.com';

// Captures the plain code the server generated (from the mocked email call).
const sendAndGetCode = async (email = EMAIL) => {
  const res = await request(app).post('/auth/send-otp').send({ email });
  expect(res.status).toBe(200);
  return brevo.sendOtpEmail.mock.calls.at(-1)[0].code;
};

describe('auth: email OTP', () => {
  test('send-otp validates email', async () => {
    const res = await request(app).post('/auth/send-otp').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  test('send-otp stores only a hash and responds the same for new/existing emails', async () => {
    const code = await sendAndGetCode();
    const doc = await queryOne('SELECT * FROM otps WHERE email = $1', [EMAIL]);
    expect(doc.otp_hash).not.toBe(code);
    expect(await bcrypt.compare(code, doc.otp_hash)).toBe(true);
  });

  test('resend cooldown is enforced', async () => {
    await sendAndGetCode();
    const res = await request(app).post('/auth/send-otp').send({ email: EMAIL });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('OTP_COOLDOWN');
  });

  test('disposable domains are blocked', async () => {
    const res = await request(app).post('/auth/send-otp').send({ email: 'x@mailinator.com' });
    expect(res.body.code).toBe('DISPOSABLE_EMAIL');
  });

  test('wrong OTP -> attempts left, 5 wrong -> locked', async () => {
    const code = await sendAndGetCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: wrong, deviceId: 'dev-123' });
      expect(r.body.code).toBe('OTP_INVALID');
      expect(r.body.data.attemptsLeft).toBe(5 - i);
    }
    const locked = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: wrong, deviceId: 'dev-123' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('OTP_LOCKED');
    const evenCorrect = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: code, deviceId: 'dev-123' });
    expect(evenCorrect.body.code).toBe('OTP_LOCKED');
  });

  test('expired OTP is rejected', async () => {
    const code = await sendAndGetCode();
    await query("UPDATE otps SET expires_at = now() - interval '1 second' WHERE email = $1", [EMAIL]);
    const r = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: code, deviceId: 'dev-123' });
    expect(r.body.code).toBe('OTP_EXPIRED');
  });

  test('correct OTP -> tokens, user, welcome bonus once per device', async () => {
    const code = await sendAndGetCode();
    const r = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: code, deviceId: 'dev-123', termsVersion: 'v1' });
    expect(r.status).toBe(200);
    expect(r.body.data.tokens.accessToken).toBeTruthy();
    expect(r.body.data.isNew).toBe(true);
    expect(r.body.data.wallet.credits).toBe(2000);
    expect(await queryOne('SELECT 1 FROM otps WHERE email = $1', [EMAIL])).toBeNull();

    // second account on the same device: allowed (limit 2) but NO welcome bonus
    const code2 = await sendAndGetCode('second@example.com');
    const r2 = await request(app).post('/auth/verify-otp').send({ email: 'second@example.com', otp: code2, deviceId: 'dev-123' });
    expect(r2.body.data.wallet.credits).toBe(0);

    // third account on the same device: blocked
    const code3 = await sendAndGetCode('third@example.com');
    const r3 = await request(app).post('/auth/verify-otp').send({ email: 'third@example.com', otp: code3, deviceId: 'dev-123' });
    expect(r3.body.code).toBe('DEVICE_LIMIT');
    expect((await queryOne('SELECT COUNT(*)::int AS n FROM wallets')).n).toBe(2);
  });

  test('refresh rotates tokens, reuse of old refresh token revokes the session, logout works', async () => {
    const code = await sendAndGetCode();
    const login = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: code, deviceId: 'dev-9' });
    const { accessToken, refreshToken } = login.body.data.tokens;

    const me = await request(app).get('/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(EMAIL);

    const r1 = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(r1.status).toBe(200);
    const next = r1.body.data.refreshToken;
    expect(next).not.toBe(refreshToken);

    const reuse = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    const afterReuse = await request(app).post('/auth/refresh').send({ refreshToken: next });
    expect(afterReuse.body.code).toBe('SESSION_REVOKED');
  });

  test('logout revokes the session', async () => {
    const code = await sendAndGetCode();
    const login = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: code, deviceId: 'dev-7' });
    const { refreshToken } = login.body.data.tokens;
    const out = await request(app).post('/auth/logout').send({ refreshToken });
    expect(out.body.data.loggedOut).toBe(true);
    const r = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(r.status).toBe(401);
  });

  test('protected routes need a valid token; blocked users are rejected', async () => {
    expect((await request(app).get('/wallet')).status).toBe(401);
    const code = await sendAndGetCode();
    const login = await request(app).post('/auth/verify-otp').send({ email: EMAIL, otp: code, deviceId: 'dev-5' });
    await query("UPDATE users SET status = 'blocked' WHERE email = $1", [EMAIL]);
    const r = await request(app).get('/wallet').set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('USER_BLOCKED');
  });
});
