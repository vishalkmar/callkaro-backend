// Admin panel sign-in: username + password, then a second factor (emailed code or authenticator app).
// Sessions are opaque random tokens in an httpOnly cookie; only their SHA-256 is stored.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../../config/env');
const { query, queryOne } = require('../../config/db');
const { errors } = require('../../utils/response');
const logger = require('../../utils/logger');
const { sendAdminCodeEmail } = require('../brevo.service');
const totp = require('./totp');

const SESSION_HOURS = 12;
const IDLE_MINUTES = 120;
const CHALLENGE_MINUTES = 5;
const MAX_PASSWORD_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;
const MIN_PASSWORD = 10;
// bcrypt of a random value: compared when the username does not exist, so both paths take the same time.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const sixDigits = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

const audit = (adminId, action, ctx = {}, detail = {}) =>
  query('INSERT INTO admin_audit (admin_id, action, ip, user_agent, detail) VALUES ($1, $2, $3, $4, $5)', [
    adminId || null,
    action,
    ctx.ip || null,
    (ctx.userAgent || '').slice(0, 300) || null,
    detail,
  ]).catch(e => logger.error({ err: e.message }, 'admin audit write failed'));

const publicAdmin = a => ({
  id: a.id,
  username: a.username,
  email: a.email,
  totpEnabled: a.totp_enabled,
  lastLoginAt: a.last_login_at,
  passwordChangedAt: a.password_changed_at,
  createdAt: a.created_at,
});

/**
 * First admin from the environment (ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_2FA_EMAIL), created once.
 * Later password changes happen in the panel; the env password is not applied again.
 */
const seedAdmin = async () => {
  const username = String(env.ADMIN_USERNAME || '').trim().toLowerCase();
  if (!username || !env.ADMIN_PASSWORD) {
    return null;
  }
  const exists = await queryOne('SELECT id FROM admins WHERE username = $1', [username]);
  if (exists) {
    return exists;
  }
  const row = await queryOne(
    'INSERT INTO admins (username, password_hash, email) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING RETURNING id',
    [username, await bcrypt.hash(env.ADMIN_PASSWORD, 12), env.ADMIN_2FA_EMAIL],
  );
  if (row) {
    logger.info({ username }, 'admin account created from env');
  }
  return row;
};

/** Step 1: password. Returns a challenge for step 2 (email code sent, or authenticator expected). */
const startLogin = async ({ username, password }, ctx) => {
  const name = String(username || '').trim().toLowerCase();
  const admin = await queryOne('SELECT * FROM admins WHERE username = $1', [name]);
  const ok = await bcrypt.compare(String(password || ''), admin ? admin.password_hash : DUMMY_HASH);

  if (admin?.locked_until && new Date(admin.locked_until) > new Date()) {
    await audit(admin.id, 'login_locked', ctx);
    throw errors.tooMany('ADMIN_LOCKED', `Too many wrong attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
  if (!admin || !ok) {
    if (admin) {
      const fails = admin.failed_attempts + 1;
      await query(
        `UPDATE admins SET failed_attempts = $2::int,
           locked_until = CASE WHEN $2::int >= $3::int THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
        [admin.id, fails, MAX_PASSWORD_FAILS, String(LOCK_MINUTES)],
      );
    }
    await audit(admin?.id, 'login_failed', ctx, { username: name.slice(0, 60) });
    throw errors.unauthorized('ADMIN_BAD_LOGIN', 'Wrong username or password');
  }

  const method = admin.totp_enabled ? 'totp' : 'email';
  let codeHash = null;
  if (method === 'email') {
    const code = sixDigits();
    codeHash = await bcrypt.hash(code, 10);
    if (env.OTP_DEV_LOG) {
      // eslint-disable-next-line no-console
      console.log(`\n[OTP_DEV_LOG] admin ${admin.username} -> ${code}\n`);
    } else {
      await sendAdminCodeEmail({ to: admin.email, code });
    }
  }
  const ch = await queryOne(
    `INSERT INTO admin_challenges (admin_id, code_hash, ip, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval) RETURNING id`,
    [admin.id, codeHash, ctx.ip || null, String(CHALLENGE_MINUTES)],
  );
  await audit(admin.id, 'login_password_ok', ctx, { method });
  const masked = admin.email.replace(/^(.).*(@.*)$/, '$1***$2');
  return { challengeId: ch.id, method, sentTo: method === 'email' ? masked : null };
};

const newSession = async (adminId, ctx) => {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO admin_sessions (admin_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)`,
    [adminId, sha256(token), ctx.ip || null, (ctx.userAgent || '').slice(0, 300), String(SESSION_HOURS)],
  );
  return token;
};

/** Step 2: the second factor. Returns { token, admin } - the route puts the token in an httpOnly cookie. */
const finishLogin = async ({ challengeId, code }, ctx) => {
  const ch = await queryOne(
    `SELECT c.*, a.totp_enabled, a.totp_secret FROM admin_challenges c JOIN admins a ON a.id = c.admin_id
      WHERE c.id = $1 AND c.used_at IS NULL AND c.expires_at > now()`,
    [challengeId],
  );
  if (!ch || ch.attempts >= MAX_CODE_ATTEMPTS) {
    throw errors.badRequest('ADMIN_CODE_EXPIRED', 'This login has expired. Sign in again.');
  }
  const good = ch.code_hash
    ? await bcrypt.compare(String(code || ''), ch.code_hash)
    : totp.verifyTotp(totp.decryptSecret(ch.totp_secret), code);
  if (!good) {
    await query('UPDATE admin_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);
    await audit(ch.admin_id, 'login_code_failed', ctx);
    throw errors.badRequest('ADMIN_BAD_CODE', 'Wrong code', { attemptsLeft: MAX_CODE_ATTEMPTS - ch.attempts - 1 });
  }
  const used = await queryOne('UPDATE admin_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [ch.id]);
  if (!used) {
    throw errors.badRequest('ADMIN_CODE_EXPIRED', 'This login has expired. Sign in again.');
  }
  const admin = await queryOne(
    'UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1 RETURNING *',
    [ch.admin_id],
  );
  const token = await newSession(admin.id, ctx);
  await audit(admin.id, 'login_success', ctx, { method: ch.code_hash ? 'email' : 'totp' });
  return { token, admin: publicAdmin(admin) };
};

/** Cookie token -> admin (sliding idle timeout). Null when missing / expired / revoked. */
const sessionAdmin = async token => {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }
  const row = await queryOne(
    `UPDATE admin_sessions SET last_seen_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        AND last_seen_at > now() - ($2 || ' minutes')::interval
      RETURNING id, admin_id`,
    [sha256(token), String(IDLE_MINUTES)],
  );
  if (!row) {
    return null;
  }
  const admin = await queryOne('SELECT * FROM admins WHERE id = $1', [row.admin_id]);
  return admin ? { admin, sessionId: row.id } : null;
};

const logout = async (sessionId, adminId, ctx) => {
  await query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
  await audit(adminId, 'logout', ctx);
};

// ---------------- security tab ----------------

const changePassword = async (admin, { currentPassword, newPassword }, sessionId, ctx) => {
  if (!(await bcrypt.compare(String(currentPassword || ''), admin.password_hash))) {
    await audit(admin.id, 'password_change_failed', ctx);
    throw errors.badRequest('ADMIN_BAD_PASSWORD', 'Current password is wrong');
  }
  const pw = String(newPassword || '');
  if (pw.length < MIN_PASSWORD || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw errors.badRequest('ADMIN_WEAK_PASSWORD', `Use at least ${MIN_PASSWORD} characters with letters and numbers`);
  }
  await query('UPDATE admins SET password_hash = $2, password_changed_at = now() WHERE id = $1', [admin.id, await bcrypt.hash(pw, 12)]);
  // every other browser must sign in again
  await query('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL', [admin.id, sessionId]);
  await audit(admin.id, 'password_changed', ctx);
  return { changed: true };
};

/** Authenticator setup step 1: a new secret (not active until confirmed with a code). */
const totpSetup = async admin => {
  const secret = totp.generateSecret();
  await query('UPDATE admins SET totp_secret = $2 WHERE id = $1 AND totp_enabled = FALSE', [admin.id, totp.encryptSecret(secret)]);
  if (admin.totp_enabled) {
    throw errors.conflict('TOTP_ALREADY_ON', 'The authenticator app is already on. Turn it off first to set a new one.');
  }
  return { secret, otpauthUri: totp.otpauthUri(secret, admin.username) };
};

const totpEnable = async (admin, code, ctx) => {
  const fresh = await queryOne('SELECT totp_secret, totp_enabled FROM admins WHERE id = $1', [admin.id]);
  if (fresh.totp_enabled) {
    return { totpEnabled: true };
  }
  if (!fresh.totp_secret || !totp.verifyTotp(totp.decryptSecret(fresh.totp_secret), code)) {
    throw errors.badRequest('ADMIN_BAD_CODE', 'That code does not match. Check the time on your phone and try again.');
  }
  await query('UPDATE admins SET totp_enabled = TRUE WHERE id = $1', [admin.id]);
  await audit(admin.id, 'totp_enabled', ctx);
  return { totpEnabled: true };
};

const totpDisable = async (admin, { password, code }, ctx) => {
  if (!(await bcrypt.compare(String(password || ''), admin.password_hash))) {
    throw errors.badRequest('ADMIN_BAD_PASSWORD', 'Password is wrong');
  }
  if (!totp.verifyTotp(totp.decryptSecret(admin.totp_secret), code)) {
    throw errors.badRequest('ADMIN_BAD_CODE', 'Wrong authenticator code');
  }
  await query('UPDATE admins SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1', [admin.id]);
  await audit(admin.id, 'totp_disabled', ctx);
  return { totpEnabled: false };
};

const listSessions = async (adminId, currentId) =>
  (
    await query(
      `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM admin_sessions
        WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - ($2 || ' minutes')::interval
        ORDER BY last_seen_at DESC`,
      [adminId, String(IDLE_MINUTES)],
    )
  ).map(s => ({ ...s, current: s.id === currentId }));

const revokeOtherSessions = async (adminId, currentId, ctx) => {
  const rows = await query('UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id', [
    adminId,
    currentId,
  ]);
  await audit(adminId, 'sessions_revoked', ctx, { count: rows.length });
  return { revoked: rows.length };
};

const auditLog = (limit = 100) =>
  query(
    `SELECT l.id, l.action, l.ip, l.user_agent, l.detail, l.created_at, a.username
       FROM admin_audit l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.created_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit) || 100))],
  );

module.exports = {
  seedAdmin,
  startLogin,
  finishLogin,
  sessionAdmin,
  logout,
  changePassword,
  totpSetup,
  totpEnable,
  totpDisable,
  listSessions,
  revokeOtherSessions,
  auditLog,
  audit,
  publicAdmin,
  SESSION_HOURS,
};
