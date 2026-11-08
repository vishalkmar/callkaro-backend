const router = require('express').Router();
const Joi = require('joi');
const validate = require('../middlewares/validate');
const { requireAuth } = require('../middlewares/auth');
const { twilioSignature, telnyxSignature } = require('../middlewares/providerSignature');
const telnyx = require('../services/telnyx.service');
const { voiceTokenLimiter } = require('../middlewares/rateLimit');
const voice = require('../services/voice.service');
const { ok } = require('../utils/response');
const logger = require('../utils/logger');

const twiml = handler => async (req, res) => {
  try {
    const xml = await handler(req.body || {});
    res.type('text/xml').send(xml);
  } catch (e) {
    logger.error({ err: e.message }, 'voice webhook error');
    res
      .type('text/xml')
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Please try again.</Say><Hangup/></Response>');
  }
};

// ---- App (JWT) ----
router.get('/token', requireAuth, voiceTokenLimiter, async (req, res) => ok(res, await voice.createAccessToken(req.user)));

const callSidBody = validate({ body: Joi.object({ callSid: Joi.string().pattern(/^(CA|TX)[a-f0-9]{32}$/).required() }) });
router.post('/recording/start', requireAuth, callSidBody, async (req, res) =>
  ok(res, await voice.startRecording(req.user.id, req.body.callSid)),
);
router.post('/recording/stop', requireAuth, callSidBody, async (req, res) =>
  ok(res, await voice.stopRecording(req.user.id, req.body.callSid)),
);

// ---- Provider webhooks (X-Twilio-Signature validated on every request) ----
router.post('/outbound', twilioSignature, twiml(voice.handleOutbound));
router.post(
  '/status',
  twilioSignature,
  twiml(async body => {
    await voice.handleStatus(body);
    return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  }),
);
router.post('/dial-complete', twilioSignature, twiml(voice.handleDialComplete));
router.post('/answer-hook', twilioSignature, twiml(voice.handleAnswerHook));
router.post('/inbound', twilioSignature, twiml(voice.handleInbound));
router.post('/inbound/optout', twilioSignature, twiml(voice.handleInboundOptOut));
router.post(
  '/recording-status',
  twilioSignature,
  twiml(async body => {
    await voice.handleRecordingStatus(body);
    return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  }),
);

// ---- Telnyx (USE_TELNYX=true): Ed25519-signed JSON webhooks; always 200 so Telnyx does not retry forever ----
router.post('/telnyx/webhook', telnyxSignature, async (req, res) => {
  try {
    await telnyx.handleWebhook(req.body);
  } catch (e) {
    logger.error({ err: e.message, event: req.body?.data?.event_type }, 'telnyx webhook error');
  }
  res.status(200).json({ received: true });
});

module.exports = router;
