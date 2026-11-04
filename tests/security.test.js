// Phase 26: HTTPS-only, rate limits, admin protection, log redaction, prod secret checks, abuse rules.
const express = require('express');
const request = require('supertest');
const pino = require('pino');
const { Writable } = require('stream');
const app = require('../src/app');
const { env } = require('../src/config/env');
const { make } = require('../src/middlewares/rateLimit');
const { normalizeIp } = require('../src/middlewares/adminAuth');
const { isDisposable } = require('../src/services/auth.service');
const { startDb, stopDb, clearDb, createUser } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

describe('HTTPS only in production (P26.T01)', () => {
  afterEach(() => {
    env.isProd = false;
  });

  test('BUG FIX: plain HTTP without X-Forwarded-Proto (straight to the Node port) is refused', async () => {
    env.isProd = true;
    const r = await request(app).post('/auth/send-otp').send({ email: 'a@b.co' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('HTTPS_REQUIRED');
  });

  test('X-Forwarded-Proto: http refused, https allowed, /health always open', async () => {
    env.isProd = true;
    expect((await request(app).get('/wallet').set('X-Forwarded-Proto', 'http')).status).toBe(403);
    expect((await request(app).get('/wallet').set('X-Forwarded-Proto', 'https')).status).toBe(401); // reached auth
    expect((await request(app).get('/health')).status).toBe(200);
  });
});

describe('rate limits (P26.T04)', () => {
  const mini = (limiter, withUser) => {
    const a = express();
    a.set('trust proxy', 1);
    a.use((req, res, next) => {
      if (withUser) {
        req.user = { id: req.headers['x-user'] };
      }
      next();
    });
    a.get('/x', limiter, (req, res) => res.json({ ok: true }));
    return a;
  };

  test('per IP: the 4th request in the window gets 429 with the standard envelope', async () => {
    const env0 = env.isTest;
    env.isTest = false;
    const a = mini(make(60000, 3), false);
    env.isTest = env0;
    for (let i = 0; i < 3; i++) {
      expect((await request(a).get('/x')).status).toBe(200);
    }
    const r = await request(a).get('/x');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({
      success: false,
      code: 'RATE_LIMITED',
      message: expect.any(String),
    });
    expect(r.headers.ratelimit || r.headers['ratelimit-policy']).toBeTruthy();
  });

  test('per user: one user hitting the limit does not block another user on the same IP', async () => {
    const env0 = env.isTest;
    env.isTest = false;
    const a = mini(make(60000, 2, true), true);
    env.isTest = env0;
    await request(a).get('/x').set('x-user', 'u1');
    await request(a).get('/x').set('x-user', 'u1');
    expect((await request(a).get('/x').set('x-user', 'u1')).status).toBe(429);
    expect((await request(a).get('/x').set('x-user', 'u2')).status).toBe(200);
  });
});

describe('admin protection (P26.T17)', () => {
  afterEach(() => {
    env.ADMIN_IP_ALLOWLIST.length = 0;
  });

  test('wrong / missing key refused; key compared in constant time', async () => {
    expect((await request(app).get('/admin/reconcile')).status).toBe(401);
    expect((await request(app).get('/admin/reconcile').set('X-Admin-Key', 'x')).status).toBe(401);
    expect((await request(app).get('/admin/reconcile').set('X-Admin-Key', env.ADMIN_API_KEY)).status).toBe(200);
  });

  test('IP allowlist blocks other IPs even with the right key', async () => {
    env.ADMIN_IP_ALLOWLIST.push('10.9.9.9');
    const r = await request(app).get('/admin/reconcile').set('X-Admin-Key', env.ADMIN_API_KEY);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('IP_NOT_ALLOWED');
  });

  test('BUG FIX: IPv4 seen as "::ffff:x.x.x.x" matches the allowlist entry', async () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    env.ADMIN_IP_ALLOWLIST.push('127.0.0.1');
    const r = await request(app).get('/admin/reconcile').set('X-Admin-Key', env.ADMIN_API_KEY);
    expect(r.status).toBe(200);
  });
});

describe('logs never contain secrets (P26.T14)', () => {
  test('tokens, OTPs, signatures, payment ids and admin key are redacted', () => {
    const lines = [];
    const sink = new Writable({
      write(chunk, enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const { REDACT_PATHS } = require('../src/utils/logger');
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info({
      body: {
        otp: '482915',
        refreshToken: 'eyJ.refresh',
        purchaseToken: 'gp-tok',
        razorpay_signature: 'sig',
        custom_data: 'uid:nonce',
      },
      req: {
        headers: {
          authorization: 'Bearer abc',
          'x-admin-key': 'k',
          'x-twilio-signature': 's',
        },
      },
      token: 'top-level',
    });
    const out = lines.join('');
    for (const secret of ['482915', 'eyJ.refresh', 'gp-tok', '"sig"', 'uid:nonce', 'Bearer abc', '"k"', 'top-level']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });
});

describe('production boot checks (P26.T03, T16)', () => {
  const { validate } = require('../src/config/env');
  const LONG = 'x'.repeat(64);
  const prodEnv = over => ({
    ...process.env,
    NODE_ENV: 'production',
    JWT_ACCESS_SECRET: LONG,
    JWT_REFRESH_SECRET: LONG,
    PUBLIC_BASE_URL: 'https://api.callkaro.in',
    SKIP_WEBHOOK_SIGNATURE: 'false',
    TWILIO_AUTH_TOKEN: 't',
    ...over,
  });
  const boot = over => {
    const saved = process.env;
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env = prodEnv(over);
      validate();
      return {
        exited: exit.mock.calls.length > 0,
        msg: err.mock.calls.flat().join(' '),
      };
    } finally {
      process.env = saved;
      exit.mockRestore();
      err.mockRestore();
    }
  };

  test('short JWT secrets stop the server', () => {
    expect(boot({ JWT_ACCESS_SECRET: 'short' })).toMatchObject({
      exited: true,
      msg: expect.stringMatching(/JWT_ACCESS_SECRET/),
    });
  });
  test('NEW: webhook signature skipping can never be on in production', () => {
    expect(boot({ SKIP_WEBHOOK_SIGNATURE: 'true' })).toMatchObject({
      exited: true,
      msg: expect.stringMatching(/SKIP_WEBHOOK/),
    });
  });
  test('NEW: dev OTP console mode can never be on in production', () => {
    expect(boot({ OTP_DEV_LOG: 'true' })).toMatchObject({ exited: true, msg: expect.stringMatching(/OTP_DEV_LOG/) });
  });
  test('production can start without Twilio (calls simply not configured yet)', () => {
    const noTwilio = {};
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_AUTH_TOKEN', 'TWILIO_TWIML_APP_SID', 'CALLER_ID_POOL']) {
      noTwilio[k] = '';
    }
    expect(boot(noTwilio)).toMatchObject({ exited: false });
  });
  test('half a Twilio setup is refused', () => {
    expect(boot({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_API_KEY_SID: '', TWILIO_TWIML_APP_SID: '' })).toMatchObject({
      exited: true,
      msg: expect.stringMatching(/TWILIO_API_KEY_SID/),
    });
  });
  test('NEW: http PUBLIC_BASE_URL refused in production', () => {
    expect(boot({ PUBLIC_BASE_URL: 'http://api.callkaro.in' })).toMatchObject({
      exited: true,
    });
  });
});

describe('abuse rules (P26.T05, T08)', () => {
  test.each(['a@mailinator.com', 'b@10minutemail.com', 'c@guerrillamail.com'])('%s is a disposable domain', email => {
    expect(isDisposable(email)).toBe(true);
  });
  test('normal providers are allowed', () => {
    expect(isDisposable('ravi@gmail.com')).toBe(false);
  });
  test('rewards blocked for rooted devices even with a valid account', async () => {
    const { token } = await createUser();
    const r = await request(app)
      .post('/wallet/checkin')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Device-Integrity', 'emulator=0;rooted=1');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('REWARDS_DISABLED');
  });
});

describe('dev OTP console mode (testing without Brevo)', () => {
  const axios = require('axios'); // Brevo is reached through axios.post
  afterEach(() => {
    env.OTP_DEV_LOG = false;
    jest.restoreAllMocks();
  });
  test('on: no Brevo call, code only in the console, never in the API response', async () => {
    env.OTP_DEV_LOG = true;
    const send = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    const out = jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = await request(app).post('/auth/send-otp').send({ email: 'dev@example.com' });
    expect(r.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
    const line = out.mock.calls.flat().join(' ');
    const code = /-> (\d{6})/.exec(line)[1];
    expect(JSON.stringify(r.body)).not.toContain(code);
    const v = await request(app).post('/auth/verify-otp').send({ email: 'dev@example.com', otp: code, deviceId: 'dev-device-1' });
    expect(v.status).toBe(200);
  });
  test('off (default): Brevo is used', async () => {
    const send = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    await request(app).post('/auth/send-otp').send({ email: 'mail@example.com' });
    expect(send).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email', expect.any(Object), expect.any(Object));
  });
});
