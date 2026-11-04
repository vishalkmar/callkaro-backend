const axios = require('axios');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Sends an operational alert. ALERT_WEBHOOK_URL can be a Slack/Discord-compatible webhook or a
 * Telegram bot URL (https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>).
 * Always also logged. Never include OTPs, tokens or payment details in alerts.
 */
const lastSent = new Map();

const notify = async (text, { dedupeKey, minIntervalMs = 10 * 60 * 1000 } = {}) => {
  logger.warn({ alert: text }, 'ALERT');
  if (!env.ALERT_WEBHOOK_URL || env.isTest) {
    return;
  }
  const key = dedupeKey || text;
  const prev = lastSent.get(key) || 0;
  if (Date.now() - prev < minIntervalMs) {
    return;
  }
  lastSent.set(key, Date.now());
  // Keys are often unique (e.g. one per failed call): keep the map small so it cannot grow forever.
  if (lastSent.size > 500) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [k, t] of lastSent) {
      if (t < cutoff || lastSent.size > 500) {
        lastSent.delete(k);
      }
    }
  }
  try {
    await axios.post(env.ALERT_WEBHOOK_URL, { text: `[CallKaro] ${text}`, content: `[CallKaro] ${text}` }, { timeout: 5000 });
  } catch (e) {
    logger.error({ err: e.message }, 'alert webhook failed');
  }
};

module.exports = { notify, _lastSent: lastSent };
