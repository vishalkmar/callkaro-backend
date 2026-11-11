const economy = require('../config/economy');
const { query, queryOne } = require('../config/db');
const { startOfLocalDay } = require('../utils/time');
const { revokeAllForUser } = require('./token.service');
const logger = require('../utils/logger');

const ACTIVE = ['initiated', 'ringing', 'in-progress'];

const isNumberBlocked = async e164 =>
  queryOne('SELECT * FROM blocked_numbers WHERE e164 = $1 AND (until IS NULL OR until > now())', [e164]);

/** Pre-call checks that need only the user (used by /voice/token). Returns { ok, code, message }. */
const checkUserCanCall = async userId => {
  const r = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE status = ANY($2) AND started_at >= now() - interval '3 hours')::int AS active,
            COUNT(*) FILTER (WHERE started_at >= now() - interval '1 hour')::int AS last_hour
       FROM calls WHERE user_id = $1`,
    [userId, ACTIVE],
  );
  if (r.active >= 1) {
    return { ok: false, code: 'CALL_IN_PROGRESS', message: 'You already have a call in progress' };
  }
  if (r.last_hour >= economy.MAX_CALLS_PER_HOUR) {
    return { ok: false, code: 'HOURLY_CALL_LIMIT', message: 'Too many calls this hour. Please try later.' };
  }
  return { ok: true };
};

/** Full checks for a specific destination (used by /voice/outbound - authoritative). */
const checkCallAllowed = async (userId, to) => {
  const base = await checkUserCanCall(userId);
  if (!base.ok) {
    return base;
  }
  if (await isNumberBlocked(to)) {
    return { ok: false, code: 'NUMBER_BLOCKED', message: 'This number cannot be called from CallingKaro' };
  }
  const r = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE to_number = $2 AND started_at >= now() - interval '1 hour')::int AS same_hour,
            COUNT(DISTINCT to_number) FILTER (WHERE started_at >= $3)::int AS distinct_today,
            BOOL_OR(to_number = $2 AND started_at >= $3) AS called_today
       FROM calls WHERE user_id = $1`,
    [userId, to, startOfLocalDay()],
  );
  if (r.same_hour >= economy.MAX_CALLS_PER_NUMBER_PER_HOUR) {
    return { ok: false, code: 'NUMBER_RATE_LIMIT', message: 'Too many calls to this number. Try again later.' };
  }
  if (!r.called_today && r.distinct_today >= economy.MAX_DISTINCT_NUMBERS_PER_DAY) {
    return { ok: false, code: 'DAILY_NUMBERS_LIMIT', message: 'Daily limit of different numbers reached' };
  }
  return { ok: true };
};

/** Called after every new report: auto-block a user (pending review) or a number once the threshold is hit. */
const evaluateReports = async report => {
  const threshold = economy.REPORTS_TO_AUTOBLOCK;
  if (report.reason === 'opt_out' && report.target_number) {
    await query(
      `INSERT INTO blocked_numbers (e164, reason, until) VALUES ($1, 'opt_out', NULL)
       ON CONFLICT (e164) DO UPDATE SET reason = 'opt_out', until = NULL`,
      [report.target_number],
    );
    logger.info({ number: report.target_number.slice(0, 5) }, 'number opted out');
    return { optedOut: true };
  }
  // Auto-block switched off: the report stays open for the admin to review.
  if (!(threshold > 0)) {
    return {};
  }
  if (report.target_user_id) {
    const { n } = await queryOne(
      "SELECT COUNT(*)::int AS n FROM reports WHERE target_user_id = $1 AND status IN ('open', 'reviewing')",
      [report.target_user_id],
    );
    if (n >= threshold) {
      await query(
        "UPDATE users SET status = 'blocked', blocked_reason = 'Auto-blocked after reports - pending review', updated_at = now() WHERE id = $1 AND status = 'active'",
        [report.target_user_id],
      );
      await revokeAllForUser(report.target_user_id);
      logger.warn({ userId: report.target_user_id, count: n }, 'user auto-blocked after reports');
      return { userBlocked: true };
    }
  }
  if (report.target_number && !report.target_user_id) {
    const { n } = await queryOne(
      "SELECT COUNT(*)::int AS n FROM reports WHERE target_number = $1 AND reason <> 'opt_out' AND status IN ('open', 'reviewing')",
      [report.target_number],
    );
    if (n >= threshold) {
      await query(
        `INSERT INTO blocked_numbers (e164, reason, until) VALUES ($1, 'reports', now() + interval '30 days')
         ON CONFLICT (e164) DO UPDATE SET reason = 'reports', until = now() + interval '30 days'`,
        [report.target_number],
      );
      return { numberBlocked: true };
    }
  }
  return {};
};

module.exports = { checkUserCanCall, checkCallAllowed, isNumberBlocked, evaluateReports, ACTIVE };
