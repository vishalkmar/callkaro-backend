// Admin API client: same origin, cookie session (httpOnly - JavaScript never sees it), CSRF header on every call.
const BASE = '/admin-api';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.data = body?.data;
  }
}

let onSignedOut = () => {};
export const setSignedOutHandler = fn => {
  onSignedOut = fn;
};

export const api = async (path, { method = 'GET', body, query } = {}) => {
  const qs = query
    ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString()}`
    : '';
  const res = await fetch(`${BASE}${path}${qs}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Admin-Panel': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    // empty / non-JSON body
  }
  if (!res.ok || json?.success === false) {
    if (res.status === 401 && json?.code === 'ADMIN_SESSION') {
      onSignedOut();
    }
    throw new ApiError(res.status, json);
  }
  return json?.data;
};

// ---- formatting (Indian locale) ----
export const num = n => Number(n || 0).toLocaleString('en-IN');
export const inr = n => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const dt = s =>
  s
    ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : '—';
export const dayIST = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const LEDGER_LABEL = {
  purchase: 'Purchase',
  ad_reward: 'Video reward',
  spin_reward: 'Spin prize',
  welcome_bonus: 'Welcome bonus',
  checkin_reward: 'Daily check-in',
  referral_bonus: 'Referral bonus',
  call_charge: 'Call charge',
  refund: 'Refund',
  payment_reversal: 'Payment reversal',
  admin_adjust: 'Admin adjustment',
};
