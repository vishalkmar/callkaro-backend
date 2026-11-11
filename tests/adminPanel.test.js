// Admin panel: password + 2FA sign-in, sessions, lockout, CSRF header, data endpoints, security tab.
const axios = require('axios');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const authSvc = require('../src/services/admin/adminAuth.service');
const totp = require('../src/services/admin/totp');
const { startDb, stopDb, clearDb, createUser, credits, query, queryOne } = require('./helpers');

const H = { 'X-Admin-Panel': '1' };
const PASSWORD = 'Str0ng-admin-pass';
let mailed = [];

beforeAll(async () => {
  await startDb();
  Object.assign(env, { ADMIN_USERNAME: 'Admin', ADMIN_PASSWORD: PASSWORD, ADMIN_2FA_EMAIL: 'boss@example.com' });
});
beforeEach(async () => {
  await query('DELETE FROM admins');
  await authSvc.seedAdmin();
  mailed = [];
  jest.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    mailed.push(body);
    return { data: {} };
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDb();
});
afterAll(stopDb);

const codeFromMail = () => /^(\d{6})/.exec(mailed.at(-1).subject)[1];
const cookieOf = res => (res.headers['set-cookie'] || [])[0].split(';')[0];

/** Full sign-in with the emailed code; returns the session cookie. */
const signIn = async (password = PASSWORD) => {
  const a = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password });
  expect(a.status).toBe(200);
  const b = await request(app).post('/admin-api/auth/verify').set(H).send({ challengeId: a.body.data.challengeId, code: codeFromMail() });
  expect(b.status).toBe(200);
  return cookieOf(b);
};
const get = (path, cookie) => request(app).get(`/admin-api${path}`).set(H).set('Cookie', cookie);
const post = (path, cookie, body = {}) => request(app).post(`/admin-api${path}`).set(H).set('Cookie', cookie).send(body);

describe('sign in', () => {
  test('password -> code emailed to the 2FA address -> session cookie (httpOnly, SameSite=Strict)', async () => {
    const a = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'ADMIN', password: PASSWORD });
    expect(a.body.data).toMatchObject({ method: 'email', sentTo: 'b***@example.com' });
    expect(mailed.at(-1).to).toEqual([{ email: 'boss@example.com' }]);
    expect(JSON.stringify(a.body)).not.toContain(codeFromMail()); // the code is never in the response
    const b = await request(app).post('/admin-api/auth/verify').set(H).send({ challengeId: a.body.data.challengeId, code: codeFromMail() });
    const cookie = b.headers['set-cookie'][0];
    expect(cookie).toMatch(/ck_admin=[a-f0-9]{64}; Path=\/admin-api; HttpOnly; SameSite=Strict/);
    expect((await get('/me', cookieOf(b))).body.data.admin.username).toBe('admin');
  });

  test('wrong password: same answer for unknown users; 5 misses lock the account', async () => {
    const unknown = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'nobody', password: 'x' });
    const wrong = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: 'x' });
    expect(unknown.body).toEqual(wrong.body); // no user enumeration
    for (let i = 0; i < 4; i++) {
      await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: 'x' });
    }
    const locked = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: PASSWORD });
    expect(locked.body.code).toBe('ADMIN_LOCKED');
  });

  test('a wrong code 5 times kills the login; a used code cannot be replayed', async () => {
    const a = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: PASSWORD });
    const id = a.body.data.challengeId;
    for (let i = 0; i < 5; i++) {
      await request(app).post('/admin-api/auth/verify').set(H).send({ challengeId: id, code: '000000' });
    }
    const late = await request(app).post('/admin-api/auth/verify').set(H).send({ challengeId: id, code: codeFromMail() });
    expect(late.body.code).toBe('ADMIN_CODE_EXPIRED');

    const c = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: PASSWORD });
    const code = codeFromMail();
    await request(app).post('/admin-api/auth/verify').set(H).send({ challengeId: c.body.data.challengeId, code });
    const replay = await request(app).post('/admin-api/auth/verify').set(H).send({ challengeId: c.body.data.challengeId, code });
    expect(replay.body.code).toBe('ADMIN_CODE_EXPIRED');
  });

  test('no session / forged cookie / missing panel header are all refused', async () => {
    expect((await request(app).get('/admin-api/me').set(H)).status).toBe(401);
    expect((await request(app).get('/admin-api/me').set(H).set('Cookie', `ck_admin=${'a'.repeat(64)}`)).status).toBe(401);
    const cookie = await signIn();
    expect((await request(app).get('/admin-api/me').set('Cookie', cookie)).status).toBe(403); // CSRF guard
  });

  test('logout ends the session', async () => {
    const cookie = await signIn();
    await post('/auth/logout', cookie);
    expect((await get('/me', cookie)).status).toBe(401);
  });

  test('idle too long -> signed out', async () => {
    const cookie = await signIn();
    await query("UPDATE admin_sessions SET last_seen_at = now() - interval '3 hours'");
    expect((await get('/me', cookie)).status).toBe(401);
  });
});

describe('security tab', () => {
  test('authenticator app: set up, confirm, then sign-in asks for its code instead of email', async () => {
    const cookie = await signIn();
    const s = (await post('/security/totp/setup', cookie)).body.data;
    expect(s.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await post('/security/totp/enable', cookie, { code: '000000' })).body.code).toBe('ADMIN_BAD_CODE');
    expect((await post('/security/totp/enable', cookie, { code: totp.codeAt(s.secret, Math.floor(Date.now() / 30000)) })).status).toBe(200);
    const stored = await queryOne('SELECT totp_secret FROM admins');
    expect(stored.totp_secret).not.toContain(s.secret); // encrypted at rest

    mailed = [];
    const a = await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: PASSWORD });
    expect(a.body.data.method).toBe('totp');
    expect(mailed).toHaveLength(0);
    const b = await request(app)
      .post('/admin-api/auth/verify')
      .set(H)
      .send({ challengeId: a.body.data.challengeId, code: totp.codeAt(s.secret, Math.floor(Date.now() / 30000)) });
    expect(b.status).toBe(200);
  });

  test('change password: needs the current one, rejects weak ones, signs out other browsers', async () => {
    const other = await signIn();
    const cookie = await signIn();
    expect((await post('/security/password', cookie, { currentPassword: 'nope', newPassword: 'Another-pass-123' })).body.code).toBe('ADMIN_BAD_PASSWORD');
    expect((await post('/security/password', cookie, { currentPassword: PASSWORD, newPassword: 'short' })).body.code).toBe('ADMIN_WEAK_PASSWORD');
    expect((await post('/security/password', cookie, { currentPassword: PASSWORD, newPassword: 'Another-pass-123' })).status).toBe(200);
    expect((await get('/me', other)).status).toBe(401);
    expect((await get('/me', cookie)).status).toBe(200);
    expect((await request(app).post('/admin-api/auth/login').set(H).send({ username: 'admin', password: PASSWORD })).status).toBe(401);
  });

  test('audit log records sign-ins and actions', async () => {
    const cookie = await signIn();
    const log = (await get('/security/audit', cookie)).body.data.map(l => l.action);
    expect(log).toEqual(expect.arrayContaining(['login_password_ok', 'login_success']));
  });
});

describe('data', () => {
  test('dashboard: KPIs, daily series for the range, bad range refused', async () => {
    const cookie = await signIn();
    await createUser({ credits: 5000 });
    const d = (await get('/dashboard?from=2026-01-01&to=2026-01-07', cookie)).body.data;
    expect(d.series).toHaveLength(7);
    expect(d.kpis.usersTotal).toBe(1);
    expect((await get('/dashboard?from=2026-02-01&to=2026-01-01', cookie)).body.code).toBe('BAD_RANGE');
    expect((await get("/dashboard?from=2026-01-01'--", cookie)).status).toBe(400);
  });

  test('users: search is injection-safe; detail shows signup story, wallet and history', async () => {
    const cookie = await signIn();
    const { user } = await createUser({ credits: 5000 });
    const evil = encodeURIComponent("x' OR '1'='1");
    expect((await get(`/users?search=${evil}`, cookie)).body.data.total).toBe(0);
    const list = (await get(`/users?search=${encodeURIComponent(user.email.slice(0, 5))}`, cookie)).body.data;
    expect(list.users[0].id).toBe(user.id);
    const d = (await get(`/users/${user.id}`, cookie)).body.data;
    expect(d.user.credits).toBe(5000);
    expect(d.signup.method).toBe('Email one-time code');
    expect((await get('/users/not-a-uuid', cookie)).status).toBe(404);
  });

  test('block / unblock and credit adjust are applied and audited', async () => {
    const cookie = await signIn();
    const { user } = await createUser({ credits: 1000 });
    await post(`/users/${user.id}/block`, cookie, { blocked: true, reason: 'spam calls' });
    expect((await queryOne('SELECT status FROM users WHERE id = $1', [user.id])).status).toBe('blocked');
    await post(`/users/${user.id}/block`, cookie, { blocked: false });
    expect((await queryOne('SELECT status FROM users WHERE id = $1', [user.id])).status).toBe('active');
    await post(`/users/${user.id}/credits`, cookie, { amount: 500, reason: 'support refund' });
    expect(await credits(user.id)).toBe(1500);
    await post(`/users/${user.id}/credits`, cookie, { amount: -9999, reason: 'abuse' });
    expect(await credits(user.id)).toBe(0); // never below zero
    const actions = (await get('/security/audit', cookie)).body.data.map(l => l.action);
    expect(actions).toEqual(expect.arrayContaining(['user_blocked', 'user_unblocked', 'credits_adjusted']));
  });

  test('transactions: filter by type and range, totals', async () => {
    const cookie = await signIn();
    const { user } = await createUser({ credits: 1000 });
    await post(`/users/${user.id}/credits`, cookie, { amount: 300, reason: 'gift' });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const t = (await get(`/transactions?from=${today}&to=${today}&type=admin_adjust`, cookie)).body.data;
    expect(t.rows.every(r => r.type === 'admin_adjust')).toBe(true);
    expect(t.credited).toBeGreaterThanOrEqual(300);
  });
});
