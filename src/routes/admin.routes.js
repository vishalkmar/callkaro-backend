const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAdmin } = require('../middlewares/adminAuth');
const { UUID_RE } = require('../middlewares/auth');
const walletService = require('../services/wallet.service');
const { revokeAllForUser } = require('../services/token.service');
const { query, queryOne } = require('../config/db');
const { ok, errors } = require('../utils/response');
const { toE164India } = require('../utils/phone');
const { dailyStats } = require('../services/stats.service');

router.use(requireAdmin);

const findUser = async id => (UUID_RE.test(id) ? queryOne('SELECT id FROM users WHERE id = $1', [id]) : null);

// Manual refund / adjustment for support. refId makes it idempotent (e.g. the support ticket id).
router.post(
  '/wallet/adjust',
  validate({
    body: Joi.object({
      userId: Joi.string().required(),
      amount: Joi.number().integer().invalid(0).min(-1e9).max(1e9).required(),
      reason: Joi.string().max(200).required(),
      refId: Joi.string().max(100).required(),
      type: Joi.string().valid('admin_adjust', 'refund').default('admin_adjust'),
    }),
  }),
  async (req, res) => {
    const { userId, amount, reason, refId, type } = req.body;
    if (!(await findUser(userId))) {
      throw errors.notFound('USER_NOT_FOUND', 'User not found');
    }
    const r = await walletService.applyChange(userId, amount, type, `admin:${refId}`, { meta: { reason } });
    return ok(res, { balance: r.balance, duplicate: r.duplicate });
  },
);

router.post(
  '/users/:id/block',
  validate({ body: Joi.object({ reason: Joi.string().max(200).required(), unblock: Joi.boolean().default(false) }) }),
  async (req, res) => {
    if (!(await findUser(req.params.id))) {
      throw errors.notFound();
    }
    const status = req.body.unblock ? 'active' : 'blocked';
    await query('UPDATE users SET status = $2, blocked_reason = $3, updated_at = now() WHERE id = $1', [
      req.params.id,
      status,
      req.body.reason,
    ]);
    if (status === 'blocked') {
      await revokeAllForUser(req.params.id);
    }
    return ok(res, { id: req.params.id, status });
  },
);

router.post(
  '/numbers/block',
  validate({
    body: Joi.object({
      number: Joi.string().required(),
      reason: Joi.string().valid('opt_out', 'reports', 'admin', 'harassment').default('admin'),
      days: Joi.number().integer().min(0).default(0),
    }),
  }),
  async (req, res) => {
    const e164 = toE164India(req.body.number);
    if (!e164) {
      throw errors.badRequest('BAD_NUMBER', 'Invalid number');
    }
    const until = req.body.days ? new Date(Date.now() + req.body.days * 86400000) : null;
    await query(
      `INSERT INTO blocked_numbers (e164, reason, until) VALUES ($1, $2, $3)
       ON CONFLICT (e164) DO UPDATE SET reason = EXCLUDED.reason, until = EXCLUDED.until`,
      [e164, req.body.reason, until],
    );
    return ok(res, { e164, blocked: true, until });
  },
);

router.get('/reports', async (req, res) =>
  ok(res, await query("SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 100")),
);

router.get('/reconcile', async (req, res) => ok(res, { mismatches: await walletService.reconcileAll() }));

router.get('/stats/daily', async (req, res) => ok(res, await dailyStats(req.query.day)));

module.exports = router;
