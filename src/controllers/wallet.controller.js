const economy = require('../config/economy');
const { queryOne } = require('../config/db');
const walletService = require('../services/wallet.service');
const spinService = require('../services/spin.service');
const adsService = require('../services/ads.service');
const { ok, errors } = require('../utils/response');
const { localDayKey } = require('../utils/time');
const { env } = require('../config/env');

const checkinRef = userId => `checkin:${userId}:${localDayKey()}`;

const getWallet = async (req, res) => ok(res, await walletService.walletSummary(req.user.id));

const getLedger = async (req, res) => ok(res, await walletService.ledgerPage(req.user.id, req.query.page || 1));

/** Everything the Get Minutes screen needs. Amounts here are display info; the server applies them. */
const getConfig = async (req, res) => {
  const [spin, ads, checkin] = await Promise.all([
    spinService.status(req.user.id),
    adsService.adStatus(req.user.id),
    queryOne("SELECT 1 FROM ledger_entries WHERE type = 'checkin_reward' AND ref_id = $1", [checkinRef(req.user.id)]),
  ]);
  return ok(res, {
    creditsPerMinute: economy.CREDITS_PER_MINUTE,
    minCreditsToCall: economy.MIN_CREDITS_TO_CALL,
    paymentProvider: env.PAYMENT_PROVIDER,
    packages: economy.packages.map(p => ({
      id: p.id,
      priceInr: p.priceInr,
      minutes: p.minutes,
      credits: p.credits,
      badge: p.badge || null,
      noExpiry: true,
    })),
    ads,
    spin,
    checkin: { credits: economy.DAILY_CHECKIN_CREDITS, claimedToday: !!checkin },
    taxNote: 'Prices include applicable GST.',
  });
};

const checkin = async (req, res) => {
  const r = await walletService.applyChange(req.user.id, economy.DAILY_CHECKIN_CREDITS, 'checkin_reward', checkinRef(req.user.id));
  if (r.duplicate) {
    throw errors.conflict('ALREADY_CLAIMED', 'You already checked in today', { balance: r.balance });
  }
  return ok(res, { credits: economy.DAILY_CHECKIN_CREDITS, balance: r.balance });
};

module.exports = { getWallet, getLedger, getConfig, checkin };
