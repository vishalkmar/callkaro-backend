const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const logger = require('../utils/logger');

// pg returns BIGINT (int8) as string by default; credits always fit in a JS safe integer.
require('pg').types.setTypeParser(20, v => Number(v));

let pool = null;

const needsSsl = url => /neon\.tech|sslmode=require/.test(url || '');

/** Creates the pool (Neon needs SSL; local Docker Postgres does not). */
const createPool = url => {
  pool = new Pool({
    connectionString: url,
    ssl: needsSsl(url) ? { rejectUnauthorized: true } : false,
    max: Number(process.env.DB_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', err => logger.error({ err: err.message }, 'postgres pool error'));
  return pool;
};

const getPool = () => {
  if (!pool) {
    throw new Error('Database not connected - call connectDB() first');
  }
  return pool;
};

/** query(sql, params) -> rows */
const query = async (sql, params = []) => (await getPool().query(sql, params)).rows;
const queryOne = async (sql, params = []) => (await getPool().query(sql, params)).rows[0] || null;

/**
 * Runs fn(client) inside BEGIN/COMMIT. `client.q(sql, params)` returns rows.
 * Any throw rolls back. Used for every money change.
 */
const tx = async fn => {
  const client = await getPool().connect();
  client.q = async (sql, params = []) => (await client.query(sql, params)).rows;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

/** Applies migrations/*.sql in order, once each (tracked in schema_migrations). */
const migrate = async () => {
  const dir = path.join(__dirname, '..', '..', 'migrations');
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await query('SELECT name FROM schema_migrations')).map(r => r.name));
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    await tx(async c => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    logger.info({ migration: f }, 'migration applied');
  }
};

/** Connect with retry + exponential backoff, then run migrations. */
const connectDB = async (url, { retries = 10, runMigrations = true } = {}) => {
  createPool(url);
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await query('SELECT 1');
      logger.info({ ssl: needsSsl(url) }, 'Postgres connected');
      break;
    } catch (err) {
      attempt += 1;
      if (attempt > retries) {
        logger.error({ err: err.message }, 'Postgres connection failed - giving up');
        throw err;
      }
      const wait = Math.min(30000, 1000 * 2 ** attempt);
      logger.warn({ attempt, wait, err: err.message }, 'Postgres connection failed - retrying');
      await new Promise(r => setTimeout(r, wait));
    }
  }
  if (runMigrations) {
    await migrate();
  }
  return pool;
};

const ping = async () => {
  try {
    await query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
};

const disconnectDB = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

module.exports = { connectDB, disconnectDB, query, queryOne, tx, migrate, ping, getPool };
