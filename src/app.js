const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { env } = require('./config/env');
const logger = require('./utils/logger');
const { globalLimiter } = require('./middlewares/rateLimit');
const { notFound, errorHandler } = require('./middlewares/error');
const { ping } = require('./config/db');

const app = express();

app.set('trust proxy', env.TRUST_PROXY); // behind a reverse proxy / load balancer in production
app.disable('x-powered-by');

// Request id + structured request logs (auth headers redacted in logger.js)
app.use(
  pinoHttp({
    logger,
    genReqId: req => req.headers['x-request-id'] || crypto.randomUUID(),
    autoLogging: { ignore: req => req.url === '/health' },
    customProps: req => ({ reqId: req.id }),
  }),
);

app.use(helmet());

// HTTPS only in production. TLS terminates at the proxy, which sets X-Forwarded-Proto ('trust proxy'
// makes req.secure read it). A request with NO header reached the Node port directly over plain HTTP,
// so it is refused too. /health stays open for the load balancer's internal checks.
app.use((req, res, next) => {
  if (env.isProd && !req.secure && req.path !== '/health') {
    return res.status(403).json({ success: false, code: 'HTTPS_REQUIRED', message: 'Use HTTPS' });
  }
  return next();
});

// The mobile app sends no Origin header; browsers are only allowed from CORS_ORIGINS (e.g. the report website).
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || env.CORS_ORIGINS.includes(origin)),
  }),
);

// JSON (100kb) - raw body kept for webhook signature checks. Twilio posts urlencoded.
app.use(
  express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

app.get('/health', async (req, res) => {
  const db = await ping();
  res.status(db ? 200 : 503).json({
    success: db,
    data: { ok: db, db: db ? 'up' : 'down', uptime: Math.round(process.uptime()), version: env.APP_VERSION, env: env.NODE_ENV,
      commit: env.GIT_COMMIT, demoLogin: Boolean(env.DEMO_LOGIN_EMAIL && env.DEMO_LOGIN_OTP) },
  });
});

app.use(globalLimiter);

app.use('/auth', require('./routes/auth.routes'));
app.use('/me', require('./routes/me.routes'));
app.use('/wallet', require('./routes/wallet.routes'));
app.use('/ads', require('./routes/ads.routes'));
app.use('/spin', require('./routes/spin.routes'));
app.use('/orders', require('./routes/orders.routes'));
app.use('/webhooks', require('./routes/webhooks.routes'));
app.use('/voice', require('./routes/voice.routes'));
app.use('/', require('./routes/calls.routes'));
app.use('/', require('./routes/report.routes'));
app.use('/admin', require('./routes/admin.routes'));

app.use(notFound);
app.use(errorHandler);

module.exports = app;
