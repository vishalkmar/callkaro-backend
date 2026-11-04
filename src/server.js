const { env, validate } = require('./config/env');

validate(); // exits with a clear message when required env vars are missing

const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const app = require('./app');
const { syncCallerPool } = require('./services/voice.service');
const { startJobs } = require('./jobs');

const start = async () => {
  await connectDB(env.DATABASE_URL);
  await syncCallerPool();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(`CallKaro API listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  });
  if (process.env.DISABLE_JOBS !== 'true') {
    startJobs();
  }

  const shutdown = signal => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

process.on('unhandledRejection', err => logger.error({ err: err?.message }, 'unhandledRejection'));

start().catch(err => {
  logger.error({ err: err.message }, 'failed to start');
  process.exit(1);
});
