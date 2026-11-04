const { chargeForSeconds, chargePerMinutePulse, maxSecondsForCredits, minutesForCredits, canStartCall } = require('../src/services/billing.service');

describe('billing math (1000 credits = 1 minute, per-second)', () => {
  test.each([
    [0, 0],
    [1, 17],
    [59, 984],
    [60, 1000],
    [61, 1017],
    [135, 2250],
  ])('%ss talk -> %s credits', (secs, credits) => {
    expect(chargeForSeconds(secs)).toBe(credits);
  });

  test('negative / garbage input never charges', () => {
    expect(chargeForSeconds(-5)).toBe(0);
    expect(chargeForSeconds('abc')).toBe(0);
  });

  test('maxSeconds = floor(credits * 60 / 1000)', () => {
    expect(maxSecondsForCredits(1000)).toBe(60);
    expect(maxSecondsForCredits(999)).toBe(59);
    expect(maxSecondsForCredits(2250)).toBe(135);
    expect(maxSecondsForCredits(0)).toBe(0);
    expect(maxSecondsForCredits(-10)).toBe(0);
  });

  test('a call that uses exactly maxSeconds never costs more than the balance', () => {
    for (const credits of [1000, 1017, 1500, 2999, 80000]) {
      expect(chargeForSeconds(maxSecondsForCredits(credits))).toBeLessThanOrEqual(credits);
    }
  });

  test('minutes and call gate', () => {
    expect(minutesForCredits(80000)).toBe(80);
    expect(minutesForCredits(1999)).toBe(1);
    expect(canStartCall(999)).toBe(false);
    expect(canStartCall(1000)).toBe(true);
  });

  test('alternative per-minute pulse (documented, not active)', () => {
    expect(chargePerMinutePulse(1)).toBe(1000);
    expect(chargePerMinutePulse(60)).toBe(1000);
    expect(chargePerMinutePulse(61)).toBe(2000);
  });
});
