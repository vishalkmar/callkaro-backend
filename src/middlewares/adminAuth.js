const crypto = require('crypto');
const { env } = require('../config/env');
const { errors } = require('../utils/response');

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// "::ffff:1.2.3.4" (IPv4 seen through an IPv6 socket) must match "1.2.3.4" in the allowlist.
const normalizeIp = ip => String(ip || '').replace(/^::ffff:/i, '');

/** Admin endpoints: separate X-Admin-Key + optional IP allowlist. */
const requireAdmin = (req, res, next) => {
  if (env.ADMIN_IP_ALLOWLIST.length && !env.ADMIN_IP_ALLOWLIST.map(normalizeIp).includes(normalizeIp(req.ip))) {
    return next(errors.forbidden('IP_NOT_ALLOWED', 'Not allowed'));
  }
  if (!safeEqual(req.headers['x-admin-key'], env.ADMIN_API_KEY)) {
    return next(errors.unauthorized('BAD_ADMIN_KEY', 'Invalid admin key'));
  }
  return next();
};

module.exports = { requireAdmin, safeEqual, normalizeIp };
