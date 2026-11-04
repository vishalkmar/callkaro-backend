const authService = require('../services/auth.service');
const { rotateRefreshToken, revokeByRefreshToken } = require('../services/token.service');
const { ok } = require('../utils/response');
const { publicUser } = require('../utils/serialize');

const sendOtp = async (req, res) => ok(res, await authService.sendOtp(req.body.email));

const verifyOtp = async (req, res) => {
  const { user, isNew, tokens, wallet } = await authService.verifyOtp({
    ...req.body,
    userAgent: req.headers['user-agent'],
  });
  return ok(res, {
    user: publicUser(user),
    isNew,
    tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    wallet,
  });
};

const refresh = async (req, res) => {
  const { accessToken, refreshToken } = await rotateRefreshToken(req.body.refreshToken);
  return ok(res, { accessToken, refreshToken });
};

const logout = async (req, res) => {
  await revokeByRefreshToken(req.body.refreshToken);
  return ok(res, { loggedOut: true });
};

module.exports = { sendOtp, verifyOtp, refresh, logout };
