const crypto = require('crypto');
const economy = require('../config/economy');
const { query, queryOne } = require('../config/db');
const walletService = require('./wallet.service');
const { errors } = require('../utils/response');
const { startOfLocalDay } = require('../utils/time');

const FREE_MS = () => economy.FREE_SPIN_INTERVAL_HOURS * 3600 * 1000;

/** Weighted pick using a CSPRNG. Weights may be decimals (scaled to integers). */
const pickWeighted = (segments, randomInt = crypto.randomInt) => {
  // x1e6 keeps small weights (e.g. 0.004) from rounding to 0; crypto.randomInt allows up to 2^48.
  const scaled = segments.map(s => Math.round(s.weight * 1e6));
  const total = scaled.reduce((a, b) => a + b, 0);
  let r = randomInt(0, total);
  for (let i = 0; i < scaled.length; i++) {
    if (r < scaled[i]) {
      return i;
    }
    r -= scaled[i];
  }
  return scaled.length - 1;
};

const publicSegments = () => economy.spinSegments.map(s => ({ label: s.label, credits: s.credits }));

const status = async userId => {
  const user = await queryOne('SELECT last_free_spin_at FROM users WHERE id = $1', [userId]);
  const now = Date.now();
  const last = user?.last_free_spin_at ? new Date(user.last_free_spin_at).getTime() : 0;
  const freeAvailable = !last || now - last >= FREE_MS();
  const counts = await queryOne(
    `SELECT COUNT(*)::int AS unlocked, COUNT(*) FILTER (WHERE spin_used = FALSE)::int AS unused
       FROM ad_rewards WHERE user_id = $1 AND purpose = 'extra_spin' AND created_at >= $2`,
    [userId, startOfLocalDay()],
  );
  return {
    freeAvailable,
    nextFreeAt: freeAvailable ? null : new Date(last + FREE_MS()).toISOString(),
    extraSpinsAvailable: counts.unused, // unlocked by ads, ready to use
    extraSpinsLeft: Math.max(0, economy.MAX_EXTRA_SPINS_PER_DAY - counts.unlocked), // can still be unlocked today
    maxExtraSpinsPerDay: economy.MAX_EXTRA_SPINS_PER_DAY,
    // Only prizes that can really be won count for "win up to".
    maxWin: Math.max(0, ...economy.spinSegments.filter(s => s.weight > 0).map(s => s.credits)),
    odds: economy.spinOdds(economy.spinSegments),
    segments: publicSegments(),
  };
};

/**
 * POST /spin/play - server decides everything:
 * availability (atomic claim) -> weighted CSPRNG pick -> spins row -> wallet credit (idempotent on spin id).
 */
const play = async userId => {
  let source = null;
  let adRewardId = null;
  const claimed = await queryOne(
    `UPDATE users SET last_free_spin_at = now()
      WHERE id = $1 AND (last_free_spin_at IS NULL OR last_free_spin_at <= now() - ($2 || ' milliseconds')::interval)
      RETURNING id`,
    [userId, String(FREE_MS())],
  );
  if (claimed) {
    source = 'free';
  } else {
    // SKIP LOCKED: two parallel taps cannot consume the same ad-unlocked spin.
    const unlocked = await queryOne(
      `UPDATE ad_rewards SET spin_used = TRUE
        WHERE id = (SELECT id FROM ad_rewards
                     WHERE user_id = $1 AND purpose = 'extra_spin' AND spin_used = FALSE AND created_at >= $2
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [userId, startOfLocalDay()],
    );
    if (unlocked) {
      source = 'ad';
      adRewardId = unlocked.id;
    }
  }
  if (!source) {
    throw errors.conflict('NO_SPINS', 'No spins available right now', await status(userId));
  }

  const segmentIndex = pickWeighted(economy.spinSegments);
  const credits = economy.spinSegments[segmentIndex].credits;
  const spin = await queryOne(
    'INSERT INTO spins (user_id, segment_index, credits, source, ad_reward_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [userId, segmentIndex, credits, source, adRewardId],
  );

  let balance;
  if (credits > 0) {
    const r = await walletService.applyChange(userId, credits, 'spin_reward', spin.id, { meta: { segmentIndex, source } });
    balance = r.balance;
  } else {
    balance = (await walletService.getWallet(userId)).credits;
  }
  return { spinId: spin.id, segmentIndex, credits, label: economy.spinSegments[segmentIndex].label, balance, source };
};

// Test helper to inspect the spins table.
const listSpins = userId => query('SELECT * FROM spins WHERE user_id = $1 ORDER BY created_at', [userId]);

module.exports = { pickWeighted, status, play, publicSegments, listSpins };
