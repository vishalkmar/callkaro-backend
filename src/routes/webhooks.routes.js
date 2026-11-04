const router = require('express').Router();
const { env } = require('../config/env');
const payments = require('../services/payment.service');
const { safeEqual } = require('../middlewares/adminAuth');
const logger = require('../utils/logger');

// Payment provider webhooks are the source of truth (captured / refunded).

router.post('/payments/razorpay', async (req, res) => {
  if (!payments.verifyRazorpayWebhook(req.rawBody, req.headers['x-razorpay-signature'])) {
    logger.warn('razorpay webhook: bad signature');
    return res.status(400).json({ success: false, code: 'BAD_SIGNATURE', message: 'Invalid signature' });
  }
  const r = await payments.handleRazorpayEvent(req.body);
  return res.json({ success: true, data: r });
});

// Google Play RTDN via Pub/Sub push subscription: https://api.../webhooks/payments/play?token=PLAY_RTDN_TOKEN
router.post('/payments/play', async (req, res) => {
  if (!env.PLAY_RTDN_TOKEN || !safeEqual(req.query.token, env.PLAY_RTDN_TOKEN)) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Forbidden' });
  }
  const r = await payments.handlePlayRtdn(req.body?.message);
  return res.json({ success: true, data: r });
});

module.exports = router;
