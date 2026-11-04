const { query, queryOne, tx } = require('../config/db');
const { errors } = require('../utils/response');
const { minutesForCredits } = require('./billing.service');
const logger = require('../utils/logger');

const EARN_TYPES = ['purchase', 'ad_reward', 'spin_reward', 'welcome_bonus', 'checkin_reward', 'referral_bonus'];
const SPEND_TYPES = ['call_charge'];
const MAX_SINGLE_CHANGE = 1e9;

const ensureWallet = async (userId, client) => {
  const run = client ? (s, p) => client.q(s, p) : query;
  await run('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const [w] = await run('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  return w;
};

/**
 * THE ONLY function that changes credits.
 *  - runs in one Postgres transaction: wallet row is locked (FOR UPDATE), updated, ledger row inserted
 *  - debits never take the balance below 0 (CHECK constraint + explicit test)
 *  - idempotent on (type, ref_id): replaying the same payment / ad / call returns the first result
 *
 * options.partial: for reversals - debit as much as is available (balance stops at 0) and report the shortfall.
 * Returns { balance, entry, duplicate, applied, shortfall }.
 */
const applyChange = async (userId, amount, type, refId, { meta, partial = false } = {}) => {
  // 1e9 credits = 1,000,000 minutes: far above any real change, far below Number.MAX_SAFE_INTEGER.
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_SINGLE_CHANGE) {
    throw errors.badRequest('BAD_AMOUNT', 'Amount must be a non-zero integer within limits');
  }
  if (!refId) {
    throw errors.badRequest('NO_REF', 'refId is required');
  }
  const ref = String(refId);
  const result = await tx(async c => {
    await c.q('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    // Lock the wallet first: concurrent requests for the same user queue here.
    const [wallet] = await c.q('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
    const [existing] = await c.q('SELECT * FROM ledger_entries WHERE type = $1 AND ref_id = $2', [type, ref]);
    if (existing) {
      return { balance: Number(wallet.credits), entry: existing, duplicate: true, applied: Number(existing.amount), shortfall: 0 };
    }
    let applied = amount;
    let shortfall = 0;
    if (amount < 0) {
      const available = Number(wallet.credits);
      if (-amount > available) {
        if (!partial) {
          throw errors.payment('INSUFFICIENT_CREDITS', 'Not enough credits');
        }
        applied = -available;
        shortfall = -amount - available;
      }
    }
    const earned = applied > 0 && EARN_TYPES.includes(type) ? applied : 0;
    const spent = applied < 0 && SPEND_TYPES.includes(type) ? -applied : 0;
    const [updated] = await c.q(
      `UPDATE wallets SET credits = credits + $2, lifetime_earned = lifetime_earned + $3,
         lifetime_spent = lifetime_spent + $4, updated_at = now()
       WHERE user_id = $1 RETURNING credits`,
      [userId, applied, earned, spent],
    );
    const entryMeta = { ...(meta || {}), ...(shortfall ? { requested: amount, shortfall } : {}) };
    const [entry] = await c.q(
      `INSERT INTO ledger_entries (user_id, type, amount, balance_after, ref_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, type, applied, updated.credits, ref, entryMeta],
    );
    if (shortfall > 0) {
      await c.q('UPDATE users SET negative_usage = TRUE, updated_at = now() WHERE id = $1', [userId]);
    }
    return { balance: Number(updated.credits), entry, duplicate: false, applied, shortfall };
  });

  if (!result.duplicate) {
    logger.info({ userId, type, refId: ref, amount: result.applied, balance: result.balance }, 'wallet change');
    if (result.shortfall > 0) {
      logger.warn({ userId, refId: ref, shortfall: result.shortfall }, 'reversal exceeded balance - user flagged');
    }
  }
  return result;
};

const getWallet = async userId => {
  const w = await ensureWallet(userId);
  return { ...w, credits: Number(w.credits) };
};

const serializeEntry = e => ({
  id: String(e.id),
  type: e.type,
  amount: Number(e.amount),
  balanceAfter: Number(e.balance_after),
  refId: e.ref_id,
  meta: e.meta || {},
  createdAt: e.created_at,
});

const walletSummary = async userId => {
  const w = await ensureWallet(userId);
  const last = await query('SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5', [userId]);
  return {
    credits: Number(w.credits),
    minutes: minutesForCredits(w.credits),
    lifetimeEarned: Number(w.lifetime_earned),
    lifetimeSpent: Number(w.lifetime_spent),
    lastEntries: last.map(serializeEntry),
  };
};

const ledgerPage = async (userId, page = 1, limit = 30) => {
  const offset = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    query('SELECT * FROM ledger_entries WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [userId, limit, offset]),
    queryOne('SELECT COUNT(*)::int AS n FROM ledger_entries WHERE user_id = $1', [userId]),
  ]);
  return { items: items.map(serializeEntry), page, total: total.n, hasMore: offset + items.length < total.n };
};

/** Reconciliation: sum(ledger.amount) must equal wallet.credits for every user. Returns mismatches. */
const reconcileAll = async () => {
  const rows = await query(
    `SELECT w.user_id, w.credits, COALESCE(SUM(l.amount), 0)::bigint AS ledger
       FROM wallets w LEFT JOIN ledger_entries l ON l.user_id = w.user_id
      GROUP BY w.user_id, w.credits
     HAVING w.credits <> COALESCE(SUM(l.amount), 0)`,
  );
  return rows.map(r => ({ userId: r.user_id, wallet: Number(r.credits), ledger: Number(r.ledger), diff: Number(r.credits) - Number(r.ledger) }));
};

module.exports = { applyChange, ensureWallet, getWallet, walletSummary, ledgerPage, reconcileAll, serializeEntry };
