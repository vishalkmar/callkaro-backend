const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { adsLimiter } = require('../middlewares/rateLimit');
const { requireTrustedDeviceForRewards } = require('../middlewares/deviceIntegrity');
const adsService = require('../services/ads.service');
const { verifySsv } = require('../services/ssv.service');
const { ok } = require('../utils/response');
const logger = require('../utils/logger');

/**
 * GET /ads/ssv - called by Google (not the app). Signature is verified against Google's
 * published keys BEFORE anything is credited. Always 200 for a valid signature so AdMob
 * does not retry rewards we intentionally refused (cap, duplicate...).
 */
router.get('/ssv', async (req, res) => {
  const rawQuery = req.originalUrl.split('?')[1] || '';
  if (!rawQuery) {
    return res.status(200).send('ok'); // AdMob console URL check
  }
  const { valid, params, reason } = await verifySsv(rawQuery);
  if (!valid) {
    logger.warn({ reason }, 'ssv rejected');
    return res.status(403).send('invalid signature');
  }
  const result = await adsService.applySsvReward(params);
  logger.info({ rewarded: result.rewarded, reason: result.reason }, 'ssv processed');
  return res.status(200).send('ok');
});

router.use(requireAuth);
router.get('/status', async (req, res) => ok(res, await adsService.adStatus(req.user.id)));
router.post(
  '/session',
  adsLimiter,
  requireTrustedDeviceForRewards,
  validate({ body: Joi.object({ purpose: Joi.string().valid('credits', 'extra_spin').default('credits') }) }),
  async (req, res) => ok(res, await adsService.createSession(req.user.id, req.body.purpose)),
);

module.exports = router;
