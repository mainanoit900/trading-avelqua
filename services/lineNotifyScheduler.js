'use strict';

const cron = require('node-cron');
const { query } = require('../config/database');
const { pushText, pushFlex, lineEnabled } = require('./lineService');
const { saveDailySnapshots } = require('../lib/linePnlReport');
const { fetchActivePorts } = require('../lib/linePortfolio');
const { buildDailyReportFlex } = require('../lib/lineFlexUi');
const { ensureLineNotifyTables } = require('../lib/lineNotifySchema');

async function sendDailyReport() {
  if (!lineEnabled()) return;

  await ensureLineNotifyTables();

  const subs = await query(
    `
    SELECT line_user_id, user_id
    FROM line_subscribers
    WHERE verified = TRUE AND subscribed = TRUE
  `
  ).catch(() => ({ rows: [] }));

  for (const sub of subs.rows || []) {
    try {
      const flex = await buildDailyReportFlex(sub.user_id);
      if (!flex) continue;
      await pushFlex(sub.line_user_id, flex.altText, flex.contents);
      const accounts = await fetchActivePorts(sub.user_id);
      await saveDailySnapshots(sub.user_id, accounts);
    } catch (e) {
      console.error('[LineScheduler] error user', sub.user_id, e.message);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ALERT_3D_MS = 3 * DAY_MS;
const ALERT_1D_MS = 1 * DAY_MS;
const ALERT_15M_MS = 15 * MINUTE_MS;

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || process.env.BASE_URL || 'https://trading.avelqua.com').replace(/\/+$/, '');
}

function formatThaiDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('th-TH', {
    timeZone: process.env.TZ || 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatRemainingThai(ms) {
  const safe = Math.max(0, Number(ms || 0));
  const totalMinutes = Math.floor(safe / MINUTE_MS);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days} วัน ${hours} ชั่วโมง ${minutes} นาที`;
  }
  if (hours > 0) {
    return `${hours} ชั่วโมง ${minutes} นาที`;
  }
  return `${minutes} นาที`;
}

function resolveExpiryAlertType(remainingMs) {
  if (remainingMs <= 0) return null;
  if (remainingMs <= ALERT_15M_MS) return 'before_15m';
  if (remainingMs <= ALERT_1D_MS) return 'before_1d';
  if (remainingMs <= ALERT_3D_MS) return 'before_3d';
  return null;
}

function buildExpiryAlertMessage(row, remainingMs) {
  const packageName = String(row.package_name_snapshot || row.package_name || 'แพ็กเกจใช้งาน').trim();
  const endAtText = formatThaiDateTime(row.end_at);
  const remainingText = formatRemainingThai(remainingMs);
  return [
    'แจ้งเตือนแพ็กเกจใกล้หมดอายุ',
    `แพ็กเกจ: ${packageName}`,
    `หมดอายุ: ${endAtText}`,
    `คงเหลือประมาณ: ${remainingText}`,
    `ต่ออายุได้ที่: ${appBaseUrl()}/app/packages`
  ].join('\n');
}

async function markAlertOnce(row, alertType) {
  const res = await query(
    `
    INSERT INTO line_expiry_alert_log (
      user_id, subscription_id, line_user_id, alert_type, expiry_at, sent_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (subscription_id, alert_type, expiry_at) DO NOTHING
    RETURNING id
  `,
    [row.user_id, row.subscription_id, row.line_user_id, alertType, row.end_at]
  ).catch(() => ({ rows: [] }));
  return res.rows?.[0]?.id || 0;
}

async function rollbackAlertMark(alertLogId) {
  if (!alertLogId) return;
  await query(`DELETE FROM line_expiry_alert_log WHERE id = $1`, [alertLogId]).catch(() => {});
}

async function sendExpiryAlerts() {
  if (!lineEnabled()) return;

  await ensureLineNotifyTables();

  const subs = await query(
    `
    SELECT
      ls.user_id,
      ls.line_user_id,
      us.id AS subscription_id,
      us.package_name_snapshot,
      us.end_at
    FROM line_subscribers ls
    JOIN user_subscriptions us
      ON us.user_id = ls.user_id
    WHERE ls.verified = TRUE
      AND ls.subscribed = TRUE
      AND LOWER(TRIM(COALESCE(us.status, ''))) = 'active'
      AND us.end_at IS NOT NULL
      AND us.end_at > NOW()
      AND us.id = (
        SELECT s2.id
        FROM user_subscriptions s2
        WHERE s2.user_id = us.user_id
          AND LOWER(TRIM(COALESCE(s2.status, ''))) = 'active'
          AND s2.end_at IS NOT NULL
          AND s2.end_at > NOW()
        ORDER BY s2.end_at DESC NULLS LAST, s2.id DESC
        LIMIT 1
      )
  `
  ).catch(() => ({ rows: [] }));

  const nowMs = Date.now();
  for (const row of subs.rows || []) {
    let alertLogId = 0;
    try {
      const endMs = new Date(row.end_at).getTime();
      if (!Number.isFinite(endMs)) continue;
      const remainingMs = endMs - nowMs;
      const alertType = resolveExpiryAlertType(remainingMs);
      if (!alertType) continue;

      alertLogId = await markAlertOnce(row, alertType);
      if (!alertLogId) continue;

      const text = buildExpiryAlertMessage(row, remainingMs);
      await pushText(row.line_user_id, text);
    } catch (e) {
      // If push failed after we marked once, remove marker so scheduler can retry.
      if (String(e?.message || '').trim()) {
        console.error('[LineScheduler] expiry alert error user', row.user_id, e.message);
      }
      await rollbackAlertMark(alertLogId);
    }
  }
}

function startLineScheduler() {
  if (!lineEnabled()) {
    console.log('[LineScheduler] skipped — LINE_CHANNEL_ACCESS_TOKEN not set');
    return;
  }
  const expr = String(process.env.LINE_DAILY_CRON || '0 7 * * 1-5');
  cron.schedule(
    expr,
    () => {
      sendDailyReport().catch((e) => console.error('[LineScheduler]', e.message));
    },
    { timezone: process.env.TZ || 'Asia/Bangkok' }
  );
  console.log(`[LineScheduler] started — cron "${expr}" (${process.env.TZ || 'Asia/Bangkok'})`);

  const expiryExpr = String(process.env.LINE_EXPIRY_ALERT_CRON || '*/1 * * * *');
  cron.schedule(
    expiryExpr,
    () => {
      sendExpiryAlerts().catch((e) => console.error('[LineScheduler][expiry]', e.message));
    },
    { timezone: process.env.TZ || 'Asia/Bangkok' }
  );
  console.log(`[LineScheduler] expiry alerts started — cron "${expiryExpr}" (${process.env.TZ || 'Asia/Bangkok'})`);
}

module.exports = { startLineScheduler, sendDailyReport, sendExpiryAlerts };
