const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { reportLimiter, authLimiter } = require('../middlewares/rateLimit');
const { queryOne } = require('../config/db');
const abuse = require('../services/abuse.service');
const { ok, errors } = require('../utils/response');
const { toE164India } = require('../utils/phone');

const REASONS = ['harassment', 'fraud', 'spam', 'impersonation', 'abuse', 'opt_out', 'app_problem', 'billing', 'other'];

const insertReport = r =>
  queryOne(
    `INSERT INTO reports (reporter_user_id, reporter_contact, target_number, target_user_id, call_sid, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      r.reporterUserId || null,
      r.reporterContact || null,
      r.targetNumber || null,
      r.targetUserId || null,
      r.callSid || null,
      r.reason,
      r.details || null,
    ],
  );

// In-app report: a number the user called / was bothered by, or an app problem.
router.post(
  '/report',
  requireAuth,
  reportLimiter,
  validate({
    body: Joi.object({
      targetNumber: Joi.string().max(20).allow('', null),
      reason: Joi.string()
        .valid(...REASONS)
        .required(),
      details: Joi.string().max(1000).allow(''),
      callSid: Joi.string().max(64).allow('', null),
    }),
  }),
  async (req, res) => {
    const targetNumber = req.body.targetNumber ? toE164India(req.body.targetNumber) : null;
    if (req.body.targetNumber && !targetNumber) {
      throw errors.badRequest('BAD_NUMBER', 'Invalid number');
    }
    const report = await insertReport({
      reporterUserId: req.user.id,
      targetNumber,
      reason: req.body.reason,
      details: req.body.details,
      callSid: req.body.callSid,
    });
    const outcome = await abuse.evaluateReports(report);
    return ok(res, { id: report.id, ...outcome }, 201);
  },
);

/**
 * Public form (website) for people who RECEIVED a call: report harassment or opt out.
 * They give their own number; we link the report to the user who called it recently.
 */
router.post(
  '/report/public',
  authLimiter,
  validate({
    body: Joi.object({
      myNumber: Joi.string().max(20).required(),
      reason: Joi.string().valid('harassment', 'fraud', 'spam', 'impersonation', 'abuse', 'opt_out', 'other').required(),
      details: Joi.string().max(1000).allow(''),
      contact: Joi.string().max(120).allow(''),
      calledAt: Joi.date().iso(),
    }),
  }),
  async (req, res) => {
    const myNumber = toE164India(req.body.myNumber);
    if (!myNumber) {
      throw errors.badRequest('BAD_NUMBER', 'Invalid number');
    }
    let targetUserId = null;
    if (req.body.reason !== 'opt_out') {
      const around = req.body.calledAt ? new Date(req.body.calledAt) : new Date();
      const recent = await queryOne(
        `SELECT user_id FROM calls WHERE to_number = $1 AND started_at BETWEEN $2 AND $3 ORDER BY started_at DESC LIMIT 1`,
        [myNumber, new Date(around.getTime() - 3 * 86400000), new Date(around.getTime() + 86400000)],
      );
      targetUserId = recent?.user_id || null;
    }
    const report = await insertReport({
      reporterContact: req.body.contact || myNumber,
      targetNumber: myNumber,
      targetUserId,
      reason: req.body.reason,
      details: req.body.details,
    });
    await abuse.evaluateReports(report);
    return ok(res, { received: true }, 201);
  },
);

module.exports = router;
