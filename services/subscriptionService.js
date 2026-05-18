const { query, getClient } = require('../config/database');

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function getLatestSubscription(userId) {
  const result = await query(
    `SELECT s.*, p.name_th, p.name_en, p.group_name
     FROM user_subscriptions s
     LEFT JOIN packages p ON p.id = s.package_id
     WHERE s.user_id = $1
     ORDER BY COALESCE(s.end_at, s.created_at) DESC NULLS LAST, s.id DESC
     LIMIT 1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function getActiveSubscription(userId) {
  const result = await query(
    `SELECT s.*, p.name_th, p.name_en, p.group_name
     FROM user_subscriptions s
     LEFT JOIN packages p ON p.id = s.package_id
     WHERE s.user_id = $1
       AND s.status = 'active'
       AND (s.end_at IS NULL OR s.end_at > NOW())
     ORDER BY COALESCE(s.end_at, s.created_at) DESC NULLS LAST, s.id DESC
     LIMIT 1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function activateSubscriptionFromPayment(paymentId) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const paymentRes = await client.query(
      `SELECT
         p.*,
         pk.days,
         pk.lot_min,
         pk.lot_max,
         pk.ports_min,
         pk.ports_max,
         pk.profit_min,
         pk.profit_max,
         COALESCE(NULLIF(pk.name_th, ''), pk.name_en, p.package_name_snapshot, 'Package') AS package_name_label,
         COALESCE(NULLIF(pk.profit_label_th, ''), pk.profit_label_en, '') AS package_profit_label
       FROM payments p
       LEFT JOIN packages pk ON pk.id = p.package_id
       WHERE p.id = $1
       FOR UPDATE`,
      [paymentId]
    );

    const payment = paymentRes.rows[0];

    if (!payment) {
      throw new Error('PAYMENT_NOT_FOUND');
    }

    if (payment.payment_status !== 'paid') {
      throw new Error('PAYMENT_NOT_PAID');
    }

    const existingRes = await client.query(
      `SELECT id
       FROM user_subscriptions
       WHERE source_channel = $1
       LIMIT 1`,
      [`payment:${payment.id}`]
    );

    if (existingRes.rows[0]) {
      await client.query('COMMIT');
      return {
        ok: true,
        alreadyApplied: true,
        subscriptionId: existingRes.rows[0].id
      };
    }

    const activeRes = await client.query(
      `SELECT *
       FROM user_subscriptions
       WHERE user_id = $1
         AND status = 'active'
         AND (end_at IS NULL OR end_at > NOW())
       ORDER BY COALESCE(end_at, created_at) DESC NULLS LAST, id DESC
       LIMIT 1
       FOR UPDATE`,
      [payment.user_id]
    );

    const active = activeRes.rows[0] || null;
    const packageDays = asNumber(payment.days || payment.package_days, 0);
    const startAt = active && active.end_at ? new Date(active.end_at) : new Date();
    const endAt = new Date(startAt.getTime() + (packageDays * 24 * 60 * 60 * 1000));

    const insertRes = await client.query(
      `INSERT INTO user_subscriptions (
         user_id,
         package_id,
         package_name_snapshot,
         source_channel,
         status,
         start_at,
         end_at,
         lot_min,
         lot_max,
         ports_min,
         ports_max,
         profit_min,
         profit_max,
         profit_label
       )
       VALUES (
         $1, $2, $3, $4, 'active',
         $5, $6, $7, $8, $9, $10, $11, $12, $13
       )
       RETURNING id`,
      [
        payment.user_id,
        payment.package_id,
        payment.package_name_label || payment.package_name_snapshot || 'Package',
        `payment:${payment.id}`,
        startAt,
        endAt,
        asNumber(payment.lot_min, 0),
        asNumber(payment.lot_max, 0),
        asNumber(payment.ports_min, 0),
        asNumber(payment.ports_max, 0),
        payment.profit_min,
        payment.profit_max,
        payment.package_profit_label || ''
      ]
    );

    if (payment.coupon_id) {
      await client.query(
        `INSERT INTO coupon_usages (coupon_id, user_id, payment_id, note)
         VALUES ($1, $2, $3, $4)`,
        [payment.coupon_id, payment.user_id, payment.id, 'used after payment completed']
      ).catch(() => null);
    }

    await client.query('COMMIT');

    return {
      ok: true,
      subscriptionId: insertRes.rows[0].id,
      startAt,
      endAt
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

async function expireSubscriptionsAndStopBots() {
  await query(
    `UPDATE user_subscriptions
     SET status = 'expired',
         updated_at = NOW()
     WHERE status = 'active'
       AND end_at IS NOT NULL
       AND end_at <= NOW()`
  );

  const stopped = await query(
    `UPDATE bot_sessions bs
     SET status = 'stopped',
         stopped_at = NOW(),
         updated_at = NOW()
     WHERE bs.status = 'running'
       AND NOT EXISTS (
         SELECT 1
         FROM user_subscriptions s
         WHERE s.user_id = bs.user_id
           AND s.status = 'active'
           AND (s.end_at IS NULL OR s.end_at > NOW())
       )
     RETURNING id`
  );

  return {
    stoppedCount: stopped.rowCount
  };
}

module.exports = {
  getLatestSubscription,
  getActiveSubscription,
  activateSubscriptionFromPayment,
  expireSubscriptionsAndStopBots
};
