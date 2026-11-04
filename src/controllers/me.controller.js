const economy = require('../config/economy');
const { queryOne, tx } = require('../config/db');
const { ok } = require('../utils/response');
const { publicUser } = require('../utils/serialize');
const { minutesForCredits } = require('../services/billing.service');
const walletService = require('../services/wallet.service');

const getMe = async (req, res) => {
  const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const wallet = await walletService.getWallet(req.user.id);
  const talk = await queryOne(
    'SELECT COALESCE(SUM(talk_seconds), 0)::int AS seconds, COUNT(*)::int AS calls FROM calls WHERE user_id = $1 AND billed = TRUE',
    [req.user.id],
  );
  return ok(res, {
    user: publicUser(user),
    stats: {
      totalTalkSeconds: talk.seconds,
      totalMinutesUsed: Math.ceil(talk.seconds / 60),
      totalCalls: talk.calls,
    },
    flags: {
      rewardsDisabled: !!user.rewards_disabled,
      canCall: wallet.credits >= economy.MIN_CREDITS_TO_CALL,
      minutes: minutesForCredits(wallet.credits),
    },
  });
};

const updateMe = async (req, res) => {
  const user = await queryOne('UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING *', [req.user.id, req.body.name]);
  return ok(res, { user: publicUser(user) });
};

/**
 * DELETE /me - anonymises the profile and revokes sessions. Billing/call metadata is kept
 * (legally required) but detached from the email. Device ids are kept so the welcome bonus
 * cannot be farmed by delete + sign up again.
 */
const deleteMe = async (req, res) => {
  const uid = req.user.id;
  await tx(async c => {
    await c.q(
      `UPDATE users SET status = 'deleted', email = 'deleted+' || id || '@deleted.invalid', name = '',
         referral_code = NULL, deleted_at = now(), updated_at = now() WHERE id = $1`,
      [uid],
    );
    await c.q('DELETE FROM sessions WHERE user_id = $1', [uid]);
  });
  return ok(res, { deleted: true });
};

module.exports = { getMe, updateMe, deleteMe };
