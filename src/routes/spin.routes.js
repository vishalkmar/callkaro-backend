const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { spinLimiter } = require('../middlewares/rateLimit');
const { requireTrustedDeviceForRewards } = require('../middlewares/deviceIntegrity');
const spinService = require('../services/spin.service');
const { ok } = require('../utils/response');

router.use(requireAuth);
router.get('/status', async (req, res) => ok(res, await spinService.status(req.user.id)));
// No body: the app never sends an amount or a segment.
router.post('/play', spinLimiter, requireTrustedDeviceForRewards, async (req, res) => ok(res, await spinService.play(req.user.id)));
// Test-ad mode only: the app reports the watched ad. With real ad units the SSV callback credits instead.
router.post(
  '/claim',
  spinLimiter,
  requireTrustedDeviceForRewards,
  validate({ body: Joi.object({ spinId: Joi.string().guid().required() }) }),
  async (req, res) => ok(res, await spinService.claimFromApp(req.user.id, req.body.spinId)),
);

module.exports = router;
