const router = require('express').Router();
const { requireAuth } = require('../middlewares/auth');
const { spinLimiter } = require('../middlewares/rateLimit');
const { requireTrustedDeviceForRewards } = require('../middlewares/deviceIntegrity');
const spinService = require('../services/spin.service');
const { ok } = require('../utils/response');

router.use(requireAuth);
router.get('/status', async (req, res) => ok(res, await spinService.status(req.user.id)));
// No body: the app never sends an amount or a segment.
router.post('/play', spinLimiter, requireTrustedDeviceForRewards, async (req, res) => ok(res, await spinService.play(req.user.id)));

module.exports = router;
