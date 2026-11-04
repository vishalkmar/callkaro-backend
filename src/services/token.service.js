const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { query, queryOne } = require('../config/db');
const { errors } = require('../utils/response');

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

const ttlToMs = ttl => {
  const m = /^(\d+)([smhd])$/.exec(String(ttl));
  if (!m) {
    return 30 * 24 * 3600 * 1000;
  }
  return Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
};

const signAccessToken = ({ userId, sessionId, deviceId }) =>
  jwt.sign({ sub: String(userId), sid: String(sessionId), did: deviceId, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  });

const verifyAccessToken = token => {
  const p = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (p.typ !== 'access') {
    throw new jwt.JsonWebTokenError('wrong token type');
  }
  return p;
};

const signRefreshToken = ({ userId, sessionId }) =>
  jwt.sign(
    { sub: String(userId), sid: String(sessionId), typ: 'refresh', jti: crypto.randomBytes(16).toString('hex') },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL },
  );

/** Creates a session row (stores only the refresh-token hash) and returns a token pair. */
const createSession = async ({ userId, deviceId, userAgent }) => {
  const session = await queryOne(
    `INSERT INTO sessions (user_id, device_id, user_agent, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, 'pending', now() + ($4 || ' milliseconds')::interval) RETURNING id`,
    [userId, deviceId, userAgent || null, String(ttlToMs(env.JWT_REFRESH_TTL))],
  );
  const refreshToken = signRefreshToken({ userId, sessionId: session.id });
  await query('UPDATE sessions SET refresh_token_hash = $2 WHERE id = $1', [session.id, sha256(refreshToken)]);
  const accessToken = signAccessToken({ userId, sessionId: session.id, deviceId });
  return { accessToken, refreshToken, sessionId: session.id };
};

/** Rotation: a refresh token works once. Re-using an old one (theft signal) revokes the session. */
const rotateRefreshToken = async refreshToken => {
  let payload;
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch (e) {
    throw errors.unauthorized('INVALID_REFRESH', 'Please login again');
  }
  if (payload.typ !== 'refresh') {
    throw errors.unauthorized('INVALID_REFRESH', 'Please login again');
  }
  const session = await queryOne('SELECT * FROM sessions WHERE id = $1', [payload.sid]);
  if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
    throw errors.unauthorized('SESSION_REVOKED', 'Please login again');
  }
  if (session.refresh_token_hash !== sha256(refreshToken)) {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [session.id]);
    throw errors.unauthorized('REFRESH_REUSED', 'Please login again');
  }
  const next = signRefreshToken({ userId: session.user_id, sessionId: session.id });
  // Conditional update: two parallel refreshes with the same token cannot both win.
  const rotated = await queryOne(
    'UPDATE sessions SET refresh_token_hash = $2, last_used_at = now() WHERE id = $1 AND refresh_token_hash = $3 RETURNING id',
    [session.id, sha256(next), sha256(refreshToken)],
  );
  if (!rotated) {
    throw errors.unauthorized('REFRESH_REUSED', 'Please login again');
  }
  return {
    userId: session.user_id,
    accessToken: signAccessToken({ userId: session.user_id, sessionId: session.id, deviceId: session.device_id }),
    refreshToken: next,
  };
};

const revokeByRefreshToken = async refreshToken => {
  try {
    const payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, { ignoreExpiration: true });
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [payload.sid]);
  } catch (e) {
    // invalid token -> nothing to revoke
  }
};

const revokeSession = sessionId => query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);

const revokeAllForUser = userId => query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

module.exports = {
  sha256,
  signAccessToken,
  verifyAccessToken,
  createSession,
  rotateRefreshToken,
  revokeByRefreshToken,
  revokeSession,
  revokeAllForUser,
};
