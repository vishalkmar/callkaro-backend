const crypto = require('crypto');
const economy = require('../config/economy');
const { query, queryOne } = require('../config/db');
const walletService = require('./wallet.service');
const { errors } = require('../utils/response');
const { startOfLocalDay } = require('../utils/time');
const { UUID_RE } = require('../middlewares/auth');
const { env } = require('../config/env');
const logger = require('../utils/logger');

const adStatus = async userId => {
  const row = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE purpose = 'credits' AND created_at >= $2)::int AS today,
            MAX(created_at) AS last
       FROM ad_rewards WHERE user_id = $1`,
    [userId, startOfLocalDay()],
  );
  const gapMs = economy.MIN_SECONDS_BETWEEN_AD_REWARDS * 1000;
  const nextAt = row.last ? new Date(new Date(row.last).getTime() + gapMs) : null;
  return {
    todayCount: row.today,
    max: economy.MAX_AD_REWARDS_PER_DAY,
    rewardCredits: economy.AD_REWARD_CREDITS,
    remaining: Math.max(0, economy.MAX_AD_REWARDS_PER_DAY - row.today),
    nextAvailableAt: nextAt && nextAt > new Date() ? nextAt.toISOString() : null,
  };
};

/** POST /ads/session - issues a nonce that AdMob returns in SSV custom_data ("<userId>:<nonce>"). */
const createSession = async (userId, purpose = 'credits', refId = null) => {
  const user = await queryOne('SELECT rewards_disabled FROM users WHERE id = $1', [userId]);
  if (user?.rewards_disabled) {
    throw errors.forbidden('REWARDS_DISABLED', 'Free rewards are not available on this device');
  }
  const st = await adStatus(userId);
  if (purpose === 'credits' && st.remaining <= 0) {
    throw errors.tooMany('AD_DAILY_CAP', `You reached today's limit of ${st.max} rewarded ads`, st);
  }
  if (purpose === 'extra_spin') {
    const { n } = await queryOne(
      "SELECT COUNT(*)::int AS n FROM ad_rewards WHERE user_id = $1 AND purpose = 'extra_spin' AND created_at >= $2",
      [userId, startOfLocalDay()],
    );
    if (n >= economy.MAX_EXTRA_SPINS_PER_DAY) {
      throw errors.tooMany('SPIN_DAILY_CAP', 'No more extra spins today');
    }
  }
  if (purpose === 'spin_claim') {
    const spin = await queryOne(
      `SELECT 1 FROM spins WHERE id = $1 AND user_id = $2 AND claimed = FALSE
          AND created_at > now() - ($3 || ' hours')::interval`,
      [refId, userId, String(economy.SPIN_CLAIM_HOURS)],
    );
    if (!spin) {
      throw errors.conflict('SPIN_NOT_CLAIMABLE', 'This prize was already collected or has expired');
    }
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  await query(
    "INSERT INTO ad_sessions (user_id, nonce, purpose, ref_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes')",
    [userId, nonce, purpose, purpose === 'spin_claim' ? refId : null],
  );
  return { nonce, customData: `${userId}:${nonce}`, ...st };
};

/** Applies a VERIFIED SSV callback. Always idempotent on transaction_id. Returns { rewarded, reason, balance? }. */
const applySsvReward = async params => {
  const transactionId = params.transaction_id;
  const [userId, nonce] = String(params.custom_data || '').split(':');
  if (!transactionId || !userId || !nonce || !UUID_RE.test(userId)) {
    return { rewarded: false, reason: 'missing_custom_data' }; // e.g. AdMob console "verify URL" ping
  }
  // Only OUR rewarded unit(s) may pay out (another AdMob app could point its SSV URL at us).
  if (env.ADMOB_REWARDED_AD_UNITS.length && !env.ADMOB_REWARDED_AD_UNITS.includes(String(params.ad_unit || ''))) {
    return { rewarded: false, reason: 'foreign_ad_unit' };
  }
  if (await queryOne('SELECT 1 FROM ad_rewards WHERE transaction_id = $1', [transactionId])) {
    return { rewarded: false, reason: 'duplicate' };
  }
  const session = await queryOne(
    `UPDATE ad_sessions SET used_at = now()
      WHERE nonce = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`,
    [nonce, userId],
  );
  if (!session) {
    return { rewarded: false, reason: 'unknown_or_used_nonce' };
  }
  const user = await queryOne('SELECT status, rewards_disabled FROM users WHERE id = $1', [userId]);
  if (!user || user.status !== 'active' || user.rewards_disabled) {
    return { rewarded: false, reason: 'user_not_eligible' };
  }

  // A won spin: the watched ad pays out exactly that spin's prize (no daily ad cap / gap - spins are limited).
  if (session.purpose === 'spin_claim') {
    const inserted = await queryOne(
      `INSERT INTO ad_rewards (user_id, transaction_id, nonce, purpose, credits, ad_unit) VALUES ($1, $2, $3, 'spin_claim', 0, $4)
       ON CONFLICT (transaction_id) DO NOTHING RETURNING id`,
      [userId, transactionId, nonce, params.ad_unit || null],
    );
    if (!inserted) {
      return { rewarded: false, reason: 'duplicate' };
    }
    // eslint-disable-next-line global-require
    const r = await require('./spin.service').creditSpin(userId, session.ref_id);
    if (!r) {
      return { rewarded: false, reason: 'spin_not_claimable' };
    }
    await query('UPDATE ad_rewards SET credits = $2 WHERE id = $1', [inserted.id, r.credits]);
    logger.info({ userId, credits: r.credits }, 'spin prize credited after ad');
    return { rewarded: true, balance: r.balance, purpose: session.purpose };
  }

  // Cap + minimum gap (server-enforced; the app's counter is display only).
  const st = await adStatus(userId);
  if (session.purpose === 'credits' && st.remaining <= 0) {
    return { rewarded: false, reason: 'daily_cap' };
  }
  if (st.nextAvailableAt) {
    return { rewarded: false, reason: 'too_soon' };
  }

  const credits = session.purpose === 'credits' ? economy.AD_REWARD_CREDITS : 0; // never from the request
  const inserted = await queryOne(
    `INSERT INTO ad_rewards (user_id, transaction_id, nonce, purpose, credits, ad_unit) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (transaction_id) DO NOTHING RETURNING id`,
    [userId, transactionId, nonce, session.purpose, credits, params.ad_unit || null],
  );
  if (!inserted) {
    return { rewarded: false, reason: 'duplicate' };
  }
  if (credits > 0) {
    const r = await walletService.applyChange(userId, credits, 'ad_reward', transactionId, { meta: { adUnit: params.ad_unit } });
    logger.info({ userId, credits }, 'ad reward credited');
    return { rewarded: true, balance: r.balance, purpose: session.purpose };
  }
  return { rewarded: true, purpose: session.purpose };
};

module.exports = { adStatus, createSession, applySsvReward };
