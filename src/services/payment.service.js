const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { env } = require('../config/env');
const economy = require('../config/economy');
const { query, queryOne } = require('../config/db');
const walletService = require('./wallet.service');
const { safeEqual } = require('../middlewares/adminAuth');
const { UUID_RE } = require('../middlewares/auth');
const { errors } = require('../utils/response');
const logger = require('../utils/logger');

// ---------------- helpers ----------------

const receiptNo = () =>
  `CK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

const publicOrder = o => ({
  id: o.id,
  packageId: o.package_id,
  minutes: o.minutes,
  credits: Number(o.credits),
  amountPaise: o.amount_paise,
  provider: o.provider,
  providerOrderId: o.provider_order_id || null,
  status: o.status,
  receiptNo: o.receipt_no || null,
  createdAt: o.created_at,
  paidAt: o.paid_at || null,
});

const getOrder = id => queryOne('SELECT * FROM orders WHERE id = $1', [id]);

/** Opaque per-user tag the app passes to Google (obfuscatedAccountId); Google returns it with the purchase. */
const accountTag = userId => crypto.createHash('sha256').update(`callkaro:${userId}`).digest('hex').slice(0, 40);

const isUniqueViolation = e => e?.code === '23505';

/** Referral: both users get a bonus after the referee's FIRST paid purchase (server verified). */
const maybeRewardReferral = async userId => {
  if (!economy.REFERRAL_BONUS_CREDITS) {
    return;
  }
  const user = await queryOne(
    `UPDATE users SET referral_rewarded = TRUE WHERE id = $1 AND referred_by IS NOT NULL AND referral_rewarded = FALSE
     RETURNING id, referred_by`,
    [userId],
  );
  if (!user) {
    return;
  }
  await walletService.applyChange(user.id, economy.REFERRAL_BONUS_CREDITS, 'referral_bonus', `referral:referee:${user.id}`);
  await walletService.applyChange(user.referred_by, economy.REFERRAL_BONUS_CREDITS, 'referral_bonus', `referral:referrer:${user.id}`);
};

/**
 * Marks an order paid and credits the wallet. Idempotent: the ledger ref is the order id and the
 * status flip is a conditional UPDATE, so webhooks + app verification can both call this safely.
 */
const markPaid = async (orderId, { providerPaymentId } = {}) => {
  await query(
    `UPDATE orders SET status = 'paid', paid_at = now(), provider_payment_id = $2, receipt_no = $3, updated_at = now()
      WHERE id = $1 AND status IN ('created', 'pending', 'failed')`,
    [orderId, providerPaymentId || null, receiptNo()],
  );
  const order = await getOrder(orderId);
  if (!order || order.status !== 'paid') {
    return { order, balance: undefined };
  }
  const r = await walletService.applyChange(order.user_id, Number(order.credits), 'purchase', `order:${order.id}`, {
    meta: {
      packageId: order.package_id,
      minutes: order.minutes,
      amountPaise: order.amount_paise,
      receiptNo: order.receipt_no,
      provider: order.provider,
    },
  });
  if (!r.duplicate) {
    await maybeRewardReferral(order.user_id).catch(e => logger.error({ err: e.message }, 'referral reward failed'));
  }
  return { order, balance: r.balance, alreadyCredited: r.duplicate };
};

/** Refund / chargeback / voided purchase -> remove the credits (balance can go to 0; user flagged if short). */
const reverse = async (orderId, reason) => {
  const order = await queryOne(
    `UPDATE orders SET status = 'refunded', refunded_at = now(), failure_reason = $2, updated_at = now()
      WHERE id = $1 AND status = 'paid' RETURNING *`,
    [orderId, reason],
  );
  if (!order) {
    return null;
  }
  const r = await walletService.applyChange(order.user_id, -Number(order.credits), 'payment_reversal', `order:${order.id}`, {
    partial: true,
    meta: { reason },
  });
  return { order, balance: r.balance, shortfall: r.shortfall };
};

const insertOrder = (userId, pkg, provider, providerOrderId = null) =>
  queryOne(
    `INSERT INTO orders (user_id, package_id, amount_paise, credits, minutes, provider, provider_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, pkg.id, pkg.amountPaise, pkg.credits, pkg.minutes, provider, providerOrderId],
  );

// ---------------- create ----------------

const createOrder = async (userId, packageId, provider = env.PAYMENT_PROVIDER) => {
  const pkg = economy.findPackage(packageId);
  if (!pkg) {
    throw errors.badRequest('BAD_PACKAGE', 'Unknown package');
  }
  let providerOrderId = null;
  if (provider === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw errors.unavailable('PAYMENTS_NOT_CONFIGURED', 'Payments are not configured yet');
    }
    const rp = await axios.post(
      'https://api.razorpay.com/v1/orders',
      { amount: pkg.amountPaise, currency: 'INR', receipt: `ck_${Date.now()}`, notes: { userId: String(userId), packageId: pkg.id } },
      { auth: { username: env.RAZORPAY_KEY_ID, password: env.RAZORPAY_KEY_SECRET }, timeout: 10000 },
    );
    providerOrderId = rp.data.id;
  }
  // credits are decided by the server, never by the app
  const order = await insertOrder(userId, pkg, provider, providerOrderId);
  return {
    order: publicOrder(order),
    productId: pkg.id,
    accountTag: accountTag(userId),
    razorpay:
      provider === 'razorpay'
        ? { keyId: env.RAZORPAY_KEY_ID, orderId: order.provider_order_id, amount: pkg.amountPaise, currency: 'INR' }
        : null,
  };
};

// ---------------- Razorpay ----------------

const verifyRazorpay = async (userId, { razorpay_order_id: rzOrderId, razorpay_payment_id: rzPaymentId, razorpay_signature: sig }) => {
  const order = await queryOne('SELECT * FROM orders WHERE provider_order_id = $1 AND user_id = $2', [rzOrderId, userId]);
  if (!order) {
    throw errors.notFound('ORDER_NOT_FOUND', 'Order not found');
  }
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET || '').update(`${rzOrderId}|${rzPaymentId}`).digest('hex');
  if (!safeEqual(expected, sig)) {
    await query(
      "UPDATE orders SET status = 'failed', failure_reason = 'bad_signature', updated_at = now() WHERE id = $1 AND status = 'created'",
      [order.id],
    );
    throw errors.badRequest('PAYMENT_VERIFICATION_FAILED', 'Payment could not be verified');
  }
  const r = await markPaid(order.id, { providerPaymentId: rzPaymentId });
  return { order: publicOrder(r.order), balance: r.balance };
};

const verifyRazorpayWebhook = (rawBody, signature) => {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !rawBody) {
    return false;
  }
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEqual(expected, signature);
};

const handleRazorpayEvent = async event => {
  const payment = event?.payload?.payment?.entity;
  const refund = event?.payload?.refund?.entity;
  const rzOrderId = payment?.order_id;
  const order = rzOrderId ? await queryOne('SELECT * FROM orders WHERE provider_order_id = $1', [rzOrderId]) : null;
  if (!order) {
    return { handled: false };
  }
  switch (event.event) {
    case 'payment.captured':
    case 'order.paid':
      await markPaid(order.id, { providerPaymentId: payment.id });
      return { handled: true };
    case 'payment.failed':
      await query(
        "UPDATE orders SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1 AND status IN ('created', 'pending')",
        [order.id, payment.error_description || 'failed'],
      );
      return { handled: true };
    case 'refund.processed':
    case 'payment.refunded':
      await reverse(order.id, `razorpay_refund:${refund?.id || ''}`);
      return { handled: true };
    default:
      return { handled: false };
  }
};

// ---------------- Google Play Billing ----------------

let playAuthClient = null;
const playAuth = async () => {
  if (!playAuthClient) {
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      throw errors.unavailable('PAYMENTS_NOT_CONFIGURED', 'Play Billing verification is not configured');
    }
    const { GoogleAuth } = require('google-auth-library');
    playAuthClient = new GoogleAuth({
      keyFile: path.resolve(process.cwd(), env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
  }
  return playAuthClient.getClient();
};
const setPlayClientForTest = client => {
  playAuthClient = { getClient: async () => client };
};

const playUrl = (productId, token, suffix = '') =>
  `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${env.GOOGLE_PLAY_PACKAGE_NAME}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}${suffix}`;

/** Token already processed -> idempotent answer (same user) or refusal (another account). */
const existingTokenAnswer = async (userId, purchaseToken) => {
  const existing = await queryOne('SELECT * FROM orders WHERE purchase_token = $1', [purchaseToken]);
  if (!existing) {
    return null;
  }
  if (existing.user_id !== userId) {
    throw errors.conflict('TOKEN_USED', 'This purchase belongs to another account');
  }
  const w = await walletService.getWallet(userId);
  return { order: publicOrder(existing), balance: w.credits, alreadyCredited: existing.status === 'paid' };
};

/** App sends purchaseToken -> server asks Google if it is really purchased -> credits -> consumes. */
const verifyPlay = async (userId, { orderId, productId, purchaseToken }) => {
  const pkg = economy.findPackage(productId);
  if (!pkg) {
    throw errors.badRequest('BAD_PACKAGE', 'Unknown product');
  }
  const done = await existingTokenAnswer(userId, purchaseToken);
  if (done) {
    return done;
  }

  const client = await playAuth();
  let data;
  try {
    ({ data } = await client.request({ url: playUrl(productId, purchaseToken) }));
  } catch (e) {
    const status = e.response?.status || e.status;
    if ([400, 404, 410].includes(status)) {
      // Google does not know this token for this product (fake / wrong product / expired).
      throw errors.badRequest('PAYMENT_VERIFICATION_FAILED', 'Purchase is not valid');
    }
    throw errors.unavailable('PAYMENT_CHECK_UNAVAILABLE', 'Could not reach Google Play. Your purchase is safe - we will retry.');
  }
  // Bought from this account? (only when the app passed obfuscatedAccountId)
  if (data.obfuscatedExternalAccountId && data.obfuscatedExternalAccountId !== accountTag(userId)) {
    throw errors.conflict('TOKEN_USED', 'This purchase belongs to another account');
  }
  // purchaseState: 0 purchased, 1 canceled, 2 pending
  if (data.purchaseState === 2) {
    throw errors.conflict('PAYMENT_PENDING', 'Payment is pending. Credits will be added once it completes.');
  }
  if (data.purchaseState !== 0) {
    throw errors.badRequest('PAYMENT_VERIFICATION_FAILED', 'Purchase is not valid');
  }

  // The order must be for the SAME product Google confirmed - otherwise a cheap purchase could be
  // attached to an expensive order. Never reuse an order that is already paid.
  let order =
    orderId && UUID_RE.test(orderId)
      ? await queryOne(
          "SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND provider = 'play' AND package_id = $3 AND status IN ('created', 'pending', 'failed') AND purchase_token IS NULL",
          [orderId, userId, pkg.id],
        )
      : null;
  if (!order) {
    order = await insertOrder(userId, pkg, 'play');
  }
  try {
    await query(
      "UPDATE orders SET purchase_token = $2, provider_order_id = COALESCE($3, provider_order_id), status = 'pending', updated_at = now() WHERE id = $1",
      [order.id, purchaseToken, data.orderId || null],
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      // A parallel request (purchase listener + restore on start) stored this token first.
      await query("UPDATE orders SET status = 'failed', failure_reason = 'duplicate_token_request' WHERE id = $1 AND status = 'created'", [order.id]);
      return existingTokenAnswer(userId, purchaseToken);
    }
    throw e;
  }
  const r = await markPaid(order.id, { providerPaymentId: data.orderId });

  if (data.consumptionState === 0) {
    try {
      await client.request({ url: playUrl(productId, purchaseToken, ':consume'), method: 'POST' });
    } catch (e) {
      logger.warn({ err: e.message }, 'play consume failed (app will also finish the transaction)');
    }
  }
  return { order: publicOrder(r.order), balance: r.balance };
};

/** Real-time developer notifications (Pub/Sub push). Voided purchases -> reverse credits. */
const handlePlayRtdn = async message => {
  const json = JSON.parse(Buffer.from(message?.data || '', 'base64').toString('utf8') || '{}');
  const voided = json.voidedPurchaseNotification;
  if (voided?.purchaseToken) {
    const order = await queryOne('SELECT id FROM orders WHERE purchase_token = $1', [voided.purchaseToken]);
    if (order) {
      await reverse(order.id, 'play_voided');
      return { handled: true };
    }
  }
  return { handled: false };
};

module.exports = {
  accountTag,
  createOrder,
  verifyRazorpay,
  verifyRazorpayWebhook,
  handleRazorpayEvent,
  verifyPlay,
  handlePlayRtdn,
  markPaid,
  reverse,
  publicOrder,
  getOrder,
  setPlayClientForTest,
};
