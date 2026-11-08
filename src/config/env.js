// Loads .env and validates required variables at boot. Exits with a clear message if something is missing.
const path = require('path');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env'), quiet: true });

const REQUIRED_ALWAYS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'BREVO_API_KEY',
  'BREVO_SENDER_EMAIL',
  'ADMIN_API_KEY',
];


// Telephony is optional until you have a provider: with NO Twilio key the API runs and calls answer
// "Calling is not configured yet". Once ANY Twilio key is set, all of them must be set (no half setup).
const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_TWIML_APP_SID',
  'CALLER_ID_POOL',
];

// Second provider. USE_TELNYX=true makes Telnyx carry ALL new calls (Twilio settings are then ignored);
// false / missing = Twilio. Switching needs only an env change + restart - the app follows the server.
const TELNYX_KEYS = ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID', 'TELNYX_CALL_CONTROL_APP_ID', 'TELNYX_CALLER_ID_POOL'];

const int = (key, def) => {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : def;
};
const list = key =>
  (process.env[key] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const NODE_ENV = process.env.NODE_ENV || 'development';

// Dashboard values are often pasted with quotes or spaces ("demo@x.com"): strip both.
const clean = key => (process.env[key] || '').trim().replace(/^["']|["']$/g, '').trim();

const fail = msg => {
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(1);
};

/**
 * Public https URL of this API (provider webhooks, recording links). On Render, RENDER_EXTERNAL_URL is the
 * service's real https address, used when PUBLIC_BASE_URL is missing or not https (e.g. a copied local value).
 */
const publicBaseUrl = () => {
  const own = (process.env.PUBLIC_BASE_URL || '').trim();
  const render = (process.env.RENDER_EXTERNAL_URL || '').trim();
  if (/^https:\/\//.test(own)) {
    return own;
  }
  if (/^https:\/\//.test(render)) {
    return render;
  }
  return own || 'http://localhost:5000';
};

/** Checks the environment at boot and lists EVERY problem at once. Reads NODE_ENV at call time (testable). */
const validate = () => {
  const prod = (process.env.NODE_ENV || 'development') === 'production';
  const useTelnyx = process.env.USE_TELNYX === 'true';
  const twilioStarted = TWILIO_KEYS.some(k => process.env[k]);
  const required = [
    ...REQUIRED_ALWAYS,
    // Telnyx on: its keys are needed in every environment (otherwise no call can work).
    ...(useTelnyx ? TELNYX_KEYS : []),
    ...(useTelnyx && prod ? ['TELNYX_PUBLIC_KEY'] : []),
    // Twilio is only checked while it is the active provider.
    ...(prod && !useTelnyx && twilioStarted ? TWILIO_KEYS : []),
  ];
  const problems = required.filter(k => !process.env[k]).map(k => `${k} is missing`);
  if (prod) {
    for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      if (process.env[k] && process.env[k].length < 64) {
        problems.push(`${k} must be at least 64 characters in production (now ${process.env[k].length})`);
      }
    }
    if (process.env.OTP_DEV_LOG === 'true') {
      problems.push('OTP_DEV_LOG must never be enabled in production - remove it or set false (OTPs go by Brevo email)');
    }
    if (process.env.SKIP_WEBHOOK_SIGNATURE === 'true') {
      problems.push('SKIP_WEBHOOK_SIGNATURE must never be enabled in production - remove it');
    }
    if (!/^https:\/\//.test(publicBaseUrl())) {
      problems.push('PUBLIC_BASE_URL must be the https:// address of this API (e.g. https://your-app.onrender.com)');
    }
  }
  for (const key of ['CALLER_ID_POOL', 'TELNYX_CALLER_ID_POOL']) {
    const bad = list(key).filter(n => !/^\+[1-9]\d{7,14}$/.test(n));
    if (bad.length) {
      problems.push(`${key} must be real E.164 numbers like +19105551234 (bad: ${bad.join(', ')})`);
    }
  }
  if (process.env.USE_TELNYX && !['true', 'false'].includes(process.env.USE_TELNYX)) {
    problems.push(`USE_TELNYX must be true or false (now "${process.env.USE_TELNYX}")`);
  }
  const demoEmail = clean('DEMO_LOGIN_EMAIL');
  const demoOtp = clean('DEMO_LOGIN_OTP');
  if (demoEmail || demoOtp) {
    if (!demoEmail.includes('@')) {
      problems.push('DEMO_LOGIN_EMAIL must be an email when DEMO_LOGIN_OTP is set (or remove both)');
    }
    if (!/^\d{6}$/.test(demoOtp)) {
      problems.push('DEMO_LOGIN_OTP must be exactly 6 digits when DEMO_LOGIN_EMAIL is set (or remove both)');
    }
  }
  if (problems.length) {
    return fail(
      `\n[env] Cannot start - fix these environment variables:\n  - ${problems.join('\n  - ')}\n` +
        '(Local: server/.env, Render: Dashboard > Environment)\n',
    );
  }
  return true;
};

const env = {
  NODE_ENV,
  isProd: NODE_ENV === 'production',
  isTest: NODE_ENV === 'test',
  PORT: int('PORT', 5000),
  PUBLIC_BASE_URL: publicBaseUrl().replace(/\/$/, ''),
  DATABASE_URL: process.env.DATABASE_URL, // Neon: postgresql://user:pass@ep-xxx.region.aws.neon.tech/callkaro?sslmode=require
  CORS_ORIGINS: list('CORS_ORIGINS'),
  TRUST_PROXY: int('TRUST_PROXY', 1),

  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  JWT_ACCESS_TTL: process.env.JWT_ACCESS_TTL || '30m',
  JWT_REFRESH_TTL: process.env.JWT_REFRESH_TTL || '30d',

  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL,
  BREVO_SENDER_NAME: process.env.BREVO_SENDER_NAME || 'CallKaro',
  OTP_TTL_MINUTES: int('OTP_TTL_MINUTES', 5),
  // DEV / TESTING ONLY: print the OTP in the server console instead of emailing it (Brevo not set up yet).
  // Production refuses to start with this on (see validate()).
  OTP_DEV_LOG: process.env.OTP_DEV_LOG === 'true' && NODE_ENV !== 'production',
  // Test / store-review account: this ONE email always gets DEMO_LOGIN_OTP and no email is sent.
  // Every other email still goes through Brevo. Remove both to turn it off.
  DEMO_LOGIN_EMAIL: clean('DEMO_LOGIN_EMAIL').toLowerCase(),
  DEMO_LOGIN_OTP: clean('DEMO_LOGIN_OTP'),
  OTP_RESEND_SECONDS: int('OTP_RESEND_SECONDS', 60),
  OTP_MAX_SENDS_PER_HOUR: int('OTP_MAX_SENDS_PER_HOUR', 5),
  OTP_MAX_ATTEMPTS: int('OTP_MAX_ATTEMPTS', 5),
  OTP_LOCK_MINUTES: int('OTP_LOCK_MINUTES', 15),

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID,
  TWILIO_PUSH_CREDENTIAL_SID: process.env.TWILIO_PUSH_CREDENTIAL_SID,
  CALLER_ID_POOL: list('CALLER_ID_POOL'),

  USE_TELNYX: process.env.USE_TELNYX === 'true',
  TELNYX_API_KEY: process.env.TELNYX_API_KEY,
  // Base64 Ed25519 key from Mission Control > Keys & Credentials > Public Key (webhook signatures).
  TELNYX_PUBLIC_KEY: process.env.TELNYX_PUBLIC_KEY,
  // Credential Connection the app's WebRTC client logs in to (webhooks -> /voice/telnyx/webhook, call parking on).
  TELNYX_CONNECTION_ID: process.env.TELNYX_CONNECTION_ID,
  // Voice API (Call Control) Application used to dial the PSTN number (outbound voice profile with India allowed).
  TELNYX_CALL_CONTROL_APP_ID: process.env.TELNYX_CALL_CONTROL_APP_ID,
  TELNYX_CALLER_ID_POOL: list('TELNYX_CALLER_ID_POOL'),
  TELNYX_API_BASE: process.env.TELNYX_API_BASE || 'https://api.telnyx.com/v2',
  SKIP_WEBHOOK_SIGNATURE: process.env.SKIP_WEBHOOK_SIGNATURE === 'true' && NODE_ENV !== 'production',
  REPORT_URL: process.env.REPORT_URL || 'yourapp.in/report',
  RECORDING_RETENTION_DAYS: int('RECORDING_RETENTION_DAYS', 7),
  CALL_METADATA_RETENTION_DAYS: int('CALL_METADATA_RETENTION_DAYS', 365),

  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,
  GOOGLE_PLAY_PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.callkaro.app',
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  PLAY_RTDN_TOKEN: process.env.PLAY_RTDN_TOKEN,
  PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER || 'play',

  // Numeric ad unit ids (the part after '/') of our rewarded units, comma separated. Empty = accept any.
  ADMOB_REWARDED_AD_UNITS: (process.env.ADMOB_REWARDED_AD_UNITS || '')
    .split(',')
    .map(s => s.trim().split('/').pop())
    .filter(Boolean),
  ADMOB_SSV_KEYS_URL: process.env.ADMOB_SSV_KEYS_URL || 'https://www.gstatic.com/admob/reward/verifier-keys.json',
  ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  ADMIN_IP_ALLOWLIST: list('ADMIN_IP_ALLOWLIST'),
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL,
  DAILY_TELEPHONY_SPEND_ALERT_INR: int('DAILY_TELEPHONY_SPEND_ALERT_INR', 2000),
  PROVIDER_COST_PAISE_PER_MIN: int('PROVIDER_COST_PAISE_PER_MIN', 120),
  ACCOUNTS_PER_DEVICE: int('ACCOUNTS_PER_DEVICE', 2),
  APP_VERSION: process.env.npm_package_version || '1.0.0',
  GIT_COMMIT: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || undefined, // which deploy is running
};

module.exports = { env, validate };
