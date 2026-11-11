// Admin panel API (/admin-api). Browser session in an httpOnly cookie; every request must also carry the
// X-Admin-Panel header (a cross-site page cannot add it -> CSRF protection on top of SameSite=Strict).
const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { make } = require('../middlewares/rateLimit');
const { env } = require('../config/env');
const authSvc = require('../services/admin/adminAuth.service');
const data = require('../services/admin/adminData.service');
const { ok, errors } = require('../utils/response');

const COOKIE = 'ck_admin';
const loginLimiter = make(15 * 60 * 1000, 20); // per IP: password + code tries together

const readCookie = req => {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : null;
};
const setCookie = (res, token, maxAgeSec) =>
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/admin-api; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${env.isProd ? '; Secure' : ''}`,
  );
const ctxOf = req => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers['x-admin-panel'] !== '1') {
    return next(errors.forbidden('ADMIN_HEADER_REQUIRED', 'Not allowed'));
  }
  return next();
});

// ---- sign in ----
router.post(
  '/auth/login',
  loginLimiter,
  validate({ body: Joi.object({ username: Joi.string().max(60).required(), password: Joi.string().max(200).required() }) }),
  async (req, res) => ok(res, await authSvc.startLogin(req.body, ctxOf(req))),
);
router.post(
  '/auth/verify',
  loginLimiter,
  validate({ body: Joi.object({ challengeId: Joi.string().guid().required(), code: Joi.string().max(10).required() }) }),
  async (req, res) => {
    const r = await authSvc.finishLogin(req.body, ctxOf(req));
    setCookie(res, r.token, authSvc.SESSION_HOURS * 3600);
    return ok(res, { admin: r.admin });
  },
);

// ---- everything below needs a signed-in admin ----
router.use(async (req, res, next) => {
  try {
    const s = await authSvc.sessionAdmin(readCookie(req));
    if (!s) {
      return next(errors.unauthorized('ADMIN_SESSION', 'Please sign in'));
    }
    req.admin = s.admin;
    req.adminSessionId = s.sessionId;
    return next();
  } catch (e) {
    return next(e);
  }
});

router.get('/me', async (req, res) => ok(res, { admin: authSvc.publicAdmin(req.admin) }));
router.post('/auth/logout', async (req, res) => {
  await authSvc.logout(req.adminSessionId, req.admin.id, ctxOf(req));
  setCookie(res, '', 0);
  return ok(res, { loggedOut: true });
});

// ---- dashboard / users / transactions ----
const day = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
router.get('/dashboard', validate({ query: Joi.object({ from: day, to: day }) }), async (req, res) => ok(res, await data.dashboard(req.query)));
router.get(
  '/users',
  validate({
    query: Joi.object({
      search: Joi.string().allow('').max(100),
      status: Joi.string().valid('active', 'blocked', 'deleted', ''),
      page: Joi.number().integer().min(1).max(100000),
      limit: Joi.number().integer().min(5).max(100),
    }),
  }),
  async (req, res) => ok(res, await data.listUsers(req.query)),
);
router.get('/users/:id', async (req, res) => ok(res, await data.userDetail(req.params.id)));
router.post(
  '/users/:id/block',
  validate({ body: Joi.object({ blocked: Joi.boolean().required(), reason: Joi.string().allow('').max(300) }) }),
  async (req, res) => {
    const r = await data.setBlocked(req.params.id, req.body.blocked, req.body.reason);
    await authSvc.audit(req.admin.id, req.body.blocked ? 'user_blocked' : 'user_unblocked', ctxOf(req), {
      userId: req.params.id,
      reason: req.body.reason || null,
    });
    return ok(res, r);
  },
);
router.post(
  '/users/:id/credits',
  validate({ body: Joi.object({ amount: Joi.number().integer().required(), reason: Joi.string().min(3).max(300).required() }) }),
  async (req, res) => {
    const r = await data.adjustCredits(req.params.id, req.body.amount, req.body.reason, req.admin.username);
    await authSvc.audit(req.admin.id, 'credits_adjusted', ctxOf(req), {
      userId: req.params.id,
      amount: req.body.amount,
      reason: req.body.reason,
    });
    return ok(res, r);
  },
);
router.get(
  '/transactions',
  validate({
    query: Joi.object({
      from: day,
      to: day,
      type: Joi.string().allow('').max(40),
      search: Joi.string().allow('').max(100),
      page: Joi.number().integer().min(1).max(100000),
      limit: Joi.number().integer().min(5).max(100),
    }),
  }),
  async (req, res) => ok(res, await data.transactions(req.query)),
);

// ---- security tab ----
router.post(
  '/security/password',
  validate({ body: Joi.object({ currentPassword: Joi.string().max(200).required(), newPassword: Joi.string().max(200).required() }) }),
  async (req, res) => ok(res, await authSvc.changePassword(req.admin, req.body, req.adminSessionId, ctxOf(req))),
);
router.post('/security/totp/setup', async (req, res) => ok(res, await authSvc.totpSetup(req.admin)));
router.post(
  '/security/totp/enable',
  validate({ body: Joi.object({ code: Joi.string().max(10).required() }) }),
  async (req, res) => ok(res, await authSvc.totpEnable(req.admin, req.body.code, ctxOf(req))),
);
router.post(
  '/security/totp/disable',
  validate({ body: Joi.object({ password: Joi.string().max(200).required(), code: Joi.string().max(10).required() }) }),
  async (req, res) => ok(res, await authSvc.totpDisable(req.admin, req.body, ctxOf(req))),
);
router.get('/security/sessions', async (req, res) => ok(res, await authSvc.listSessions(req.admin.id, req.adminSessionId)));
router.post('/security/sessions/revoke-others', async (req, res) =>
  ok(res, await authSvc.revokeOtherSessions(req.admin.id, req.adminSessionId, ctxOf(req))),
);
router.get('/security/audit', async (req, res) => ok(res, await authSvc.auditLog(req.query.limit)));

module.exports = router;
