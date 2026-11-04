const { env } = require('../config/env');
const { dailyStats } = require('../services/stats.service');
const walletService = require('../services/wallet.service');
const alerts = require('../services/alert.service');

/** Hourly: alert if today's estimated telephony spend crosses the threshold or margin turns negative. */
const run = async () => {
  const s = await dailyStats();
  if (s.estProviderCostInr > env.DAILY_TELEPHONY_SPEND_ALERT_INR) {
    await alerts.notify(
      `Telephony spend today ~Rs.${s.estProviderCostInr} (threshold Rs.${env.DAILY_TELEPHONY_SPEND_ALERT_INR}). Calls: ${s.calls}, minutes: ${s.talkMinutes}`,
      { dedupeKey: 'spend-guard', minIntervalMs: 3 * 3600 * 1000 },
    );
  }
  return s;
};

/** Nightly: ledger vs wallet reconciliation. */
const reconcile = async () => {
  const mismatches = await walletService.reconcileAll();
  if (mismatches.length) {
    await alerts.notify(`Wallet reconciliation: ${mismatches.length} mismatch(es) found`, { dedupeKey: 'reconcile' });
  }
  return mismatches;
};

module.exports = { run, reconcile };
