const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');
const economy = require('../config/economy');
const disposableDomains = require('../config/disposableDomains');
const { query, queryOne } = require('../config/db');
const { sendOtpEmail } = require('./brevo.service');
const { createSession } = require('./token.service');
const walletService = require('./wallet.service');
const { errors } = require('../utils/response');
const logger = require('../utils/logger');

const HOUR = 3600 * 1000;

const generateOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const isDisposable = email => disposableDomains.has(String(email).split('@')[1] || '');

/**
 * POST /auth/send-otp
 * Same response whether the email is new or existing (never reveals account existence).
 */
const sendOtp = async rawEmail => {
  const email = String(rawEmail).trim().toLowerCase();
  if (isDisposable(email)) {
    throw errors.badRequest('DISPOSABLE_EMAIL', 'Please use a permanent email address');
  }
  const now = new Date();
  const doc = await queryOne('SELECT * FROM otps WHERE email = $1', [email]);

  if (doc?.locked_until && new Date(doc.locked_until) > now) {
    throw errors.tooMany('OTP_LOCKED', 'Too many wrong attempts. Try again later.', {
      retryAfterSeconds: Math.ceil((new Date(doc.locked_until) - now) / 1000),
    });
  }
  if (doc?.last_sent_at && now - new Date(doc.last_sent_at) < env.OTP_RESEND_SECONDS * 1000) {
    const wait = Math.ceil((env.OTP_RESEND_SECONDS * 1000 - (now - new Date(doc.last_sent_at))) / 1000);
    throw errors.tooMany('OTP_COOLDOWN', `Please wait ${wait}s before requesting a new code`, { retryAfterSeconds: wait });
  }
  const recentSends = (doc?.send_times || []).map(t => new Date(t)).filter(t => now - t < HOUR);
  if (recentSends.length >= env.OTP_MAX_SENDS_PER_HOUR) {
    throw errors.tooMany('OTP_HOURLY_LIMIT', 'Too many codes requested. Try again in an hour.');
  }

  const demo = Boolean(env.DEMO_LOGIN_EMAIL && env.DEMO_LOGIN_OTP && email === env.DEMO_LOGIN_EMAIL);
  const code = demo ? env.DEMO_LOGIN_OTP : generateOtp();
  const otpHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(now.getTime() + env.OTP_TTL_MINUTES * 60000);

  // Send first: if Brevo fails, the previous state (and cooldown) is untouched.
  if (demo) {
    // Fixed code for the test account: nothing to send.
  } else if (env.OTP_DEV_LOG) {
    // Testing without Brevo: shown only in the developer's server console, never in pino logs / responses.
    // eslint-disable-next-line no-console
    console.log(`
[OTP_DEV_LOG] ${email} -> ${code}  (dev only; set OTP_DEV_LOG=false to send by Brevo)
`);
  } else {
    await sendOtpEmail({ to: email, code });
  }

  await query(
    `INSERT INTO otps (email, otp_hash, expires_at, attempts, locked_until, last_sent_at, send_times, purge_at)
     VALUES ($1, $2, $3, 0, NULL, $4, $5, $6)
     ON CONFLICT (email) DO UPDATE SET otp_hash = EXCLUDED.otp_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
       locked_until = NULL, last_sent_at = EXCLUDED.last_sent_at, send_times = EXCLUDED.send_times, purge_at = EXCLUDED.purge_at`,
    [email, otpHash, expiresAt, now, [...recentSends, now], new Date(now.getTime() + 2 * HOUR)],
  );
  logger.info({ emailDomain: email.split('@')[1] }, 'otp sent');
  return { sent: true, resendInSeconds: env.OTP_RESEND_SECONDS, expiresInSeconds: env.OTP_TTL_MINUTES * 60 };
};

const newReferralCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

/** Finds or creates the user, applying device binding + welcome bonus rules for new accounts. */
const upsertUser = async ({ email, deviceId, termsVersion, referralCode }) => {
  let user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
  if (user?.status === 'blocked') {
    throw errors.forbidden('USER_BLOCKED', 'Your account has been blocked. Contact support.');
  }
  let isNew = false;
  let welcomeEligible = false;

  if (!user) {
    // Device binding: limit accounts per device (stops welcome-bonus farming).
    const { n } = await queryOne("SELECT COUNT(*)::int AS n FROM users WHERE $1 = ANY(device_ids) AND status <> 'deleted'", [deviceId]);
    if (n >= env.ACCOUNTS_PER_DEVICE) {
      throw errors.forbidden('DEVICE_LIMIT', 'Too many accounts on this device. Login with your existing email.');
    }
    // Welcome bonus once per account AND once per device (ever, including deleted accounts).
    const used = await queryOne('SELECT 1 FROM users WHERE $1 = ANY(device_ids) LIMIT 1', [deviceId]);
    welcomeEligible = !used;
    let referredBy = null;
    if (referralCode) {
      const ref = await queryOne('SELECT id FROM users WHERE referral_code = $1', [String(referralCode).toUpperCase()]);
      referredBy = ref?.id || null;
    }
    user = await queryOne(
      'INSERT INTO users (email, referral_code, referred_by) VALUES ($1, $2, $3) RETURNING *',
      [email, newReferralCode(), referredBy],
    );
    isNew = true;
  }

  user = await queryOne(
    `UPDATE users SET device_id = $2,
       device_ids = CASE WHEN $2 = ANY(device_ids) THEN device_ids ELSE array_append(device_ids, $2) END,
       terms_version = COALESCE($3, terms_version), last_login_at = now(), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [user.id, deviceId, termsVersion || null],
  );

  await walletService.ensureWallet(user.id);
  if (isNew && welcomeEligible && economy.WELCOME_BONUS_CREDITS > 0) {
    await walletService.applyChange(user.id, economy.WELCOME_BONUS_CREDITS, 'welcome_bonus', `welcome:${user.id}`);
  }
  return { user, isNew };
};

/** POST /auth/verify-otp - compares the hash; 5 wrong attempts lock the email for 15 minutes. */
const verifyOtp = async ({ email: rawEmail, otp, deviceId, termsVersion, referralCode, userAgent }) => {
  const email = String(rawEmail).trim().toLowerCase();
  const now = new Date();
  const doc = await queryOne('SELECT * FROM otps WHERE email = $1', [email]);

  // Lock is checked first: a locked email has its hash cleared, but must still report OTP_LOCKED.
  if (doc?.locked_until && new Date(doc.locked_until) > now) {
    throw errors.tooMany('OTP_LOCKED', 'Too many wrong attempts. Try again later.', {
      retryAfterSeconds: Math.ceil((new Date(doc.locked_until) - now) / 1000),
    });
  }
  if (!doc || !doc.otp_hash || new Date(doc.expires_at) < now) {
    throw errors.badRequest('OTP_EXPIRED', 'Code expired. Request a new one.');
  }

  const match = await bcrypt.compare(String(otp), doc.otp_hash);
  if (!match) {
    const attempts = doc.attempts + 1;
    if (attempts >= env.OTP_MAX_ATTEMPTS) {
      const lockedUntil = new Date(now.getTime() + env.OTP_LOCK_MINUTES * 60000);
      await query('UPDATE otps SET attempts = $2, locked_until = $3, otp_hash = NULL, purge_at = $4 WHERE email = $1', [
        email,
        attempts,
        lockedUntil,
        new Date(lockedUntil.getTime() + HOUR),
      ]);
      throw errors.tooMany('OTP_LOCKED', `Too many wrong attempts. Try again in ${env.OTP_LOCK_MINUTES} minutes.`);
    }
    await query('UPDATE otps SET attempts = $2 WHERE email = $1', [email, attempts]);
    throw errors.badRequest('OTP_INVALID', 'Wrong code', { attemptsLeft: env.OTP_MAX_ATTEMPTS - attempts });
  }

  await query('DELETE FROM otps WHERE email = $1', [email]);
  const { user, isNew } = await upsertUser({ email, deviceId, termsVersion, referralCode });
  const tokens = await createSession({ userId: user.id, deviceId, userAgent });
  const wallet = await walletService.walletSummary(user.id);
  return { user, isNew, tokens, wallet };
};

/** Housekeeping (replaces the Mongo TTL index): drop expired OTP rows and long-expired sessions. */
const purgeExpired = async () => {
  await query('DELETE FROM otps WHERE purge_at < now()');
  await query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'");
};

module.exports = { sendOtp, verifyOtp, generateOtp, isDisposable, purgeExpired };
