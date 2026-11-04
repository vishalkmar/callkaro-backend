const { queryOne } = require('../config/db');
const { verifyAccessToken } = require('../services/token.service');
const { errors } = require('../utils/response');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifies the Bearer access token, loads the user, rejects blocked/deleted accounts. */
const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return next(errors.unauthorized('NO_TOKEN', 'Please login again'));
  }
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (e) {
    return next(errors.unauthorized(e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', 'Please login again'));
  }
  if (!UUID_RE.test(payload.sub)) {
    return next(errors.unauthorized('INVALID_TOKEN', 'Please login again'));
  }
  const user = await queryOne('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!user || user.status === 'deleted') {
    return next(errors.unauthorized('USER_NOT_FOUND', 'Please login again'));
  }
  if (user.status === 'blocked') {
    return next(errors.forbidden('USER_BLOCKED', 'Your account has been blocked. Contact support.'));
  }
  req.user = { id: user.id, email: user.email, doc: user, sessionId: payload.sid, deviceId: payload.did };
  return next();
};

module.exports = { requireAuth, UUID_RE };
