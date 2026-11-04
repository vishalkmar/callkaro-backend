// Tests run against a real PostgreSQL (docker: callkaro-pg, database callkaro_test).
// TEST_DATABASE_URL can point elsewhere (CI uses a postgres service container).
const { connectDB, disconnectDB, query, queryOne, getPool } = require('../src/config/db');

const TABLES = [
  'spins',
  'ad_rewards',
  'ad_sessions',
  'ledger_entries',
  'wallets',
  'orders',
  'calls',
  'reports',
  'blocked_numbers',
  'caller_numbers',
  'sessions',
  'otps',
  'users',
];

let started = false;

const startDb = async () => {
  if (!started) {
    await connectDB(process.env.DATABASE_URL, { retries: 1, runMigrations: false });
    // Fresh schema for every test file run.
    await query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const { migrate } = require('../src/config/db');
    await migrate();
    started = true;
  }
};

const stopDb = async () => {
  if (started) {
    await disconnectDB();
    started = false;
  }
};

const clearDb = async () => {
  await getPool().query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
};

/** Creates a user + wallet + session and returns { user, token, refreshToken }. */
const createUser = async ({ email = `u${Date.now()}${Math.random()}@test.local`, credits = 0, deviceId = 'device-1' } = {}) => {
  const walletService = require('../src/services/wallet.service');
  const { createSession } = require('../src/services/token.service');
  const user = await queryOne('INSERT INTO users (email, device_id, device_ids) VALUES ($1, $2, ARRAY[$2]) RETURNING *', [
    email.toLowerCase(),
    deviceId,
  ]);
  await walletService.ensureWallet(user.id);
  if (credits) {
    await walletService.applyChange(user.id, credits, 'admin_adjust', `seed:${user.id}`);
  }
  const tokens = await createSession({ userId: user.id, deviceId });
  return { user, token: tokens.accessToken, refreshToken: tokens.refreshToken };
};

const credits = async userId => Number((await queryOne('SELECT credits FROM wallets WHERE user_id = $1', [userId])).credits);

module.exports = { startDb, stopDb, clearDb, createUser, credits, query, queryOne };
