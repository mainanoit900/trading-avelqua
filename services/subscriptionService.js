const { query, getClient } = require('../config/database');
const { onPackageActivated } = require('../lib/mt5PackagePorts');
const { applyPaidPackageSubscription } = require('../lib/subscriptionPackage');

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

    const pkgRes = await client.query(`SELECT * FROM packages WHERE id = $1 LIMIT 1`, [payment.package_id]);
    const pkgRow = pkgRes.rows[0] || {
      id: payment.package_id,
      days: asNumber(payment.days || payment.package_days, 0),
      name_th: payment.package_name_label || payment.package_name_snapshot || 'Package',
      group_name: payment.package_group || payment.group_name || ''
    };

    const applied = await applyPaidPackageSubscription({
      client,
      userId: payment.user_id,
      packageRow: pkgRow,
      sourceChannel: `payment:${payment.id}`
    });

    if (!applied?.subscriptionId) {
      throw new Error('SUBSCRIPTION_APPLY_FAILED');
    }

    await client.query(
      `UPDATE user_subscriptions
       SET lot_min = $2,
           lot_max = $3,
           ports_min = $4,
           ports_max = $5,
           profit_min = $6,
           profit_max = $7,
           profit_label = $8,
           updated_at = NOW()
       WHERE id = $1`,
      [
        applied.subscriptionId,
        asNumber(payment.lot_min, 0),
        asNumber(payment.lot_max, 0),
        asNumber(payment.ports_min, 0),
        asNumber(payment.ports_max, 0),
        payment.profit_min,
        payment.profit_max,
        payment.package_profit_label || ''
      ]
    );

    const startAt = applied.startDate;
    const endAt = applied.endDate;
    const insertRes = { rows: [{ id: applied.subscriptionId }] };

    if (payment.coupon_id) {
      await client.query(
        `INSERT INTO coupon_usages (coupon_id, user_id, payment_id, note)
         VALUES ($1, $2, $3, $4)`,
        [payment.coupon_id, payment.user_id, payment.id, 'used after payment completed']
      ).catch(() => null);
    }

    await client.query('COMMIT');

    await onPackageActivated(payment.user_id).catch(() => {});

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
  const { runPackageExpirySweep } = require('./packageExpiryWorker');
  return runPackageExpirySweep();
}

module.exports = {
  getLatestSubscription,
  getActiveSubscription,
  activateSubscriptionFromPayment,
  expireSubscriptionsAndStopBots
};
