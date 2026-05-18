'use strict';

/**
 * ตรวจแพ็กเกจหมดอายุเป็นระยะ — ปิด MT5 ทุกพอร์ตของ user โดยไม่ต้องเข้า /app/mt5
 */

const { query } = require('../config/database');
const { cleanupUserOnPackageExpired, ACTIVE_ACCOUNT_STATUSES } = require('../lib/mt5PackageExpire');

const DEFAULT_INTERVAL_MS = Number(process.env.PACKAGE_EXPIRY_INTERVAL_MS || 60_000);
const SWEEP_KEY = process.env.PACKAGE_EXPIRY_CRON_KEY || process.env.MT5_RECOVERY_CRON_KEY || '';

let sweepRunning = false;

function userHasActivePackageSql(alias = 's') {
  return `
    EXISTS (
      SELECT 1
      FROM user_subscriptions ${alias}
      WHERE ${alias}.user_id = x.user_id
        AND (${alias}.end_at IS NULL OR ${alias}.end_at > NOW())
        AND LOWER(TRIM(COALESCE(${alias}.status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
    )
  `;
}

async function expireSubscriptionRows() {
  const res = await query(
    `
    UPDATE user_subscriptions
    SET status = 'expired',
        updated_at = NOW()
    WHERE end_at IS NOT NULL
      AND end_at <= NOW()
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
  `
  ).catch(() => ({ rowCount: 0 }));

  await query(
    `
    UPDATE bot_sessions bs
    SET status = 'stopped',
        stopped_at = COALESCE(stopped_at, NOW()),
        updated_at = NOW()
    WHERE LOWER(TRIM(COALESCE(bs.status, ''))) = 'running'
      AND NOT EXISTS (
        SELECT 1
        FROM user_subscriptions s
        WHERE s.user_id = bs.user_id
          AND (s.end_at IS NULL OR s.end_at > NOW())
          AND LOWER(TRIM(COALESCE(s.status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
      )
  `
  ).catch(() => {});

  return res.rowCount || 0;
}

async function findUsersNeedingMt5Shutdown() {
  const res = await query(
    `
    SELECT DISTINCT x.user_id
    FROM (
      SELECT a.user_id
      FROM vps_system.mt5_accounts a
      WHERE LOWER(TRIM(COALESCE(a.status, ''))) = ANY($1::text[])
      UNION
      SELECT p.locked_by_user_id AS user_id
      FROM vps_system.vps_ports p
      WHERE p.locked_by_user_id IS NOT NULL
      UNION
      SELECT bi.user_id
      FROM vps_system.bot_instances bi
      WHERE LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'restarting')
    ) x
    WHERE x.user_id IS NOT NULL
      AND NOT ${userHasActivePackageSql('s')}
    ORDER BY x.user_id ASC
  `,
    [ACTIVE_ACCOUNT_STATUSES]
  ).catch(() => ({ rows: [] }));

  return (res.rows || []).map((r) => Number(r.user_id)).filter((id) => id > 0);
}

/**
 * @returns {Promise<{ expiredSubscriptions: number, usersProcessed: number, stoppedPorts: number, accountsCleared: number }>}
 */
async function runPackageExpirySweep() {
  if (sweepRunning) {
    return { expiredSubscriptions: 0, usersProcessed: 0, stoppedPorts: 0, accountsCleared: 0, skipped: true };
  }

  sweepRunning = true;
  try {
    const expiredSubscriptions = await expireSubscriptionRows();
    const userIds = await findUsersNeedingMt5Shutdown();

    let stoppedPorts = 0;
    let accountsCleared = 0;

    for (const userId of userIds) {
      const r = await cleanupUserOnPackageExpired(userId, 'package_expired_auto_sweep').catch(() => ({
        stoppedPorts: 0,
        accountsCleared: 0
      }));
      stoppedPorts += Number(r.stoppedPorts || 0);
      accountsCleared += Number(r.accountsCleared || 0);
    }

    return {
      expiredSubscriptions,
      usersProcessed: userIds.length,
      stoppedPorts,
      accountsCleared
    };
  } finally {
    sweepRunning = false;
  }
}

function startPackageExpiryWorker(options = {}) {
  const intervalMs = Number(options.intervalMs || DEFAULT_INTERVAL_MS);
  if (!Number.isFinite(intervalMs) || intervalMs < 15_000) {
    throw new Error('PACKAGE_EXPIRY_INTERVAL_MS must be >= 15000');
  }

  const tick = async () => {
    try {
      const result = await runPackageExpirySweep();
      if (result.usersProcessed > 0 || result.expiredSubscriptions > 0) {
        console.log('[package-expiry-sweep]', JSON.stringify(result));
      }
    } catch (error) {
      console.error('[package-expiry-sweep] error:', error);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[package-expiry-sweep] worker started (every ${intervalMs}ms)`);
  return timer;
}

function isSweepAuthorized(req) {
  if (!SWEEP_KEY) return false;
  return String(req.query.key || req.headers['x-cron-key'] || '') === String(SWEEP_KEY);
}

module.exports = {
  runPackageExpirySweep,
  startPackageExpiryWorker,
  isSweepAuthorized,
  expireSubscriptionRows,
  findUsersNeedingMt5Shutdown
};
