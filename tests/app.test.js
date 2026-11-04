const request = require('supertest');
const app = require('../src/app');
const { migrate } = require('../src/config/db');
const walletService = require('../src/services/wallet.service');
const { startDb, stopDb, clearDb, createUser, credits, queryOne } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

describe('Phase 6 - backend bootstrap', () => {
  test('GET /health reports ok + db up, uptime, version (P06.T09)', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, data: { ok: true, db: 'up' } });
    expect(typeof r.body.data.uptime).toBe('number');
    expect(r.body.data.version).toBeTruthy();
  });

  test('unknown route -> standard error envelope (P06.T10)', async () => {
    const r = await request(app).get('/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ success: false, code: 'NOT_FOUND', message: 'Route not found' });
  });

  test('bad JSON body -> 400 envelope, never a stack trace', async () => {
    const r = await request(app).post('/auth/send-otp').set('Content-Type', 'application/json').send('{bad json');
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ success: false, code: 'BAD_JSON' });
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.js/);
  });

  test('Joi validation rejects bad input with a clear message (P06.T12)', async () => {
    const r = await request(app).post('/auth/verify-otp').send({ email: 'a@b.co', otp: '12', deviceId: 'dev-1' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_ERROR');
    expect(r.body.message).toMatch(/6 digits/);
  });

  test('body over 100kb is rejected (P06.T07)', async () => {
    const r = await request(app)
      .post('/auth/send-otp')
      .send({ email: 'a@b.co', pad: 'x'.repeat(120 * 1024) });
    expect(r.status).toBe(413);
  });

  test('rate limit headers are present (P06.T13)', async () => {
    const r = await request(app).post('/auth/send-otp').send({});
    expect(r.headers.ratelimit || r.headers['ratelimit-policy'] || r.headers['ratelimit-limit']).toBeTruthy();
  });

  test('security headers from helmet, no x-powered-by', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  test('migrations are idempotent', async () => {
    await expect(migrate()).resolves.toBeUndefined();
    const m = await queryOne('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(m.n).toBeGreaterThanOrEqual(1);
  });
});

describe('Postgres money safety under concurrency', () => {
  test('10 parallel debits of 1000 on a 5000 balance: exactly 5 succeed, balance never negative', async () => {
    const { user } = await createUser({ credits: 5000 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => walletService.applyChange(user.id, -1000, 'call_charge', `CA-par-${i}`)),
    );
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(5);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'INSUFFICIENT_CREDITS')).toBe(true);
    expect(await credits(user.id)).toBe(0);
    expect(await walletService.reconcileAll()).toEqual([]);
  });

  test('the DB itself refuses a negative balance (CHECK constraint)', async () => {
    const { user } = await createUser({ credits: 10 });
    await expect(queryOne('UPDATE wallets SET credits = -1 WHERE user_id = $1', [user.id])).rejects.toThrow(/check constraint/);
  });
});

describe('P09.T09 GET /me', () => {
  test('returns profile, stats and flags; PATCH updates the name', async () => {
    const { user, token } = await createUser({ credits: 2500 });
    const r = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.data.user).toMatchObject({ id: user.id, email: user.email, status: 'active' });
    expect(r.body.data.flags).toEqual({ rewardsDisabled: false, canCall: true, minutes: 2 });
    expect(r.body.data.stats).toEqual({ totalTalkSeconds: 0, totalMinutesUsed: 0, totalCalls: 0 });
    const p = await request(app).patch('/me').set('Authorization', `Bearer ${token}`).send({ name: 'Ravi' });
    expect(p.body.data.user.name).toBe('Ravi');
  });
});
