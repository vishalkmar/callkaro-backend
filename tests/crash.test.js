// P29.T06 server crash reporting (alert webhook, no SDK).
jest.mock('../src/services/alert.service', () => ({ notify: jest.fn(async () => {}) }));
const EventEmitter = require('events');
const express = require('express');
const request = require('supertest');
const { notify } = require('../src/services/alert.service');
const { errorHandler } = require('../src/middlewares/error');
const { installCrashHandlers } = require('../src/utils/crash');
const { errors } = require('../src/utils/response');

beforeEach(() => jest.clearAllMocks());

const appThrowing = err => {
  const a = express();
  a.get('/calls/:id', () => {
    throw err;
  });
  a.use(errorHandler);
  return a;
};

describe('unexpected 500s are reported', () => {
  test('alert names the route pattern, not the id; client still gets no details', async () => {
    const r = await request(appThrowing(new Error('db exploded'))).get('/calls/123e4567-e89b');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('db exploded');
    expect(notify).toHaveBeenCalledTimes(1);
    const [text, opts] = notify.mock.calls[0];
    expect(text).toBe('Server error on GET /calls/:id: db exploded');
    expect(text).not.toContain('123e4567');
    expect(opts.dedupeKey).toBe('500:GET /calls/:id:db exploded');
  });
  test('expected errors (validation, 4xx) are NOT alerts', async () => {
    await request(appThrowing(errors.badRequest('BAD', 'nope'))).get('/calls/1');
    await request(appThrowing(Object.assign(new Error('dup'), { code: '23505' }))).get('/calls/1');
    expect(notify).not.toHaveBeenCalled();
  });
  test('a very long error message is cut (alerts stay readable)', async () => {
    await request(appThrowing(new Error('x'.repeat(1000)))).get('/calls/1');
    expect(notify.mock.calls[0][0].length).toBeLessThan(220);
  });
});

describe('process crash handlers', () => {
  const fakeProcess = () => Object.assign(new EventEmitter(), { exit: jest.fn() });

  test('unhandled rejection: reported, server keeps running', () => {
    const proc = fakeProcess();
    installCrashHandlers(proc);
    proc.emit('unhandledRejection', new Error('forgot await'));
    expect(notify).toHaveBeenCalledWith('Unhandled promise rejection: forgot await', expect.any(Object));
    expect(proc.exit).not.toHaveBeenCalled();
  });
  test('uncaught exception: reported, then exit(1) so the host restarts it', async () => {
    const proc = fakeProcess();
    installCrashHandlers(proc);
    proc.emit('uncaughtException', new Error('boom'));
    await new Promise(r => setImmediate(r));
    expect(notify).toHaveBeenCalledWith('Server crashed (restarting): boom', { minIntervalMs: 0 });
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
  test('a hanging alert webhook cannot keep a crashed process alive', async () => {
    notify.mockImplementationOnce(() => new Promise(() => {}));
    const proc = fakeProcess();
    installCrashHandlers(proc, { alertWaitMs: 30 });
    proc.emit('uncaughtException', new Error('boom'));
    await new Promise(r => setTimeout(r, 80));
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});
