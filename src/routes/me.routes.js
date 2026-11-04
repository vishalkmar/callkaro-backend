const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const c = require('../controllers/me.controller');

router.use(requireAuth);
router.get('/', c.getMe);
router.patch('/', validate({ body: Joi.object({ name: Joi.string().trim().min(1).max(60).required() }) }), c.updateMe);
router.delete('/', c.deleteMe);

module.exports = router;
