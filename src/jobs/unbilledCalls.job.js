const { query } = require('../config/db');
const voice = require('../services/voice.service');
const telnyx = require('../services/telnyx.service');
const alerts = require('../services/alert.service');
const logger = require('../utils/logger');

/**
 * Safety net for billing. Finds calls that ended (or are clearly stale) but were never billed -
 * e.g. the dial-complete webhook failed or the server was down - and bills them from the
 * provider's own record. Runs every 10 minutes and as the nightly sweep.
 */
const run = async ({ olderThanMinutes = 5, limit = 200 } = {}) => {
  const stale = await query(
    `SELECT * FROM calls
      WHERE billed = FALSE AND status NOT IN ('blocked', 'insufficient-credit')
        AND started_at <= now() - ($1 || ' minutes')::interval AND billing_attempts < 10
      ORDER BY started_at LIMIT $2`,
    [String(olderThanMinutes), limit],
  );

  let billed = 0;
  let failed = 0;
  for (const c of stale) {
    try {
      let dialStatus = c.status;
      let dialSeconds = c.talk_seconds || 0;
      if (c.provider === 'telnyx') {
        // Telnyx keeps no "duration" for us to read back: a lost hangup webhook means the end time is unknown.
        // Never guess against the user - bill what we know (or 0) and tell the admin.
        if (c.child_call_sid && (await telnyx.isLegAlive(c.child_call_sid))) {
          continue; // still running (long call)
        }
        const known = c.answered_at && c.ended_at ? Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000) : 0;
        if (c.answered_at && !c.ended_at) {
          await alerts.notify(`Telnyx call ${c.call_sid} ended without a hangup webhook - billed 0, check Telnyx CDR`, {
            dedupeKey: `telnyx-lost-${c.call_sid}`,
          });
        }
        dialStatus = c.answered_at ? 'completed' : 'no-answer';
        dialSeconds = known;
      } else if (c.child_call_sid) {
        // Ask the provider for the real result of the PSTN leg.
        const child = await voice.rest().calls(c.child_call_sid).fetch();
        if (['queued', 'ringing', 'in-progress'].includes(child.status)) {
          continue; // still running (long call)
        }
        dialStatus = child.status;
        dialSeconds = parseInt(child.duration, 10) || 0;
      } else if (['initiated', 'ringing'].includes(c.status)) {
        dialStatus = 'no-answer';
        dialSeconds = 0;
      }
      const r = await voice.billCall({ callSid: c.call_sid, dialStatus, dialSeconds });
      if (r?.billed) {
        billed += 1;
      } else {
        failed += 1;
      }
    } catch (e) {
      failed += 1;
      await query('UPDATE calls SET billing_attempts = billing_attempts + 1, billing_error = $2 WHERE id = $1', [c.id, e.message]);
      logger.error({ callSid: c.call_sid, err: e.message }, 'unbilled job: failed');
    }
  }
  if (failed > 0) {
    await alerts.notify(`Unbilled-calls job: ${failed} call(s) could not be billed`, { dedupeKey: 'unbilled-failed' });
  }
  if (stale.length) {
    logger.info({ found: stale.length, billed, failed }, 'unbilled calls job done');
  }
  return { found: stale.length, billed, failed };
};

module.exports = { run };
