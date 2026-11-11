const crypto = require('crypto');
// Every economy number lives here (overridable from .env) so prices change without an app update.
const int = (key, def) => {
  const v = parseInt(process.env[key], 10);
  return Number.isFinite(v) ? v : def;
};

const CREDITS_PER_MINUTE = int('CREDITS_PER_MINUTE', 1000);

const DEFAULT_PACKAGES = [
  { id: 'minutes_80', priceInr: 100, minutes: 80 },
  { id: 'minutes_170', priceInr: 200, minutes: 170 },
  { id: 'minutes_270', priceInr: 300, minutes: 270, badge: 'Best value' },
  { id: 'minutes_475', priceInr: 500, minutes: 475 },
];

const validPackage = p =>
  p &&
  typeof p.id === 'string' &&
  /^[a-z0-9_.]{1,40}$/.test(p.id) &&
  Number.isInteger(p.priceInr) &&
  p.priceInr > 0 &&
  Number.isInteger(p.minutes) &&
  p.minutes > 0;

/** PACKAGES_JSON from .env, or the defaults if it is missing / broken (a bad package must never reach a buyer). */
const parsePackages = () => {
  if (!process.env.PACKAGES_JSON) {
    return DEFAULT_PACKAGES;
  }
  try {
    const list = JSON.parse(process.env.PACKAGES_JSON);
    const ids = new Set();
    const ok = Array.isArray(list) && list.length > 0 && list.every(p => validPackage(p) && !ids.has(p.id) && ids.add(p.id));
    if (ok) {
      return list;
    }
  } catch (e) {
    // fall through
  }
  // eslint-disable-next-line no-console
  console.warn('PACKAGES_JSON is invalid - using the default packages');
  return DEFAULT_PACKAGES;
};

// Segment order = order drawn on the wheel (clockwise from the top pointer).
// Owner rule (2026-11-04): small prizes; the wheel almost always lands on 5, about 1 spin in 50 lands on 10,
// 20 is shown but never won. Weights are relative; the app shows the real odds next to the wheel.
const DEFAULT_SPIN_SEGMENTS = [
  { label: '5', credits: 5, weight: 98 / 3 },
  { label: '10', credits: 10, weight: 2 / 3 },
  { label: '20', credits: 20, weight: 0 },
  { label: '5', credits: 5, weight: 98 / 3 },
  { label: '10', credits: 10, weight: 2 / 3 },
  { label: '20', credits: 20, weight: 0 },
  { label: '5', credits: 5, weight: 98 / 3 },
  { label: '10', credits: 10, weight: 2 / 3 },
];

const validSegments = list =>
  Array.isArray(list) &&
  list.length >= 2 &&
  list.length <= 12 &&
  list.every(
    s =>
      s &&
      typeof s.label === 'string' &&
      s.label.length > 0 &&
      s.label.length <= 12 &&
      Number.isInteger(s.credits) &&
      s.credits >= 0 &&
      s.credits <= 100000 &&
      typeof s.weight === 'number' &&
      Number.isFinite(s.weight) &&
      s.weight >= 0,
  ) &&
  list.reduce((t, s) => t + s.weight, 0) > 0;

/** SPIN_SEGMENTS_JSON from .env (change prizes/odds without an app update), else the defaults. */
const parseSpinSegments = () => {
  if (!process.env.SPIN_SEGMENTS_JSON) {
    return DEFAULT_SPIN_SEGMENTS;
  }
  try {
    const list = JSON.parse(process.env.SPIN_SEGMENTS_JSON);
    if (validSegments(list)) {
      return list;
    }
  } catch (e) {
    // fall through
  }
  // eslint-disable-next-line no-console
  console.warn('SPIN_SEGMENTS_JSON is invalid - using the default wheel');
  return DEFAULT_SPIN_SEGMENTS;
};

/** Real chance of each prize value in percent (what the user is shown). */
const spinOdds = segments => {
  const total = segments.reduce((t, s) => t + s.weight, 0);
  const byCredits = new Map();
  for (const s of segments) {
    byCredits.set(s.credits, (byCredits.get(s.credits) || 0) + s.weight);
  }
  return [...byCredits.entries()]
    .sort((a2, b2) => a2[0] - b2[0])
    .map(([credits, w]) => ({ credits, percent: Math.round((w / total) * 1000) / 10 }));
};

/**
 * Credits for one watched video, decided by the SERVER (never the app): min..max, skewed low. A uniform
 * r in [0,1) is squared, so small amounts are common and big ones rare. 10..50 -> about half the videos pay
 * 10-20, ~13 % pay 41-50, average ~24.
 */
const pickAdReward = (min, max, randomInt = crypto.randomInt) => {
  if (!(max > min)) {
    return Math.max(0, min);
  }
  const r = randomInt(0, 1000000) / 1000000;
  return Math.min(max, min + Math.floor((max - min + 1) * r * r));
};

const economy = {
  CREDITS_PER_MINUTE,
  MIN_CREDITS_TO_CALL: int('MIN_CREDITS_TO_CALL', 1000),
  WELCOME_BONUS_CREDITS: int('WELCOME_BONUS_CREDITS', 2000),
  // Each rewarded video pays a random amount between these (mostly the low end - see pickAdReward).
  AD_REWARD_MIN: int('AD_REWARD_MIN', 10),
  AD_REWARD_MAX: int('AD_REWARD_MAX', 50),
  pickAdReward,
  // 0 = no daily limit (users may watch as many rewarded videos as they like; the gap below still applies).
  MAX_AD_REWARDS_PER_DAY: int('MAX_AD_REWARDS_PER_DAY', 0),
  MIN_SECONDS_BETWEEN_AD_REWARDS: int('MIN_SECONDS_BETWEEN_AD_REWARDS', 30),
  // 0 = spin any time (every prize is collected by watching an ad). Only allowed while SPIN_NEEDS_AD is on -
  // otherwise unlimited spins would be unlimited free credits, so the server falls back to 24 h.
  FREE_SPIN_INTERVAL_HOURS: int('FREE_SPIN_INTERVAL_HOURS', 0),
  MAX_EXTRA_SPINS_PER_DAY: int('MAX_EXTRA_SPINS_PER_DAY', 5),
  // Spin prizes are collected by watching a rewarded ad (credits only after the ad). SPIN_NEEDS_AD=false = instant.
  SPIN_NEEDS_AD: process.env.SPIN_NEEDS_AD !== 'false',
  // How long a won-but-not-collected spin can still be collected.
  SPIN_CLAIM_HOURS: int('SPIN_CLAIM_HOURS', 24),
  DAILY_CHECKIN_CREDITS: int('DAILY_CHECKIN_CREDITS', 100),
  REFERRAL_BONUS_CREDITS: int('REFERRAL_BONUS_CREDITS', 5000),
  // Abuse limits
  MAX_CALLS_PER_HOUR: int('MAX_CALLS_PER_HOUR', 30),
  MAX_DISTINCT_NUMBERS_PER_DAY: int('MAX_DISTINCT_NUMBERS_PER_DAY', 50),
  MAX_CALLS_PER_NUMBER_PER_HOUR: int('MAX_CALLS_PER_NUMBER_PER_HOUR', 3),
  // 0 = off: reports are kept for the admin, nobody is blocked automatically (opt-outs are always honoured).
  REPORTS_TO_AUTOBLOCK: int('REPORTS_TO_AUTOBLOCK', 0),
  RING_TIMEOUT_SECONDS: int('RING_TIMEOUT_SECONDS', 45),
  packages: parsePackages().map(p => ({
    ...p,
    credits: p.minutes * CREDITS_PER_MINUTE,
    amountPaise: p.priceInr * 100,
  })),
  spinSegments: parseSpinSegments(),
  // Days are counted in India time for "per day" caps.
  TIMEZONE_OFFSET_MINUTES: int('TIMEZONE_OFFSET_MINUTES', 330),
};

economy.validPackage = validPackage;
economy.parsePackages = parsePackages;
economy.parseSpinSegments = parseSpinSegments;
economy.spinOdds = spinOdds;
economy.findPackage = id => economy.packages.find(p => p.id === id) || null;

module.exports = economy;
