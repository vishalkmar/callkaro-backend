const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { authLimiter } = require('../middlewares/rateLimit');
const c = require('../controllers/auth.controller');

const email = Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).required();

router.use(authLimiter);

router.post('/send-otp', validate({ body: Joi.object({ email }) }), c.sendOtp);

router.post(
  '/verify-otp',
  validate({
    body: Joi.object({
      email,
      otp: Joi.string().pattern(/^\d{6}$/).required().messages({ 'string.pattern.base': 'otp must be 6 digits' }),
      deviceId: Joi.string().trim().min(4).max(128).required(),
      termsVersion: Joi.string().max(10),
      referralCode: Joi.string().alphanum().max(16),
    }),
  }),
  c.verifyOtp,
);

router.post('/refresh', validate({ body: Joi.object({ refreshToken: Joi.string().required() }) }), c.refresh);

// Logout only needs the refresh token (works even if the access token already expired).
router.post('/logout', validate({ body: Joi.object({ refreshToken: Joi.string().required() }) }), c.logout);

module.exports = router;
