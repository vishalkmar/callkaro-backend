const pino = require('pino');

const isTest = process.env.NODE_ENV === 'test';
const isDev = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';

// Never log OTPs, tokens or payment secrets - these paths are always redacted.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-twilio-signature"]',
  'req.headers["x-admin-key"]',
  'req.headers["x-razorpay-signature"]',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.purchaseToken',
  '*.password',
  '*.signature',
  '*.razorpay_signature',
  '*.razorpay_payment_id',
  '*.customData',
  '*.custom_data',
  'req.headers["x-device-integrity"]',
  'otp',
  'token',
];

const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      }
    : undefined,
});

module.exports = logger;
module.exports.REDACT_PATHS = REDACT_PATHS;
