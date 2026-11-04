const cron = require('node-cron');
const logger = require('../utils/logger');
const unbilledCalls = require('./unbilledCalls.job');
const cleanupRecordings = require('./cleanupRecordings.job');
const spendGuard = require('./spendGuard.job');

const safe = (name, fn) => async () => {
  try {
    await fn();
  } catch (e) {
    logger.error({ job: name, err: e.message }, 'job failed');
  }
};

/** Schedules are in India time. */
const startJobs = () => {
  const tz = { timezone: 'Asia/Kolkata' };
  cron.schedule('*/10 * * * *', safe('unbilledCalls', () => unbilledCalls.run()), tz); // billing retry queue
  cron.schedule('30 2 * * *', safe('unbilledCalls-nightly', () => unbilledCalls.run({ olderThanMinutes: 60, limit: 5000 })), tz);
  cron.schedule('0 3 * * *', safe('cleanupRecordings', () => cleanupRecordings.run()), tz);
  cron.schedule('15 3 * * *', safe('reconcile', () => spendGuard.reconcile()), tz);
  cron.schedule('5 * * * *', safe('spendGuard', () => spendGuard.run()), tz);
  logger.info('background jobs scheduled');
};

module.exports = { startJobs };
