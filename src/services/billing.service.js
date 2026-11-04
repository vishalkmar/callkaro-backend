// Pure billing math (Section 5.1). No I/O so it is trivially unit-testable.
const economy = require('../config/economy');

const CPM = () => economy.CREDITS_PER_MINUTE;

/** Per-second billing: ceil(talkSeconds * 1000 / 60). 0s -> 0, 1s -> 17, 59s -> 984, 60s -> 1000, 61s -> 1017. */
const chargeForSeconds = talkSeconds => {
  const s = Math.max(0, Math.floor(Number(talkSeconds) || 0));
  return Math.ceil((s * CPM()) / 60);
};

/**
 * Alternative per-minute pulse billing (documented, not active): every started minute is charged in full.
 * 1s -> 1000, 60s -> 1000, 61s -> 2000.
 */
const chargePerMinutePulse = talkSeconds => {
  const s = Math.max(0, Math.floor(Number(talkSeconds) || 0));
  return Math.ceil(s / 60) * CPM();
};

/** Maximum talk time the balance allows -> sent to the provider as Dial timeLimit. */
const maxSecondsForCredits = credits => Math.max(0, Math.floor((Math.max(0, Number(credits) || 0) * 60) / CPM()));

const minutesForCredits = credits => Math.max(0, Math.floor((Number(credits) || 0) / CPM()));

const canStartCall = credits => (Number(credits) || 0) >= economy.MIN_CREDITS_TO_CALL;

module.exports = { chargeForSeconds, chargePerMinutePulse, maxSecondsForCredits, minutesForCredits, canStartCall };
