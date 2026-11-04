const crypto = require('crypto');
const axios = require('axios');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * AdMob rewarded-ad Server-Side Verification.
 * Google signs the query string (everything before "&signature=") with ECDSA/SHA-256.
 * Public keys: https://www.gstatic.com/admob/reward/verifier-keys.json (cached 24h).
 */
let keyCache = { keys: null, fetchedAt: 0 };
let lastForcedAt = 0;
let inFlight = null;

const fetchKeys = async (force = false) => {
  if (!force && keyCache.keys && Date.now() - keyCache.fetchedAt < 24 * 3600 * 1000) {
    return keyCache.keys;
  }
  // One download at a time; parallel callbacks share it.
  if (!inFlight) {
    inFlight = axios
      .get(env.ADMOB_SSV_KEYS_URL, { timeout: 8000 })
      .then(res => {
        const map = new Map();
        for (const k of res.data.keys || []) {
          map.set(String(k.keyId), k.pem);
        }
        keyCache = { keys: map, fetchedAt: Date.now() };
        return map;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};

// Test hook
const setKeysForTest = (map, fetchedAt = Date.now()) => {
  keyCache = { keys: map, fetchedAt };
  lastForcedAt = 0;
};

const fromWebSafeBase64 = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * @param rawQuery the raw query string exactly as received (req.originalUrl after '?')
 * @returns { valid, params, reason }
 */
const verifySsv = async rawQuery => {
  const sigIndex = rawQuery.indexOf('&signature=');
  if (sigIndex < 0) {
    return { valid: false, reason: 'no_signature' };
  }
  const message = rawQuery.slice(0, sigIndex);
  const params = Object.fromEntries(new URLSearchParams(rawQuery));
  const { signature, key_id: keyId } = params;
  if (!signature || !keyId) {
    return { valid: false, reason: 'missing_fields', params };
  }
  let keys = await fetchKeys();
  // Google rotates keys: refetch on an unknown key id, but at most once a minute so forged
  // requests with random key ids cannot make us hammer Google.
  if (!keys.has(String(keyId)) && Date.now() - lastForcedAt > 60 * 1000) {
    lastForcedAt = Date.now();
    keys = await fetchKeys(true);
  }
  const pem = keys.get(String(keyId));
  if (!pem) {
    return { valid: false, reason: 'unknown_key', params };
  }
  try {
    const valid = crypto.verify('sha256', Buffer.from(message, 'utf8'), pem, fromWebSafeBase64(signature));
    return { valid, params, reason: valid ? null : 'bad_signature' };
  } catch (e) {
    logger.warn({ err: e.message }, 'ssv verify error');
    return { valid: false, reason: 'verify_error', params };
  }
};

module.exports = { verifySsv, fetchKeys, setKeysForTest };
