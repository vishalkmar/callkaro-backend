const { query } = require('../config/db');
const { errors } = require('../utils/response');

/**
 * Free rewards are disabled on emulators / rooted devices (paid features stay allowed).
 * The app sends `X-Device-Integrity: emulator=0;rooted=0` (react-native-device-info).
 * This header can be forged, so it is one signal among many (device binding, caps, Play Integrity).
 */
const parse = header =>
  Object.fromEntries(
    String(header || '')
      .split(';')
      .map(p => p.split('=').map(s => s.trim()))
      .filter(p => p.length === 2),
  );

const requireTrustedDeviceForRewards = async (req, res, next) => {
  const flags = parse(req.headers['x-device-integrity']);
  if (flags.emulator === '1' || flags.rooted === '1') {
    await query('UPDATE users SET rewards_disabled = TRUE, updated_at = now() WHERE id = $1', [req.user.id]);
    return next(errors.forbidden('REWARDS_DISABLED', 'Free rewards are not available on emulators or rooted devices'));
  }
  if (req.user.doc?.rewards_disabled) {
    return next(errors.forbidden('REWARDS_DISABLED', 'Free rewards are not available for this account'));
  }
  return next();
};

module.exports = { requireTrustedDeviceForRewards, parse };
