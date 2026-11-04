const { validateCallable, toE164India, maskNumber } = require('../src/utils/phone');

describe('server number rules (authoritative copy of the app rules)', () => {
  test.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['022 2345 6789', '+912223456789'], // Mumbai landline
    ['0522 234 5678', '+915222345678'], // Lucknow landline
    ['0172 234 5678', '+911722345678'], // Chandigarh landline
  ])('%s is callable as %s', (raw, e164) => {
    expect(validateCallable(raw)).toEqual({ ok: true, e164, reason: null });
  });

  test.each(['100', '112', '108', '1098', '1930', '139'])('%s -> emergency / phone dialer', raw => {
    expect(validateCallable(raw).reason).toBe('emergency');
  });

  test.each(['1800123456', '+91 1800 123 456', '18601234567', '1900123456'])('%s toll-free/special is refused', raw => {
    expect(validateCallable(raw).ok).toBe(false);
  });

  test.each(['98765432', '+1 202 555 0101', '+91112', '0876543210', 'abc'])('%s is refused', raw => {
    expect(validateCallable(raw).ok).toBe(false);
  });

  test('helpers', () => {
    expect(toE164India('   ')).toBeNull();
    expect(maskNumber('+919876543210')).toBe('+9198*****10');
  });
});
