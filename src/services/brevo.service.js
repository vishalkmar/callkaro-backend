const axios = require('axios');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const { errors } = require('../utils/response');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const otpEmailHtml = ({ appName, code, minutes }) => `<!doctype html>
<html><body style="margin:0;background:#F1F3F2;font-family:Arial,Helvetica,sans-serif;color:#222831">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="420" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden">
        <tr><td style="background:#FF7A45;padding:18px 24px;color:#ffffff;font-size:20px;font-weight:bold">${escapeHtml(appName)}</td></tr>
        <tr><td style="padding:24px">
          <p style="margin:0 0 12px;font-size:15px">Your login code is:</p>
          <p style="margin:0 0 16px;font-size:34px;letter-spacing:8px;font-weight:bold;color:#222831">${escapeHtml(code)}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#6B7280">This code is valid for ${minutes} minutes. Do not share it with anyone - ${escapeHtml(appName)} staff will never ask for it.</p>
          <p style="margin:0;font-size:13px;color:#6B7280">If you did not try to sign in, you can safely ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

/** Sends the OTP email through Brevo's transactional API. Throws a friendly error on failure. */
const sendOtpEmail = async ({ to, code }) => {
  const payload = {
    sender: { email: env.BREVO_SENDER_EMAIL, name: env.BREVO_SENDER_NAME },
    to: [{ email: to }],
    subject: `${code} is your ${env.BREVO_SENDER_NAME} login code`,
    htmlContent: otpEmailHtml({ appName: env.BREVO_SENDER_NAME, code, minutes: env.OTP_TTL_MINUTES }),
    textContent: `Your ${env.BREVO_SENDER_NAME} login code is ${code}. It is valid for ${env.OTP_TTL_MINUTES} minutes. If you did not request it, ignore this email.`,
    tags: ['otp'],
  };
  try {
    await axios.post(BREVO_URL, payload, {
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      timeout: 10000,
    });
  } catch (e) {
    // Log the failure (status + Brevo error code) but never the code itself.
    // Brevo's own message tells a wrong key, an unauthorised IP and an unverified sender apart (no secrets in it).
    logger.error(
      { status: e.response?.status, brevo: e.response?.data?.code, brevoMessage: e.response?.data?.message, msg: e.message },
      'Brevo send failed',
    );
    throw errors.unavailable('EMAIL_SEND_FAILED', 'Could not send code, try again');
  }
};

module.exports = { sendOtpEmail, otpEmailHtml };
