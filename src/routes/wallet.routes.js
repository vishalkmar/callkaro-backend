const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { requireTrustedDeviceForRewards } = require('../middlewares/deviceIntegrity');
const c = require('../controllers/wallet.controller');

router.use(requireAuth);
router.get('/', c.getWallet);
router.get('/ledger', validate({ query: Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1) }) }), c.getLedger);
router.get('/config', c.getConfig);
router.post('/checkin', requireTrustedDeviceForRewards, c.checkin);

module.exports = router;
