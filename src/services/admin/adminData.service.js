// Read models for the admin panel: dashboard stats, users, one user's full story, wallet transactions.
// Every filter value is a bound SQL parameter (never string-built SQL). Dates are Indian calendar days.
const crypto = require('crypto');
const { env } = require('../../config/env');
const { query, queryOne } = require('../../config/db');
const { errors } = require('../../utils/response');
const walletService = require('../wallet.service');
const { revokeAllForUser } = require('../token.service');

const TZ = 'Asia/Kolkata';
const LEDGER_TYPES = [
  'purchase',
  'ad_reward',
  'spin_reward',
  'welcome_bonus',
  'checkin_reward',
  'referral_bonus',
  'call_charge',
  'refund',
  'payment_reversal',
  'admin_adjust',
];

const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

/** from/to inclusive Indian days -> [startTs, endTs) bound params; default last 30 days, max 366 days. */
const range = ({ from, to } = {}) => {
  const end = isDay(to) ? to : today();
  let start = isDay(from) ? from : null;
  if (!start) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 29);
    start = d.toISOString().slice(0, 10);
  }
  if (start > end) {
    throw errors.badRequest('BAD_RANGE', '"From" must be before "To"');
  }
  const days = Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366) {
    throw errors.badRequest('BAD_RANGE', 'Pick at most one year');
  }
  return { from: start, to: end, days };
};
// SQL fragment helpers (the column name is ours, never user input)
const inRange = col => `${col} >= ($1::date AT TIME ZONE '${TZ}') AND ${col} < (($2::date + 1) AT TIME ZONE '${TZ}')`;

const page = ({ page: p, limit } = {}) => {
  const size = Math.min(100, Math.max(5, Number(limit) || 25));
  const n = Math.max(1, Number(p) || 1);
  return { limit: size, offset: (n - 1) * size, page: n };
};

// ---------------- dashboard ----------------

const dashboard = async params => {
  const r = range(params);
  const args = [r.from, r.to];
  const k = await queryOne(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE status <> 'deleted')::int AS users_total,
       (SELECT COUNT(*) FROM users WHERE ${inRange('created_at')})::int AS users_new,
       (SELECT COUNT(*) FROM users WHERE ${inRange('last_login_at')})::int AS users_active,
       (SELECT COUNT(*) FROM users WHERE status = 'blocked')::int AS users_blocked,
       (SELECT COUNT(*) FROM calls WHERE ${inRange('started_at')})::int AS calls,
       (SELECT COUNT(*) FROM calls WHERE ${inRange('started_at')} AND talk_seconds > 0)::int AS calls_answered,
       (SELECT COALESCE(SUM(talk_seconds), 0) FROM calls WHERE ${inRange('started_at')} AND billed)::bigint AS talk_seconds,
       (SELECT COALESCE(SUM(credits), 0) FROM calls WHERE ${inRange('started_at')} AND billed)::bigint AS credits_charged,
       (SELECT COUNT(*) FROM orders WHERE ${inRange('paid_at')} AND status = 'paid')::int AS orders,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM orders WHERE ${inRange('paid_at')} AND status = 'paid')::bigint AS revenue_paise,
       (SELECT COUNT(*) FROM ad_rewards WHERE ${inRange('created_at')} AND purpose = 'credits')::int AS videos,
       (SELECT COUNT(*) FROM spins WHERE ${inRange('created_at')})::int AS spins,
       (SELECT COALESCE(SUM(credits), 0) FROM wallets)::bigint AS credits_outstanding,
       (SELECT COUNT(*) FROM reports WHERE status = 'open')::int AS reports_open`,
    args,
  );
  const given = await query(
    `SELECT type, COALESCE(SUM(amount), 0)::bigint AS credits, COUNT(*)::int AS n
       FROM ledger_entries WHERE ${inRange('created_at')} GROUP BY type ORDER BY type`,
    args,
  );
  const series = await query(
    `WITH days AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d)
     SELECT to_char(d, 'YYYY-MM-DD') AS day,
       (SELECT COUNT(*) FROM users u WHERE (u.created_at AT TIME ZONE '${TZ}')::date = d)::int AS new_users,
       (SELECT COUNT(*) FROM calls c WHERE (c.started_at AT TIME ZONE '${TZ}')::date = d)::int AS calls,
       (SELECT COALESCE(SUM(talk_seconds), 0) FROM calls c WHERE (c.started_at AT TIME ZONE '${TZ}')::date = d AND c.billed)::int AS talk_seconds,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM orders o WHERE (o.paid_at AT TIME ZONE '${TZ}')::date = d AND o.status = 'paid')::bigint AS revenue_paise,
       (SELECT COUNT(*) FROM ad_rewards a WHERE (a.created_at AT TIME ZONE '${TZ}')::date = d AND a.purpose = 'credits')::int AS videos,
       (SELECT COUNT(*) FROM spins s WHERE (s.created_at AT TIME ZONE '${TZ}')::date = d)::int AS spins
     FROM days ORDER BY d`,
    args,
  );
  const topCallers = await query(
    `SELECT u.id, u.email, COUNT(*)::int AS calls, COALESCE(SUM(c.talk_seconds), 0)::int AS talk_seconds
       FROM calls c JOIN users u ON u.id = c.user_id
      WHERE ${inRange('c.started_at')} GROUP BY u.id, u.email ORDER BY calls DESC LIMIT 8`,
    args,
  );
  const recentUsers = await query(
    `SELECT u.id, u.email, u.name, u.status, u.created_at, w.credits FROM users u LEFT JOIN wallets w ON w.user_id = u.id
      ORDER BY u.created_at DESC LIMIT 8`,
  );
  const talkSeconds = Number(k.talk_seconds);
  const revenuePaise = Number(k.revenue_paise);
  const costPaise = Math.ceil(talkSeconds / 60) * env.PROVIDER_COST_PAISE_PER_MIN;
  return {
    range: r,
    kpis: {
      usersTotal: k.users_total,
      usersNew: k.users_new,
      usersActive: k.users_active,
      usersBlocked: k.users_blocked,
      calls: k.calls,
      callsAnswered: k.calls_answered,
      talkMinutes: Math.round(talkSeconds / 60),
      creditsCharged: Number(k.credits_charged),
      orders: k.orders,
      revenueInr: revenuePaise / 100,
      estProviderCostInr: costPaise / 100,
      estMarginInr: (revenuePaise - costPaise) / 100,
      videos: k.videos,
      spins: k.spins,
      creditsOutstanding: Number(k.credits_outstanding),
      reportsOpen: k.reports_open,
    },
    creditsByType: given.map(g => ({ type: g.type, credits: Number(g.credits), count: g.n })),
    series: series.map(s => ({
      day: s.day,
      newUsers: s.new_users,
      calls: s.calls,
      talkMinutes: Math.round(s.talk_seconds / 60),
      revenueInr: Number(s.revenue_paise) / 100,
      videos: s.videos,
      spins: s.spins,
    })),
    topCallers: topCallers.map(t => ({ ...t, talkMinutes: Math.round(t.talk_seconds / 60) })),
    recentUsers: recentUsers.map(u => ({ ...u, credits: Number(u.credits || 0) })),
  };
};

// ---------------- users ----------------

const listUsers = async ({ search, status, ...rest } = {}) => {
  const p = page(rest);
  const s = String(search || '').trim().slice(0, 100);
  const st = ['active', 'blocked', 'deleted'].includes(status) ? status : null;
  const where = `($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.name ILIKE '%' || $1 || '%' OR u.referral_code ILIKE $1 OR u.id::text = $1)
                 AND ($2::text IS NULL OR u.status = $2)`;
  const rows = await query(
    `SELECT u.id, u.email, u.name, u.status, u.created_at, u.last_login_at, u.referral_code,
            cardinality(u.device_ids) AS devices, COALESCE(w.credits, 0) AS credits,
            (SELECT COUNT(*) FROM calls c WHERE c.user_id = u.id)::int AS calls
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
      WHERE ${where} ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`,
    [s, st, p.limit, p.offset],
  );
  const { n } = await queryOne(`SELECT COUNT(*)::int AS n FROM users u WHERE ${where}`, [s, st]);
  return { users: rows.map(u => ({ ...u, credits: Number(u.credits) })), total: n, page: p.page, limit: p.limit };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const userDetail = async id => {
  if (!UUID_RE.test(String(id))) {
    throw errors.notFound('USER_NOT_FOUND', 'User not found');
  }
  const u = await queryOne(
    `SELECT u.id, u.email, u.name, u.status, u.blocked_reason, u.terms_version, u.device_id, u.device_ids, u.last_login_at,
            u.referral_code, u.referral_rewarded, u.rewards_disabled, u.negative_usage, u.last_free_spin_at,
            u.deleted_at, u.created_at, u.updated_at,
            r.email AS referred_by_email, r.id AS referred_by_id,
            w.credits, w.lifetime_earned, w.lifetime_spent
       FROM users u LEFT JOIN users r ON r.id = u.referred_by LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.id = $1`,
    [id],
  );
  if (!u) {
    throw errors.notFound('USER_NOT_FOUND', 'User not found');
  }
  const [ledger, calls, orders, spins, sessions, referrals, reportsAgainst, reportsBy, counts] = await Promise.all([
    query('SELECT id, type, amount, balance_after, ref_id, meta, created_at FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [id]),
    query(
      `SELECT id, call_sid, to_number, caller_id, status, provider, started_at, answered_at, ended_at, talk_seconds, credits, end_reason
         FROM calls WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [id],
    ),
    query('SELECT id, package_id, amount_paise, credits, provider, status, paid_at, created_at, receipt_no FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    query('SELECT id, credits, source, claimed, created_at FROM spins WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [id]),
    query(
      `SELECT id, device_id, user_agent, created_at, last_used_at, expires_at, revoked_at FROM sessions
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [id],
    ),
    query('SELECT id, email, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    query('SELECT id, reason, details, status, created_at FROM reports WHERE target_user_id = $1 ORDER BY created_at DESC LIMIT 30', [id]),
    query('SELECT id, reason, target_number, status, created_at FROM reports WHERE reporter_user_id = $1 ORDER BY created_at DESC LIMIT 30', [id]),
    queryOne(
      `SELECT (SELECT COUNT(*) FROM calls WHERE user_id = $1)::int AS calls,
              (SELECT COALESCE(SUM(talk_seconds), 0) FROM calls WHERE user_id = $1)::int AS talk_seconds,
              (SELECT COUNT(*) FROM ad_rewards WHERE user_id = $1 AND purpose = 'credits')::int AS videos,
              (SELECT COUNT(*) FROM spins WHERE user_id = $1)::int AS spins,
              (SELECT COALESCE(SUM(amount_paise), 0) FROM orders WHERE user_id = $1 AND status = 'paid')::bigint AS paid_paise`,
      [id],
    ),
  ]);
  const welcome = ledger.find(l => l.type === 'welcome_bonus');
  return {
    user: { ...u, credits: Number(u.credits || 0), lifetime_earned: Number(u.lifetime_earned || 0), lifetime_spent: Number(u.lifetime_spent || 0) },
    // "How was this account made": always email OTP sign-up; first device, referral, welcome bonus, terms.
    signup: {
      method: 'Email one-time code',
      at: u.created_at,
      firstDevice: (u.device_ids || [])[0] || u.device_id || null,
      referredBy: u.referred_by_email || null,
      welcomeBonus: welcome ? Number(welcome.amount) : 0,
      termsVersion: u.terms_version,
    },
    totals: {
      calls: counts.calls,
      talkMinutes: Math.round(counts.talk_seconds / 60),
      videos: counts.videos,
      spins: counts.spins,
      paidInr: Number(counts.paid_paise) / 100,
      referrals: referrals.length,
    },
    ledger: ledger.map(l => ({ ...l, amount: Number(l.amount), balance_after: Number(l.balance_after) })),
    calls,
    orders,
    spins,
    sessions,
    referrals,
    reportsAgainst,
    reportsBy,
  };
};

const setBlocked = async (id, blocked, reason) => {
  const u = await queryOne(
    `UPDATE users SET status = $2, blocked_reason = $3, updated_at = now()
      WHERE id = $1 AND status <> 'deleted' RETURNING id, status`,
    [id, blocked ? 'blocked' : 'active', blocked ? String(reason || 'Blocked by admin').slice(0, 300) : null],
  );
  if (!u) {
    throw errors.notFound('USER_NOT_FOUND', 'User not found');
  }
  if (blocked) {
    await revokeAllForUser(id); // signed out on every phone
  }
  return u;
};

const adjustCredits = async (id, amount, reason, adminUsername) => {
  const n = Math.trunc(Number(amount));
  if (!n || Math.abs(n) > 10000000) {
    throw errors.badRequest('BAD_AMOUNT', 'Enter a non-zero amount (max 1,00,00,000)');
  }
  if (!(await queryOne('SELECT 1 FROM users WHERE id = $1', [id]))) {
    throw errors.notFound('USER_NOT_FOUND', 'User not found');
  }
  const ref = `panel:${crypto.randomUUID()}`;
  const r = await walletService.applyChange(id, n, 'admin_adjust', ref, {
    partial: n < 0, // a deduction never takes the balance below 0
    meta: { reason: String(reason || '').slice(0, 300), by: adminUsername, via: 'admin_panel' },
  });
  return { balance: r.balance, ref };
};

// ---------------- transactions ----------------

const transactions = async ({ type, search, ...rest } = {}) => {
  const r = range(rest);
  const p = page(rest);
  const t = LEDGER_TYPES.includes(type) ? type : null;
  const s = String(search || '').trim().slice(0, 100);
  const where = `${inRange('l.created_at')} AND ($3::text IS NULL OR l.type = $3) AND ($4 = '' OR u.email ILIKE '%' || $4 || '%' OR l.ref_id = $4)`;
  const args = [r.from, r.to, t, s];
  const rows = await query(
    `SELECT l.id, l.type, l.amount, l.balance_after, l.ref_id, l.meta, l.created_at, u.id AS user_id, u.email
       FROM ledger_entries l JOIN users u ON u.id = l.user_id
      WHERE ${where} ORDER BY l.created_at DESC LIMIT $5 OFFSET $6`,
    [...args, p.limit, p.offset],
  );
  const sums = await queryOne(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(l.amount) FILTER (WHERE l.amount > 0), 0)::bigint AS credited,
            COALESCE(SUM(l.amount) FILTER (WHERE l.amount < 0), 0)::bigint AS debited
       FROM ledger_entries l JOIN users u ON u.id = l.user_id WHERE ${where}`,
    args,
  );
  return {
    range: r,
    types: LEDGER_TYPES,
    total: sums.n,
    credited: Number(sums.credited),
    debited: Number(sums.debited),
    page: p.page,
    limit: p.limit,
    rows: rows.map(x => ({ ...x, amount: Number(x.amount), balance_after: Number(x.balance_after) })),
  };
};

module.exports = { dashboard, listUsers, userDetail, setBlocked, adjustCredits, transactions, range, LEDGER_TYPES };
