// Server-side number rules (mirror of the app, but the server is the one that enforces them).

const EMERGENCY = ['100', '101', '102', '108', '112', '1091', '1098', '181', '1930'];

const digits = s => String(s || '').replace(/\D/g, '');

/** Normalise Indian input to E.164 (+91XXXXXXXXXX) or return null. */
const toE164India = raw => {
  const s = String(raw || '').trim();
  let d = digits(s);
  if (s.startsWith('+')) {
    return /^91\d{10}$/.test(d) ? `+${d}` : null;
  }
  if (d.startsWith('00')) {
    d = d.slice(2);
  }
  if (d.length === 12 && d.startsWith('91')) {
    return `+${d}`;
  }
  if (d.length === 11 && d.startsWith('0')) {
    return `+91${d.slice(1)}`;
  }
  if (d.length === 10) {
    return `+91${d}`;
  }
  return null;
};

const isIndianMobile = e164 => /^\+91[6-9]\d{9}$/.test(e164 || '');
// Landlines: +91 + STD code without the trunk 0 + subscriber = 10 digits (e.g. Delhi 11..., Mumbai 22...).
// Some STD codes start with 6-8 too (Bangalore 80...), those already match the 10-digit mobile pattern.
const isIndianLandline = e164 => /^\+91[1-5]\d{9}$/.test(e164 || '');
// Toll-free (1800) and special/premium (1860, 1900) ranges are not reachable over VoIP termination.
const isPremium = e164 => /^\+91(1800|1860|1900)/.test(e164 || '');
const isShortOrEmergency = raw => {
  const d = digits(raw);
  return EMERGENCY.includes(d) || (d.startsWith('1') && d.length <= 5);
};

/** { ok, e164, reason } reason: emergency | invalid | premium */
const validateCallable = raw => {
  if (isShortOrEmergency(raw)) {
    return { ok: false, e164: null, reason: 'emergency' };
  }
  const e164 = toE164India(raw);
  if (!e164 || !(isIndianMobile(e164) || isIndianLandline(e164))) {
    return { ok: false, e164, reason: 'invalid' };
  }
  if (isPremium(e164)) {
    return { ok: false, e164, reason: 'premium' };
  }
  return { ok: true, e164, reason: null };
};

const maskNumber = e164 => (e164 ? `${e164.slice(0, 5)}*****${e164.slice(-2)}` : '');

module.exports = { toE164India, isIndianMobile, isIndianLandline, isPremium, isShortOrEmergency, validateCallable, maskNumber };
