// Owner rule (2026-11-04): wheel shows 5 / 10 / 20; lands on 5 almost always, on 10 about 1 in 50, never on 20.
const request = require('supertest');
const app = require('../src/app');
const economy = require('../src/config/economy');
const { pickWeighted } = require('../src/services/spin.service');
const { startDb, stopDb, clearDb, createUser, credits, query } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

const tally = runs => {
  const by = {};
  for (let i = 0; i < runs; i++) {
    const c = economy.spinSegments[pickWeighted(economy.spinSegments)].credits;
    by[c] = (by[c] || 0) + 1;
  }
  return by;
};

describe('default wheel', () => {
  test('8 segments: 5, 10, 20 alternating', () => {
    expect(economy.spinSegments.map(s => s.label)).toEqual(['5', '10', '20', '5', '10', '20', '5', '10']);
  });

  test('50,000 spins: ~98% land on 5, ~2% (1 in 50) on 10, never on 20', () => {
    const runs = 50000;
    const by = tally(runs);
    const sd = Math.sqrt(runs * 0.02 * 0.98);
    expect(Math.abs(by[10] - runs * 0.02)).toBeLessThan(4 * sd); // 1000 +/- ~125
    expect(by[5] + by[10]).toBe(runs);
    expect(by[20]).toBeUndefined();
  });

  test('status: real odds, "win up to" counts only winnable prizes', async () => {
    const { token } = await createUser();
    const r = await request(app).get('/spin/status').set('Authorization', `Bearer ${token}`);
    expect(r.body.data.odds).toEqual([
      { credits: 5, percent: 98 },
      { credits: 10, percent: 2 },
      { credits: 20, percent: 0 },
    ]);
    expect(r.body.data.maxWin).toBe(10);
    expect(r.body.data.segments).toHaveLength(8);
    expect(r.body.data.segments[0]).toEqual({ label: '5', credits: 5 }); // weights never sent to the app
  });

  test('/spin/play credits 5 or 10 and the segment index matches the prize', async () => {
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      const { user, token } = await createUser();
      const r = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`).send({ segmentIndex: 2, credits: 20 });
      expect(r.status).toBe(200);
      const { segmentIndex, credits: won, balance } = r.body.data;
      expect(economy.spinSegments[segmentIndex].credits).toBe(won);
      expect([5, 10]).toContain(won);
      expect(balance).toBe(won);
      expect(await credits(user.id)).toBe(won);
      seen.add(won);
    }
    expect(seen.has(5)).toBe(true);
  });
});

describe('SPIN_SEGMENTS_JSON override', () => {
  afterEach(() => {
    delete process.env.SPIN_SEGMENTS_JSON;
  });

  test('a valid custom wheel is used', () => {
    process.env.SPIN_SEGMENTS_JSON = '[{"label":"1","credits":1,"weight":9},{"label":"50","credits":50,"weight":1}]';
    expect(economy.parseSpinSegments().map(s => s.credits)).toEqual([1, 50]);
  });

  test.each([
    '{oops',
    '[{"label":"5","credits":5,"weight":0}]', // only one segment
    '[{"label":"5","credits":5,"weight":0},{"label":"10","credits":10,"weight":0}]', // nothing winnable
    '[{"label":"5","credits":-5,"weight":1},{"label":"10","credits":10,"weight":1}]',
    '[{"label":"5","credits":5.5,"weight":1},{"label":"10","credits":10,"weight":1}]',
    '[{"credits":5,"weight":1},{"label":"10","credits":10,"weight":1}]',
  ])('invalid %s -> default wheel', json => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.SPIN_SEGMENTS_JSON = json;
    expect(economy.parseSpinSegments().map(s => s.label)).toEqual(['5', '10', '20', '5', '10', '20', '5', '10']);
    warn.mockRestore();
  });

  test('tiny weights still count after scaling', () => {
    const segs = [
      { credits: 5, weight: 0.004 },
      { credits: 10, weight: 0.004 },
    ];
    const seen = new Set(Array.from({ length: 200 }, () => pickWeighted(segs)));
    expect(seen).toEqual(new Set([0, 1]));
  });
});

test('spins table keeps every result for audit', async () => {
  const { user, token } = await createUser();
  await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`);
  const rows = await query('SELECT segment_index, credits, source FROM spins WHERE user_id = $1', [user.id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].source).toBe('free');
});
