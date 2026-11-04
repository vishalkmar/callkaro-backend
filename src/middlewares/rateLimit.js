const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { env } = require('../config/env');

const handler = (req, res) =>
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests, please wait and try again' });

const make = (windowMs, limit, keyByUser = false) =>
  rateLimit({
    windowMs,
    limit: env.isTest ? 10000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler,
    keyGenerator: keyByUser
      ? req => (req.user ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`)
      : req => ipKeyGenerator(req.ip),
  });

module.exports = {
  make, // exported for tests
  globalLimiter: make(15 * 60 * 1000, 300), // per IP
  authLimiter: make(15 * 60 * 1000, 30), // /auth/* per IP
  voiceTokenLimiter: make(60 * 1000, 10, true), // per user
  spinLimiter: make(60 * 1000, 10, true),
  adsLimiter: make(60 * 1000, 10, true),
  reportLimiter: make(60 * 60 * 1000, 20, true),
  ordersLimiter: make(60 * 1000, 20, true),
};
