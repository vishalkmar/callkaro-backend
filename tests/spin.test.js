const request = require('supertest');
const app = require('../src/app');
const economy = require('../src/config/economy');
const { pickWeighted } = require('../src/services/spin.service');
const { startDb, stopDb, clearDb, createUser, query } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterEach(clearDb);

describe('spin weighted picker', () => {
  test('distribution over 10,000 runs follows the weights', () => {
    const runs = 10000;
    const counts = new Array(economy.spinSegments.length).fill(0);
    for (let i = 0; i < runs; i++) {
      counts[pickWeighted(economy.spinSegments)] += 1;
    }
    const totalWeight = economy.spinSegments.reduce((a, s) => a + s.weight, 0);
    economy.spinSegments.forEach((s, i) => {
      const expected = (s.weight / totalWeight) * runs;
      // within 4 standard deviations of a binomial
      const p = s.weight / totalWeight;
      const sd = Math.sqrt(runs * p * (1 - p));
      expect(Math.abs(counts[i] - expected)).toBeLessThanOrEqual(4 * sd + 1);
    });
  });

  test('deterministic boundaries', () => {
    const segs = [{ weight: 1 }, { weight: 3 }];
    expect(pickWeighted(segs, () => 0)).toBe(0);
    expect(pickWeighted(segs, () => 999999)).toBe(0);
    expect(pickWeighted(segs, () => 1000000)).toBe(1);
    expect(pickWeighted(segs, () => 3999999)).toBe(1);
  });
});

describe('spin API', () => {
  test('1 free spin per 24h, credited by the server', async () => {
    const { user, token } = await createUser();
    const st = await request(app).get('/spin/status').set('Authorization', `Bearer ${token}`);
    expect(st.body.data.freeAvailable).toBe(true);
    expect(st.body.data.segments).toHaveLength(8);

    const play = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`).send({ credits: 999999 });
    expect(play.status).toBe(200);
    const { segmentIndex, credits, balance } = play.body.data;
    expect(credits).toBe(economy.spinSegments[segmentIndex].credits); // client-sent amount ignored
    expect(balance).toBe(credits);

    const again = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('NO_SPINS');

    // after 24h the free spin is back
    await query("UPDATE users SET last_free_spin_at = now() - interval '25 hours' WHERE id = $1", [user.id]);
    const third = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`);
    expect(third.status).toBe(200);
  });

  test('extra spin unlocked by an ad is used once', async () => {
    const { user, token } = await createUser();
    await query('UPDATE users SET last_free_spin_at = now() WHERE id = $1', [user.id]);
    await query("INSERT INTO ad_rewards (user_id, transaction_id, purpose) VALUES ($1, 't1', 'extra_spin')", [user.id]);
    const st = await request(app).get('/spin/status').set('Authorization', `Bearer ${token}`);
    expect(st.body.data.extraSpinsAvailable).toBe(1);
    const p1 = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`);
    expect(p1.body.data.source).toBe('ad');
    const p2 = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`);
    expect(p2.body.code).toBe('NO_SPINS');
  });

  test('rewards disabled on emulators', async () => {
    const { token } = await createUser();
    const r = await request(app).post('/spin/play').set('Authorization', `Bearer ${token}`).set('X-Device-Integrity', 'emulator=1;rooted=0');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('REWARDS_DISABLED');
  });
});
