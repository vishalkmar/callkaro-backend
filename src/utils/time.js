const economy = require('../config/economy');

/** Start of "today" in India time (IST), returned as a UTC Date - used for per-day caps. */
const startOfLocalDay = (now = new Date()) => {
  const offsetMs = economy.TIMEZONE_OFFSET_MINUTES * 60000;
  const local = new Date(now.getTime() + offsetMs);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetMs);
};

const localDayKey = (now = new Date()) => {
  const offsetMs = economy.TIMEZONE_OFFSET_MINUTES * 60000;
  return new Date(now.getTime() + offsetMs).toISOString().slice(0, 10);
};

module.exports = { startOfLocalDay, localDayKey };
