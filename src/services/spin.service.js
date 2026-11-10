const crypto = require('crypto');
const economy = require('../config/economy');
const { query, queryOne } = require('../config/db');
const walletService = require('./wallet.service');
const { env } = require('../config/env');
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

/**
 * How a won spin is collected: 'ssv' = only Google's server-to-server callback for a watched rewarded ad can
 * credit it (real ad units configured); 'app' = test ads (Google sends no SSV for them) - the app reports it.
 */
const claimVia = () => (env.ADMOB_REWARDED_AD_UNITS.length ? 'ssv' : 'app');

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
  const pending = await queryOne(
    `SELECT id, segment_index, credits FROM spins
      WHERE user_id = $1 AND claimed = FALSE AND created_at > now() - ($2 || ' hours')::interval
      ORDER BY created_at DESC LIMIT 1`,
    [userId, String(economy.SPIN_CLAIM_HOURS)],
  );
  return {
    // A prize won but not collected yet (the ad was skipped / not available): collect it with an ad.
    pendingClaim: pending
      ? { spinId: pending.id, segmentIndex: pending.segment_index, credits: pending.credits, claimVia: claimVia() }
      : null,
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
  const needsAd = economy.SPIN_NEEDS_AD && credits > 0;
  const spin = await queryOne(
    `INSERT INTO spins (user_id, segment_index, credits, source, ad_reward_id, claimed, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN now() END) RETURNING id`,
    [userId, segmentIndex, credits, source, adRewardId, !needsAd],
  );
  if (needsAd) {
    // The prize is decided now; its credits come after the rewarded ad (SSV callback or POST /spin/claim).
    const current = (await walletService.getWallet(userId)).credits;
    return {
      spinId: spin.id,
      segmentIndex,
      credits,
      label: economy.spinSegments[segmentIndex].label,
      balance: current,
      source,
      claimRequired: true,
      claimVia: claimVia(),
    };
  }

  let balance;
  if (credits > 0) {
    const r = await walletService.applyChange(userId, credits, 'spin_reward', spin.id, { meta: { segmentIndex, source } });
    balance = r.balance;
  } else {
    balance = (await walletService.getWallet(userId)).credits;
  }
  return { spinId: spin.id, segmentIndex, credits, label: economy.spinSegments[segmentIndex].label, balance, source };
};

/**
 * Adds a won spin's credits exactly once. Called by the verified SSV callback ('ssv' mode) or by
 * POST /spin/claim after the app showed a test ad ('app' mode - refused once real ad units are configured).
 */
const creditSpin = async (userId, spinId) => {
  const spin = await queryOne(
    `UPDATE spins SET claimed = TRUE, claimed_at = now()
      WHERE id = $1 AND user_id = $2 AND claimed = FALSE AND created_at > now() - ($3 || ' hours')::interval
      RETURNING id, credits`,
    [spinId, userId, String(economy.SPIN_CLAIM_HOURS)],
  );
  if (!spin) {
    return null; // already collected, expired or not this user's
  }
  try {
    const r = await walletService.applyChange(userId, spin.credits, 'spin_reward', spin.id, { meta: { afterAd: true } });
    return { credits: spin.credits, balance: r.balance };
  } catch (e) {
    await query('UPDATE spins SET claimed = FALSE, claimed_at = NULL WHERE id = $1', [spin.id]); // can be retried
    throw e;
  }
};

const claimFromApp = async (userId, spinId) => {
  if (claimVia() === 'ssv') {
    throw errors.forbidden('AD_REQUIRED', 'Watch the ad to collect your credits');
  }
  const r = await creditSpin(userId, spinId);
  if (!r) {
    throw errors.conflict('SPIN_NOT_CLAIMABLE', 'This prize was already collected or has expired');
  }
  return r;
};

// Test helper to inspect the spins table.
const listSpins = userId => query('SELECT * FROM spins WHERE user_id = $1 ORDER BY created_at', [userId]);

module.exports = { pickWeighted, status, play, publicSegments, listSpins, creditSpin, claimFromApp, claimVia };
