// Run a background job once by hand: node scripts/runJob.js unbilled|cleanup|spend
const { env, validate } = require('../src/config/env');

validate();
const { connectDB, disconnectDB } = require('../src/config/db');

const JOBS = {
  unbilled: () => require('../src/jobs/unbilledCalls.job').run({ olderThanMinutes: 5, limit: 5000 }),
  cleanup: () => require('../src/jobs/cleanupRecordings.job').run(),
  spend: () => require('../src/jobs/spendGuard.job').run(),
};

(async () => {
  const name = process.argv[2];
  if (!JOBS[name]) {
    // eslint-disable-next-line no-console
    console.error(`usage: node scripts/runJob.js ${Object.keys(JOBS).join('|')}`);
    process.exit(1);
  }
  await connectDB(env.DATABASE_URL, { retries: 2 });
  // eslint-disable-next-line no-console
  console.log(await JOBS[name]());
  await disconnectDB();
})();
