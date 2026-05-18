'use strict';

/**
 * เปิดใช้แพ็กเกจหลังชำระเงิน — subscription เดียวที่ active, ต่อวันเมื่อ tier เดิม
 */

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function runQuery(client, sql, params) {
  if (client && typeof client.query === 'function') return client.query(sql, params);
  const { query } = require('../config/database');
  return query(sql, params);
}

async function getSubscriptionRowForRenewal(client, userId) {
  const active = await runQuery(
    client,
    `
    SELECT *
    FROM user_subscriptions
    WHERE user_id = $1
      AND (end_at IS NULL OR end_at > NOW())
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT 1
  `,
    [userId]
  );
  if (active.rows[0]) return active.rows[0];

  const latest = await runQuery(
    client,
    `SELECT * FROM user_subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  return latest.rows[0] || null;
}

function computeSubscriptionDates(oldSub, pkg, now = new Date()) {
  const packageChanged =
    !!oldSub && num(oldSub.package_id, 0) > 0 && num(oldSub.package_id) !== num(pkg.id);

  const startDate = new Date(now);
  let endDate = new Date(now);

  if (oldSub && oldSub.end_at && new Date(oldSub.end_at) > now) {
    endDate = new Date(oldSub.end_at);
  }

  endDate.setDate(endDate.getDate() + num(pkg.days, 0));
  return { startDate, endDate, packageChanged };
}

function packageNameSnapshot(pkg) {
  return pkg.name_th || pkg.name_en || pkg.name || 'Package';
}

function packageGroupSnapshot(pkg) {
  return String(pkg.group_name || pkg.package_group || pkg.package_code || '')
    .trim()
    .toUpperCase();
}

/** ปิด subscription อื่นที่ยังไม่หมด — เหลือแถวที่เพิ่งซื้อ/ต่อเท่านั้น */
async function supersedeOtherSubscriptions(userId, keepSubscriptionId, client = null) {
  const uid = num(userId);
  const keepId = num(keepSubscriptionId);
  if (!uid || !keepId) return 0;

  const res = await runQuery(
    client,
    `
    UPDATE user_subscriptions
    SET status = 'expired',
        updated_at = NOW()
    WHERE user_id = $1
      AND id <> $2
      AND (end_at IS NULL OR end_at > NOW())
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
  `,
    [uid, keepId]
  ).catch(() => ({ rowCount: 0 }));

  return res.rowCount || 0;
}

/**
 * @returns {Promise<{ subscriptionId: number, startDate: Date, endDate: Date }|null>}
 */
async function applyPaidPackageSubscription({ client, userId, packageRow, sourceChannel = null }) {
  if (!client || !userId || !packageRow) return null;

  const pkg = packageRow;
  const oldSub = await getSubscriptionRowForRenewal(client, userId);
  const { startDate, endDate } = computeSubscriptionDates(oldSub, pkg);
  const nameSnap = packageNameSnapshot(pkg);
  const groupSnap = packageGroupSnapshot(pkg);
  const channel = sourceChannel || (oldSub && oldSub.source_channel) || null;

  let subscriptionId = 0;

  if (oldSub) {
    await runQuery(
      client,
      `
      UPDATE user_subscriptions
      SET package_id = $1,
          package_name_snapshot = $2,
          start_at = $3,
          end_at = $4,
          status = 'active',
          source_channel = COALESCE($5, source_channel),
          updated_at = NOW()
      WHERE id = $6
    `,
      [pkg.id, nameSnap, startDate, endDate, channel, oldSub.id]
    );
    subscriptionId = oldSub.id;
  } else {
    const ins = await runQuery(
      client,
      `
      INSERT INTO user_subscriptions (
        user_id, package_id, package_name_snapshot, source_channel, status,
        start_at, end_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'active', $5, $6, NOW(), NOW())
      RETURNING id
    `,
      [userId, pkg.id, nameSnap, channel, startDate, endDate]
    );
    subscriptionId = ins.rows[0].id;
  }

  await supersedeOtherSubscriptions(userId, subscriptionId, client);

  const { deactivateTemporaryExtraPorts } = require('./mt5PackagePorts');
  await deactivateTemporaryExtraPorts(userId, client).catch(() => {});

  return { subscriptionId, startDate, endDate, packageGroup: groupSnap };
}

module.exports = {
  getSubscriptionRowForRenewal,
  computeSubscriptionDates,
  supersedeOtherSubscriptions,
  applyPaidPackageSubscription,
  packageNameSnapshot,
  packageGroupSnapshot
};
