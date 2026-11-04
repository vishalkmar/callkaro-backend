// Applies pending SQL migrations (migrations/*.sql) to DATABASE_URL.  npm run migrate
const { env, validate } = require('../src/config/env');

validate();
const { connectDB, disconnectDB } = require('../src/config/db');

(async () => {
  await connectDB(env.DATABASE_URL, { retries: 2, runMigrations: true });
  // eslint-disable-next-line no-console
  console.log('migrations up to date');
  await disconnectDB();
})().catch(e => {
  // eslint-disable-next-line no-console
  console.error(e.message);
  process.exit(1);
});
