// Authenticator-app codes (RFC 6238 TOTP: HMAC-SHA1, 30 s steps, 6 digits) - no extra dependency.
// Secrets are kept encrypted at rest (AES-256-GCM, key derived from the server's JWT secret).
const crypto = require('crypto');
const { env } = require('../../config/env');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = buf => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
};

const base32Decode = str => {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

const generateSecret = () => base32Encode(crypto.randomBytes(20));

const codeAt = (secret, counter) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
};

/** Accepts the current code and one step either side (phone clock drift). */
const verifyTotp = (secret, code, now = Date.now()) => {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secret) {
    return false;
  }
  const step = Math.floor(now / 30000);
  return [-1, 0, 1].some(d => {
    const expected = codeAt(secret, step + d);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c));
  });
};

const otpauthUri = (secret, account, issuer = 'CallingKaro Admin') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---- encryption at rest ----
const key = () => crypto.createHash('sha256').update(`admin-totp:${env.JWT_ACCESS_SECRET}`).digest();

const encryptSecret = plain => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
};

const decryptSecret = stored => {
  if (!stored) {
    return null;
  }
  const [iv, tag, enc] = stored.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
};

module.exports = { generateSecret, verifyTotp, codeAt, otpauthUri, encryptSecret, decryptSecret, base32Encode, base32Decode };
