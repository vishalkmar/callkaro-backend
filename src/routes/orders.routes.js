const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { ordersLimiter } = require('../middlewares/rateLimit');
const payments = require('../services/payment.service');
const { queryOne } = require('../config/db');
const { UUID_RE } = require('../middlewares/auth');
const { ok, errors } = require('../utils/response');

router.use(requireAuth, ordersLimiter);

router.post(
  '/create',
  validate({ body: Joi.object({ packageId: Joi.string().max(40).required(), provider: Joi.string().valid('play', 'razorpay') }) }),
  async (req, res) => ok(res, await payments.createOrder(req.user.id, req.body.packageId, req.body.provider), 201),
);

router.post(
  '/verify-play',
  validate({
    body: Joi.object({
      orderId: Joi.string().max(40).allow('', null),
      productId: Joi.string().max(40).required(),
      purchaseToken: Joi.string().max(4096).required(),
    }),
  }),
  async (req, res) => ok(res, await payments.verifyPlay(req.user.id, req.body)),
);

router.post(
  '/verify-razorpay',
  validate({
    body: Joi.object({
      razorpay_order_id: Joi.string().max(64).required(),
      razorpay_payment_id: Joi.string().max(64).required(),
      razorpay_signature: Joi.string().max(256).required(),
    }),
  }),
  async (req, res) => ok(res, await payments.verifyRazorpay(req.user.id, req.body)),
);

router.get('/:id', async (req, res) => {
  const order = UUID_RE.test(req.params.id)
    ? await queryOne('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id])
    : null;
  if (!order) {
    throw errors.notFound('ORDER_NOT_FOUND', 'Order not found');
  }
  return ok(res, payments.publicOrder(order));
});

module.exports = router;
