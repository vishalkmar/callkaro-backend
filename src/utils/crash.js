// Server crash reporting without a third-party SDK: every crash / unexpected 500 is logged and sent to
// ALERT_WEBHOOK_URL (Telegram / Slack / Discord), de-duplicated so one bug cannot flood the channel.
const logger = require('./logger');
const { notify } = require('../services/alert.service');

const short = err => String(err?.message || err).slice(0, 160);

/** Express 500s: the route PATTERN is used (/calls/:id, not the id), so one bug = one alert. */
const reportServerError = (err, req) => {
  const where = `${req.method} ${req.baseUrl || ''}${req.route?.path || ''}`;
  notify(`Server error on ${where}: ${short(err)}`, { dedupeKey: `500:${where}:${short(err)}` }).catch(() => {});
};

/**
 * unhandledRejection: report and keep serving. uncaughtException: the process state is unknown, so report
 * (waiting at most `alertWaitMs` for the webhook) and exit - Render / Docker / PM2 start a fresh one.
 */
const installCrashHandlers = (proc = process, { alertWaitMs = 3000 } = {}) => {
  proc.on('unhandledRejection', err => {
    logger.error({ err: short(err), stack: err?.stack }, 'unhandledRejection');
    notify(`Unhandled promise rejection: ${short(err)}`, { dedupeKey: `rejection:${short(err)}` }).catch(() => {});
  });
  proc.on('uncaughtException', async err => {
    logger.fatal({ err: short(err), stack: err?.stack }, 'uncaughtException - exiting');
    await Promise.race([
      notify(`Server crashed (restarting): ${short(err)}`, { minIntervalMs: 0 }).catch(() => {}),
      new Promise(r => setTimeout(r, alertWaitMs).unref?.()),
    ]);
    proc.exit(1);
  });
};

module.exports = { installCrashHandlers, reportServerError };
