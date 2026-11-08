const twilio = require('twilio');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Validates X-Twilio-Signature on every voice webhook. The URL must match exactly what
 * Twilio called, so we rebuild it from PUBLIC_BASE_URL + originalUrl.
 */
const twilioSignature = (req, res, next) => {
  if (env.SKIP_WEBHOOK_SIGNATURE) {
    return next(); // local testing only, never allowed in production (see env.js)
  }
  const signature = req.headers['x-twilio-signature'];
  const url = `${env.PUBLIC_BASE_URL}${req.originalUrl}`;
  const params = req.method === 'POST' ? req.body || {} : {};
  const valid =
    !!signature && !!env.TWILIO_AUTH_TOKEN && twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
  if (!valid) {
    logger.warn({ url }, 'invalid twilio signature');
    return res.status(403).type('text/plain').send('Invalid signature');
  }
  return next();
};

/** Telnyx webhooks: Ed25519 signature of "timestamp|raw body" with TELNYX_PUBLIC_KEY, 5-minute replay window. */
const telnyxSignature = (req, res, next) => {
  if (env.SKIP_WEBHOOK_SIGNATURE) {
    return next(); // local testing only, never allowed in production (see env.js)
  }
  // eslint-disable-next-line global-require
  const { verifySignature } = require('../services/telnyx.service');
  const valid = verifySignature({
    rawBody: req.rawBody,
    signature: req.headers['telnyx-signature-ed25519'],
    timestamp: req.headers['telnyx-timestamp'],
  });
  if (!valid) {
    logger.warn('invalid telnyx signature');
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Invalid signature' });
  }
  return next();
};

module.exports = { twilioSignature, telnyxSignature };
