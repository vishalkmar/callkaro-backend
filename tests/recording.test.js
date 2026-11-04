// Phase 23 server: recording consent rules, provider webhooks, signed download links, retention.
const twilio = require('twilio');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const voice = require('../src/services/voice.service');
const { env } = require('../src/config/env');
const cleanup = require('../src/jobs/cleanupRecordings.job');
const { startDb, stopDb, clearDb, createUser, query, queryOne } = require('./helpers');

const BASE = 'https://api.test.local';
const AUTH = 'twilio-auth-token';
const post = (path, params) =>
  request(app)
    .post(path)
    .type('form')
    .set('X-Twilio-Signature', twilio.getExpectedTwilioSignature(AUTH, `${BASE}${path}`, params))
    .send(params);
const sid = n => `CA${String(n).padStart(32, '0')}`;
const getCall = s => queryOne('SELECT * FROM calls WHERE call_sid = $1', [s]);

// Fake Twilio REST client
const rest = { created: [], updated: [], removed: [] };
const fakeClient = {
  calls: callSid => ({
    recordings: Object.assign(
      recSid => ({
        update: async body => {
          rest.updated.push({ callSid, recSid, ...body });
          return {};
        },
      }),
      {
        create: async body => {
          rest.created.push({ callSid, ...body });
          return { sid: `RE${callSid.slice(2)}` };
        },
      },
    ),
  }),
  recordings: recSid => ({
    remove: async () => {
      rest.removed.push(recSid);
    },
  }),
};

beforeAll(startDb);
beforeEach(async () => {
  await voice.syncCallerPool();
  voice.setRestClientForTest(fakeClient);
  rest.created.length = 0;
  rest.updated.length = 0;
  rest.removed.length = 0;
});
afterAll(stopDb);
afterEach(clearDb);

const startCall = (user, n, { record = false } = {}) =>
  post('/voice/outbound', {
    CallSid: sid(n),
    From: `client:${user.id}`,
    To: '+919876543210',
    ...(record ? { Record: 'true' } : {}),
  });
const answer = n => post('/voice/status', { CallSid: `CAchild${n}`, ParentCallSid: sid(n), CallStatus: 'in-progress' });
const rec = (token, path, n) =>
  request(app).post(`/voice/recording/${path}`).set('Authorization', `Bearer ${token}`).send({ callSid: sid(n) });

describe('consent rules (P23.T06-T08)', () => {
  test('record all calls: armed at dial, callee hears the notice, recording starts on answer', async () => {
    const { user } = await createUser({ credits: 5000 });
    await startCall(user, 1, { record: true });
    expect((await getCall(sid(1))).recording_status).toBe('armed');
    const hook = await post('/voice/answer-hook', { CallSid: 'CAchild1', ParentCallSid: sid(1) });
    expect(hook.text).toContain('This call is being recorded');
    await answer(1);
    expect(rest.created).toEqual([expect.objectContaining({ callSid: sid(1), recordingChannels: 'dual' })]);
    expect((await getCall(sid(1))).recording_status).toBe('in-progress');
  });

  test('no recording -> no notice to the callee', async () => {
    const { user } = await createUser({ credits: 5000 });
    await startCall(user, 2);
    const hook = await post('/voice/answer-hook', { CallSid: 'CAchild2', ParentCallSid: sid(2) });
    expect(hook.text).not.toContain('recorded');
  });

  test('tap Record while ringing -> armed; after answer without the notice -> refused', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    await startCall(user, 3);
    expect((await rec(token, 'start', 3)).body.data.recordingStatus).toBe('armed');

    const other = await createUser({ credits: 5000 });
    await startCall(other.user, 5);
    await answer(5);
    const r = await rec(other.token, 'start', 5);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RECORDING_NEEDS_NOTICE');
    expect(rest.created).toHaveLength(0);
  });

  test('pause and resume an armed recording', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    await startCall(user, 6, { record: true });
    await answer(6);
    expect((await rec(token, 'stop', 6)).body.data.recordingStatus).toBe('paused');
    expect((await rec(token, 'start', 6)).body.data.recordingStatus).toBe('in-progress');
    expect(rest.updated.map(u => u.status)).toEqual(['paused', 'in-progress']);
  });

  test('a call of another user cannot be recorded', async () => {
    const a = await createUser({ credits: 5000 });
    const b = await createUser({ credits: 5000 });
    await startCall(a.user, 7);
    expect((await rec(b.token, 'start', 7)).status).toBe(404);
  });

  test('ended call -> CALL_ENDED', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    await startCall(user, 8);
    await post('/voice/dial-complete', { CallSid: sid(8), DialCallStatus: 'busy', DialCallDuration: '0' });
    expect((await rec(token, 'start', 8)).body.code).toBe('CALL_ENDED');
  });
});

describe('recording files (P23.T10-T11)', () => {
  const finishRecording = n =>
    post('/voice/recording-status', {
      CallSid: sid(n),
      RecordingSid: `RE${n}`,
      RecordingStatus: 'completed',
      RecordingDuration: '61',
      RecordingUrl: 'https://api.twilio.com/rec',
    });

  test('webhook stores sid + duration; URL only when completed; link is short-lived and personal', async () => {
    const { user, token } = await createUser({ credits: 5000 });
    await startCall(user, 10, { record: true });
    const before = await request(app).get(`/recordings/${sid(10)}/url`).set('Authorization', `Bearer ${token}`);
    expect(before.body.code).toBe('NO_RECORDING');
    await finishRecording(10);
    expect(await getCall(sid(10))).toMatchObject({
      recording_sid: 'RE10',
      recording_status: 'completed',
      recording_duration: 61,
    });
    const r = await request(app).get(`/recordings/${sid(10)}/url`).set('Authorization', `Bearer ${token}`);
    expect(r.body.data).toMatchObject({ expiresInSeconds: 300, durationSec: 61 });
    const p = jwt.decode(r.body.data.url.split('/download/')[1]);
    expect(p.exp - p.iat).toBe(300);
    expect(p.uid).toBe(user.id);
    const old = jwt.sign({ csid: sid(10), uid: user.id, typ: 'rec' }, env.JWT_ACCESS_SECRET, { expiresIn: -10 });
    expect((await request(app).get(`/recordings/download/${old}`)).status).toBe(401);
    const forged = jwt.sign({ csid: sid(10), uid: user.id, typ: 'rec' }, 'not-our-secret');
    expect((await request(app).get(`/recordings/download/${forged}`)).status).toBe(401);
  });

  test('another user cannot get my recording link', async () => {
    const a = await createUser({ credits: 5000 });
    const b = await createUser();
    await startCall(a.user, 11, { record: true });
    await finishRecording(11);
    const r = await request(app).get(`/recordings/${sid(11)}/url`).set('Authorization', `Bearer ${b.token}`);
    expect(r.status).toBe(404);
  });

  test('retention: provider copies deleted after the retention days, metadata anonymised later', async () => {
    const { user } = await createUser({ credits: 5000 });
    await startCall(user, 12, { record: true });
    await finishRecording(12);
    await startCall(user, 13, { record: true });
    await finishRecording(13);
    await query("UPDATE calls SET started_at = now() - ($1 || ' days')::interval WHERE call_sid = $2", [
      String(env.RECORDING_RETENTION_DAYS + 1),
      sid(12),
    ]);
    await query("UPDATE calls SET started_at = now() - ($1 || ' days')::interval WHERE call_sid = $2", [
      String(env.CALL_METADATA_RETENTION_DAYS + 1),
      sid(13),
    ]);
    const r = await cleanup.run();
    expect(rest.removed.sort()).toEqual(['RE12', 'RE13']);
    expect((await getCall(sid(12))).recording_deleted_at).not.toBeNull();
    expect((await getCall(sid(13))).to_number).toBe('REDACTED');
    expect(r).toEqual({ deleted: 2, anonymized: 1 });
    expect(await cleanup.run()).toEqual({ deleted: 0, anonymized: 0 });
  });
});
