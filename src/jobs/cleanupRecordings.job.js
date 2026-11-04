const { env } = require('../config/env');
const { query } = require('../config/db');
const voice = require('../services/voice.service');
const { purgeExpired } = require('../services/auth.service');
const logger = require('../utils/logger');

/**
 * 1) Deletes provider copies of recordings older than RECORDING_RETENTION_DAYS (users keep their downloaded copy).
 * 2) Anonymises call metadata older than CALL_METADATA_RETENTION_DAYS (the legally required retention period).
 * 3) Purges expired OTP rows / old sessions (Postgres has no TTL index).
 */
const run = async () => {
  const toDelete = await query(
    `SELECT id, call_sid, recording_sid FROM calls
      WHERE recording_sid IS NOT NULL AND recording_deleted_at IS NULL
        AND started_at <= now() - ($1 || ' days')::interval LIMIT 500`,
    [String(env.RECORDING_RETENTION_DAYS)],
  );
  let deleted = 0;
  for (const c of toDelete) {
    try {
      await voice.rest().recordings(c.recording_sid).remove();
    } catch (e) {
      if (e.status !== 404) {
        logger.error({ callSid: c.call_sid, err: e.message }, 'recording delete failed');
        continue;
      }
    }
    await query('UPDATE calls SET recording_deleted_at = now(), recording_url = NULL WHERE id = $1', [c.id]);
    deleted += 1;
  }

  const anon = await query(
    `UPDATE calls SET to_number = 'REDACTED', anonymized = TRUE
      WHERE anonymized = FALSE AND started_at <= now() - ($1 || ' days')::interval RETURNING id`,
    [String(env.CALL_METADATA_RETENTION_DAYS)],
  );
  await purgeExpired();
  logger.info({ recordingsDeleted: deleted, callsAnonymized: anon.length }, 'cleanup job done');
  return { deleted, anonymized: anon.length };
};

module.exports = { run };
