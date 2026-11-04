// Phase 7 checklist coverage beyond auth.test.js: Brevo request shape + failure, hourly limit,
// session hash storage, device binding, existing-user login, token lifetimes.
jest.mock('axios');

const axios = require('axios');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const { generateOtp } = require('../src/services/auth.service');
const { sha256 } = require('../src/services/token.service');
const { otpEmailHtml } = require('../src/services/brevo.service');
const { startDb, stopDb, clearDb, query, queryOne } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(async () => {
  await clearDb();
  axios.post.mockReset();
});

const lastCode = () => {
  const body = axios.post.mock.calls.at(-1)[1];
  return /is (\d{6})\./.exec(body.textContent)[1];
};

const login = async (email, deviceId = 'dev-A') => {
  axios.post.mockResolvedValue({ data: { messageId: 'm1' } });
  await query('DELETE FROM otps WHERE email = $1', [email]);
  expect((await request(app).post('/auth/send-otp').send({ email })).status).toBe(200);
  return request(app).post('/auth/verify-otp').send({ email, otp: lastCode(), deviceId });
};

describe('P07.T03-T05 Brevo transactional email', () => {
  test('POSTs to Brevo with api-key header, verified sender, code in subject/html/text', async () => {
    axios.post.mockResolvedValue({ data: { messageId: 'm1' } });
    const r = await request(app).post('/auth/send-otp').send({ email: 'Ravi@Example.com ' });
    expect(r.status).toBe(200);
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(opts.headers['api-key']).toBe(env.BREVO_API_KEY);
    expect(body.sender).toEqual({ email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME });
    expect(body.to).toEqual([{ email: 'ravi@example.com' }]); // trimmed + lowercased
    const code = lastCode();
    expect(body.subject).toContain(code);
    expect(body.htmlContent).toContain(code);
    expect(body.htmlContent).toMatch(/valid for 5 minutes/);
    expect(body.htmlContent).toMatch(/ignore this email/);
  });

  test('template escapes HTML in the app name', () => {
    expect(otpEmailHtml({ appName: '<b>x</b>', code: '123456', minutes: 5 })).not.toContain('<b>x</b>');
  });

  test('P07.T18 Brevo failure -> 503 friendly message, nothing stored, cooldown not started', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { status: 401, data: { code: 'unauthorized' } } }));
    const r = await request(app).post('/auth/send-otp').send({ email: 'a@example.com' });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, code: 'EMAIL_SEND_FAILED', message: 'Could not send code, try again' });
    expect(await queryOne("SELECT 1 FROM otps WHERE email = 'a@example.com'")).toBeNull();
    axios.post.mockResolvedValue({ data: {} });
    expect((await request(app).post('/auth/send-otp').send({ email: 'a@example.com' })).status).toBe(200); // retry allowed now
  });
});

describe('P07.T07-T09 OTP generation and limits', () => {
  test('codes are 6 digits, keep leading zeros and are not predictable', () => {
    const codes = Array.from({ length: 2000 }, generateOtp);
    expect(codes.every(c => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(1990);
    expect(codes.some(c => c.startsWith('0'))).toBe(true);
  });

  test('OTP expires 5 minutes after sending', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await request(app).post('/auth/send-otp').send({ email: 'ttl@example.com' });
    const row = await queryOne("SELECT EXTRACT(EPOCH FROM (expires_at - last_sent_at))::int AS s FROM otps WHERE email = 'ttl@example.com'");
    expect(row.s).toBe(300);
  });

  test('max 5 sends per hour per email', async () => {
    axios.post.mockResolvedValue({ data: {} });
    const email = 'many@example.com';
    for (let i = 0; i < 5; i++) {
      // pretend the 60s cooldown passed
      await query("UPDATE otps SET last_sent_at = now() - interval '61 seconds' WHERE email = $1", [email]);
      expect((await request(app).post('/auth/send-otp').send({ email })).status).toBe(200);
      await query(
        "UPDATE otps SET send_times = ARRAY(SELECT t - interval '61 seconds' FROM unnest(send_times) t) WHERE email = $1",
        [email],
      );
    }
    await query("UPDATE otps SET last_sent_at = now() - interval '61 seconds' WHERE email = $1", [email]);
    const r = await request(app).post('/auth/send-otp').send({ email });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('OTP_HOURLY_LIMIT');
  });

  test('lock lasts 15 minutes and also blocks send-otp', async () => {
    axios.post.mockResolvedValue({ data: {} });
    const email = 'lock@example.com';
    await request(app).post('/auth/send-otp').send({ email });
    for (let i = 0; i < 5; i++) {
      await request(app).post('/auth/verify-otp').send({ email, otp: '000000', deviceId: 'device-lock-1' });
    }
    const row = await queryOne(
      'SELECT EXTRACT(EPOCH FROM (locked_until - now()))::int AS s, otp_hash FROM otps WHERE email = $1',
      [email],
    );
    expect(row.s).toBeGreaterThan(14 * 60);
    expect(row.otp_hash).toBeNull(); // the code cannot be guessed any more
    await query("UPDATE otps SET last_sent_at = now() - interval '2 minutes' WHERE email = $1", [email]);
    const r = await request(app).post('/auth/send-otp').send({ email });
    expect(r.body.code).toBe('OTP_LOCKED');
  });
});

describe('P07.T11-T16 sessions, tokens, wallet', () => {
  test('tokens have the configured lifetimes; session stores only the refresh hash', async () => {
    const r = await login('t@example.com');
    expect(r.status).toBe(200);
    const { accessToken, refreshToken } = r.body.data.tokens;
    const a = jwt.decode(accessToken);
    const rf = jwt.decode(refreshToken);
    expect(a.exp - a.iat).toBe(30 * 60);
    expect(rf.exp - rf.iat).toBe(30 * 86400);
    const s = await queryOne('SELECT * FROM sessions WHERE id = $1', [a.sid]);
    expect(s.refresh_token_hash).toBe(sha256(refreshToken));
    expect(s.refresh_token_hash).not.toContain(refreshToken.slice(0, 20));
    expect(s.device_id).toBe('dev-A');
    expect(await queryOne("SELECT 1 FROM otps WHERE email = 't@example.com'")).toBeNull(); // OTP row deleted
  });

  test('existing user logs in again: same id, isNew false, no second welcome bonus', async () => {
    const first = await login('again@example.com');
    const second = await login('again@example.com', 'dev-A');
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
    expect(first.body.data.isNew).toBe(true);
    expect(second.body.data.isNew).toBe(false);
    expect(second.body.data.wallet.credits).toBe(2000);
    expect((await queryOne("SELECT COUNT(*)::int AS n FROM ledger_entries WHERE type = 'welcome_bonus'")).n).toBe(1);
  });

  test('device binding: 3rd new account on the same device is refused; 2nd gets no bonus', async () => {
    const a = await login('one@example.com', 'shared-device');
    const b = await login('two@example.com', 'shared-device');
    expect(a.body.data.wallet.credits).toBe(2000);
    expect(b.status).toBe(200);
    expect(b.body.data.wallet.credits).toBe(0);
    const c = await login('three@example.com', 'shared-device');
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('DEVICE_LIMIT');
  });

  test('P07.T17 send-otp response is identical for a new and an existing email', async () => {
    await login('exists@example.com');
    axios.post.mockResolvedValue({ data: {} });
    const existing = await request(app).post('/auth/send-otp').send({ email: 'exists@example.com' });
    const fresh = await request(app).post('/auth/send-otp').send({ email: 'brand-new@example.com' });
    expect(existing.status).toBe(fresh.status);
    expect(existing.body).toEqual(fresh.body);
  });

  test('refresh with a garbage token -> 401 INVALID_REFRESH', async () => {
    const r = await request(app).post('/auth/refresh').send({ refreshToken: 'not-a-jwt-but-long-enough-0123456789' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_REFRESH');
  });

  test('access token signed with the wrong secret is rejected', async () => {
    const forged = jwt.sign({ sub: '00000000-0000-0000-0000-000000000000', typ: 'access' }, 'wrong-secret');
    const r = await request(app).get('/me').set('Authorization', `Bearer ${forged}`);
    expect(r.status).toBe(401);
  });
});
