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

function packageTierFromText(text) {
  const upper = String(text || '').trim().toUpperCase();
  if (upper.includes('ADVANCED')) return 'ADVANCED';
  if (upper.includes('PRO')) return 'PRO';
  if (upper.includes('BASIC')) return 'BASIC';
  return upper;
}

function extractDaysFromText(text) {
  const m = String(text || '').match(/(\d+)\s*วัน/);
  return m ? num(m[1], 0) : 0;
}

function subscriptionDurationDays(sub) {
  if (!sub?.start_at || !sub?.end_at) return 0;
  const ms = new Date(sub.end_at).getTime() - new Date(sub.start_at).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
}

function buildTierDayLabel(tier, days) {
  const group = String(tier || '').trim().toUpperCase();
  const dayCount = num(days, 0);
  if (!group) return dayCount > 0 ? `${dayCount} วัน` : '-';
  return dayCount > 0 ? `${group} ${dayCount} วัน` : group;
}

/** ชื่อแพ็กเกจฟรีจากคูปอง — ใช้วันจากคูปอง ไม่ใช่ชื่อแพ็กเกจใน catalog */
function buildFreeCouponPackageName(freeGroup, freeDays) {
  return buildTierDayLabel(freeGroup, freeDays);
}

/** ชื่อแสดงบน UI สำหรับ subscription ปัจจุบัน */
function formatSubscriptionDisplayLabel(sub) {
  if (!sub) return '-';

  const snap = String(sub.package_name_snapshot || sub.name_th || sub.name_en || '').trim();
  const tier = packageTierFromText(sub.group_name || sub.coupon_free_package_group || snap);
  const pkgDays = num(sub.days, 0);
  const source = String(sub.source_channel || '');
  const paymentMethod = String(sub.payment_method || '').toLowerCase();
  const couponDays = num(sub.coupon_free_days, 0);
  const durationDays = subscriptionDurationDays(sub);
  const snapDays = extractDaysFromText(snap);
  const isFreeCoupon = source.startsWith('free_coupon:') || paymentMethod === 'free_coupon';

  if (isFreeCoupon || couponDays > 0) {
    const days = couponDays || durationDays || snapDays;
    return buildTierDayLabel(tier || sub.coupon_free_package_group, days);
  }

  if (pkgDays > 0) {
    if (snap && snapDays === pkgDays) return snap;
    return buildTierDayLabel(tier, pkgDays);
  }

  if (durationDays > 0 && snapDays > 0 && snapDays !== durationDays) {
    return buildTierDayLabel(tier, durationDays);
  }

  return snap || '-';
}

function parsePaymentRawPayload(payment) {
  if (!payment?.raw_payload) return {};
  if (typeof payment.raw_payload === 'object') return payment.raw_payload;
  try {
    return JSON.parse(payment.raw_payload);
  } catch (_) {
    return {};
  }
}

/** ชื่อแสดงแพ็กเกจในรายการชำระ (payments) */
function formatPackagePaymentDisplayLabel(payment) {
  if (!payment) return '-';

  const snap = String(payment.package_name_snapshot || payment.name_th || payment.name_en || '').trim();
  const raw = parsePaymentRawPayload(payment);
  const rawCoupon = raw.coupon || {};
  const tier = packageTierFromText(
    payment.group_name || payment.coupon_free_package_group || rawCoupon.free_package_group || snap
  );
  const pkgDays = num(payment.package_days ?? payment.days, 0);
  const paymentMethod = String(payment.payment_method || '').toLowerCase();
  const couponDays = num(payment.coupon_free_days ?? rawCoupon.free_days, 0);
  const snapDays = extractDaysFromText(snap);
  const isFreeCoupon = paymentMethod === 'free_coupon' || couponDays > 0 || rawCoupon.type === 'free';

  if (isFreeCoupon) {
    const days = couponDays || snapDays;
    const group = tier || payment.coupon_free_package_group || rawCoupon.free_package_group;
    return buildTierDayLabel(group, days);
  }

  if (pkgDays > 0) {
    if (snap && snapDays === pkgDays) return snap;
    return buildTierDayLabel(tier, pkgDays);
  }

  return snap || '-';
}

function localeFromLang(lang) {
  const map = { th: 'th-TH', en: 'en-US', lo: 'lo-LA', vi: 'vi-VN', my: 'my-MM' };
  return map[String(lang || 'th').toLowerCase()] || 'en-US';
}

/** ช่องทางที่อ่านง่าย — คูปองฟรี / ซื้อแพ็กเกจ */
function formatSubscriptionSourceLabel(sub, lang = 'th') {
  if (!sub) return '-';

  const isTh = String(lang || 'th').toLowerCase() === 'th';
  const source = String(sub.source_channel || '');
  const paymentMethod = String(sub.payment_method || '').toLowerCase();

  if (source.startsWith('free_coupon:') || paymentMethod === 'free_coupon') {
    return isTh ? 'คูปองฟรี' : 'Free Coupon';
  }

  if (
    source.startsWith('payment:') ||
    paymentMethod === 'scoin' ||
    paymentMethod === 'promptpay_qr' ||
    paymentMethod === 'credit_card' ||
    paymentMethod === 'bank_transfer' ||
    sub.package_id ||
    sub.package_name_snapshot
  ) {
    if (paymentMethod === 'scoin') {
      return isTh ? 'ซื้อแพ็กเกจ (Scoin)' : 'Package (Scoin)';
    }
    return isTh ? 'ซื้อแพ็กเกจ' : 'Package Purchase';
  }

  return source || '-';
}

/** วันที่/เวลาแสดงบน dashboard */
function formatSubscriptionDateTime(value, lang = 'th') {
  if (!value) return { date: '-', time: '' };

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: '-', time: '' };

  const locale = localeFromLang(lang);
  return {
    date: d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  };
}
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

  const { deactivateTemporaryExtraPorts, onPackageActivated } = require('./mt5PackagePorts');
  await deactivateTemporaryExtraPorts(userId, client).catch(() => {});
  await onPackageActivated(userId, { client }).catch(() => {});

  return { subscriptionId, startDate, endDate, packageGroup: groupSnap };
}

module.exports = {
  getSubscriptionRowForRenewal,
  computeSubscriptionDates,
  supersedeOtherSubscriptions,
  applyPaidPackageSubscription,
  packageNameSnapshot,
  packageGroupSnapshot,
  packageTierFromText,
  buildFreeCouponPackageName,
  formatSubscriptionDisplayLabel,
  formatPackagePaymentDisplayLabel,
  formatSubscriptionSourceLabel,
  formatSubscriptionDateTime
};
