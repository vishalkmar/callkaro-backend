// Reconciliation: for every user, sum(ledger.amount) must equal wallet.credits.
// Usage: npm run reconcile   (exit code 1 when mismatches are found)
const { env, validate } = require('../src/config/env');

validate();
const { connectDB, disconnectDB } = require('../src/config/db');
const { reconcileAll } = require('../src/services/wallet.service');

(async () => {
  await connectDB(env.DATABASE_URL, { retries: 2 });
  const mismatches = await reconcileAll();
  if (mismatches.length) {
    // eslint-disable-next-line no-console
    console.table(mismatches);
  } else {
    // eslint-disable-next-line no-console
    console.log('OK - every wallet matches its ledger');
  }
  await disconnectDB();
  process.exit(mismatches.length ? 1 : 0);
})();
