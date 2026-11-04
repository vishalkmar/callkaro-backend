const { env } = require('../config/env');
const { queryOne } = require('../config/db');
const { startOfLocalDay } = require('../utils/time');

/**
 * Daily business dashboard: new users, calls, minutes, revenue, ad rewards, estimated provider cost, margin.
 * day = 'YYYY-MM-DD' (India time) or today.
 */
const dailyStats = async day => {
  const from = day ? startOfLocalDay(new Date(`${day}T12:00:00+05:30`)) : startOfLocalDay();
  const to = new Date(from.getTime() + 86400000);
  const r = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE created_at >= $1 AND created_at < $2)::int AS new_users,
       (SELECT COUNT(*) FROM calls WHERE started_at >= $1 AND started_at < $2)::int AS calls,
       (SELECT COALESCE(SUM(talk_seconds), 0) FROM calls WHERE started_at >= $1 AND started_at < $2 AND billed)::bigint AS talk_seconds,
       (SELECT COALESCE(SUM(credits), 0) FROM calls WHERE started_at >= $1 AND started_at < $2 AND billed)::bigint AS credits_charged,
       (SELECT COUNT(*) FROM orders WHERE paid_at >= $1 AND paid_at < $2 AND status = 'paid')::int AS orders,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM orders WHERE paid_at >= $1 AND paid_at < $2 AND status = 'paid')::bigint AS revenue_paise,
       (SELECT COUNT(*) FROM ad_rewards WHERE created_at >= $1 AND created_at < $2)::int AS ad_rewards,
       (SELECT COALESCE(SUM(credits), 0) FROM ad_rewards WHERE created_at >= $1 AND created_at < $2)::bigint AS ad_credits`,
    [from, to],
  );
  const talkSeconds = Number(r.talk_seconds);
  // Provider bills per started minute per call leg; this is an estimate for the guard/alert.
  const providerCostPaise = Math.ceil(talkSeconds / 60) * env.PROVIDER_COST_PAISE_PER_MIN;
  const revenuePaise = Number(r.revenue_paise);
  return {
    day: from.toISOString(),
    newUsers: r.new_users,
    calls: r.calls,
    talkMinutes: Math.round(talkSeconds / 60),
    creditsCharged: Number(r.credits_charged),
    orders: r.orders,
    revenueInr: revenuePaise / 100,
    adRewards: r.ad_rewards,
    adCreditsGiven: Number(r.ad_credits),
    estProviderCostInr: providerCostPaise / 100,
    estGrossMarginInr: (revenuePaise - providerCostPaise) / 100,
  };
};

module.exports = { dailyStats };
