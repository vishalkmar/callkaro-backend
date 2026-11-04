const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { query, queryOne } = require('../config/db');
const voice = require('../services/voice.service');
const { ok, errors } = require('../utils/response');
const { publicCall } = require('../utils/serialize');

// GET /calls?page= - the user's server call records (billing truth) for reconciliation / history rebuild.
router.get(
  '/calls',
  requireAuth,
  validate({
    query: Joi.object({ page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(50).default(30) }),
  }),
  async (req, res) => {
    const { page, limit } = req.query;
    const [items, total] = await Promise.all([
      query(
        "SELECT * FROM calls WHERE user_id = $1 AND status <> 'blocked' ORDER BY started_at DESC LIMIT $2 OFFSET $3",
        [req.user.id, limit, (page - 1) * limit],
      ),
      queryOne("SELECT COUNT(*)::int AS n FROM calls WHERE user_id = $1 AND status <> 'blocked'", [req.user.id]),
    ]);
    return ok(res, { items: items.map(publicCall), page, total: total.n, hasMore: page * limit < total.n });
  },
);

router.get('/calls/:callSid', requireAuth, async (req, res) => {
  const call = await queryOne('SELECT * FROM calls WHERE call_sid = $1 AND user_id = $2', [req.params.callSid, req.user.id]);
  if (!call) {
    throw errors.notFound('CALL_NOT_FOUND', 'Call not found');
  }
  return ok(res, publicCall(call));
});

router.get('/recordings/:callSid/url', requireAuth, async (req, res) => ok(res, await voice.recordingUrlFor(req.user.id, req.params.callSid)));

// Signed-link download (no Bearer header needed - the short-lived token in the path is the auth).
router.get('/recordings/download/:token', async (req, res) => voice.streamRecording(req.params.token, res));

module.exports = router;
