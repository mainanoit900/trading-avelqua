'use strict';

/**
 * สิทธิ์ PORT หลังซื้อ/ต่อแพ็กเกจ:
 * - แพ็กเกจให้ 1 PORT เสมอ
 * - พอร์ตชั่วคราวถูกปิดทุกครั้งที่ซื้อแพ็กเกจใหม่ และเมื่อแพ็กเกจหมดอายุ
 * - พอร์ตถาวรคงอยู่เฉพาะระดับ (package_group) ที่ตรงกับแพ็กเกจปัจจุบัน
 */

const { query } = require('../config/database');
const {
  computePortEntitlement,
  packagePortCapForGroup
} = require('./mt5PortEntitlement');

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

async function runQuery(sql, params, db) {
  if (db && typeof db.query === 'function') return db.query(sql, params);
  return query(sql, params);
}

/** ปิดพอร์ตชั่วคราวทั้งหมด (ซื้อแพ็กเกจใหม่ / หมดอายุ) */
async function deactivateTemporaryExtraPorts(userId, db = null) {
  const uid = Number(userId || 0);
  if (!uid) return 0;
  const res = await runQuery(
    `
    UPDATE vps_system.mt5_extra_ports
    SET is_active = FALSE
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(port_type, ''))) = 'temporary'
      AND is_active = TRUE
  `,
    [uid],
    db
  ).catch(() => ({ rowCount: 0 }));
  return res.rowCount || 0;
}

/**
 * ลบพอร์ตชั่วคราวที่ไม่ใช่รอบแพ็กเกจปัจจุบัน (self-heal ตอนโหลด /app/mt5)
 */
async function pruneStaleTemporaryExtraPorts(userId, subscriptionId, subscriptionStartAt, db = null) {
  const uid = Number(userId || 0);
  const subId = Number(subscriptionId || 0);
  const startAt = subscriptionStartAt ? new Date(subscriptionStartAt) : null;
  if (!uid || !subId || !startAt || Number.isNaN(startAt.getTime())) return 0;

  const res = await runQuery(
    `
    UPDATE vps_system.mt5_extra_ports
    SET is_active = FALSE
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(port_type, ''))) = 'temporary'
      AND is_active = TRUE
      AND (
        subscription_id IS DISTINCT FROM $2
        OR created_at < $3::timestamptz
        OR created_at < (
          SELECT us.updated_at
          FROM user_subscriptions us
          WHERE us.id = $2
          LIMIT 1
        )
      )
  `,
    [uid, subId, startAt],
    db
  ).catch(() => ({ rowCount: 0 }));

  return res.rowCount || 0;
}

async function stopPortsAboveEntitlement(userId, totalPorts, reason = 'port_entitlement_reduced', db = null) {
  const limit = Math.max(0, num(totalPorts));
  const uid = Number(userId || 0);
  if (!uid) return;

  const rows = await runQuery(
    `
    SELECT id, port_slot, vps_id, assigned_port_no, windows_port_no
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(status, 'ready'))) IN ('ready', 'connected', 'checking', 'failed')
      AND COALESCE(port_slot, 0) > $2
  `,
    [uid, limit],
    db
  ).catch(() => ({ rows: [] }));

  for (const a of rows.rows || []) {
    const stopNodeId = num(a.vps_id);
    const stopPortNo = num(a.assigned_port_no) || num(a.windows_port_no) || num(a.port_slot);
    if (stopNodeId && stopPortNo) {
      await runQuery(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, command_type, payload, status, created_at)
        VALUES ($1, $1, 'stop_mt5', $2::jsonb, 'pending', NOW())
      `,
        [
          stopNodeId,
          JSON.stringify({
            port: stopPortNo,
            portSlot: a.port_slot,
            assignedPortNo: a.assigned_port_no,
            windowsPortNo: a.windows_port_no,
            reason
          })
        ],
        db
      ).catch(() => {});
    }
  }

  if ((rows.rows || []).length) {
    await runQuery(
      `
      UPDATE vps_system.mt5_accounts
      SET status = 'expired',
          assigned_port_no = NULL,
          windows_port_no = NULL,
          vps_id = NULL,
          port_slot = NULL,
          updated_at = NOW()
      WHERE user_id = $1
        AND LOWER(TRIM(COALESCE(status, 'ready'))) IN ('ready', 'connected', 'checking', 'failed')
        AND COALESCE(port_slot, 0) > $2
    `,
      [uid, limit],
      db
    ).catch(() => {});
  }

  await runQuery(
    `
    UPDATE vps_system.bot_instances
    SET status = 'stopped',
        stopped_at = COALESCE(stopped_at, NOW()),
        updated_at = NOW(),
        last_error = $3
    WHERE user_id = $1
      AND status IN ('running', 'pending', 'restarting')
      AND COALESCE(port_used, assigned_port_no, 0) > $2
  `,
    [uid, limit, reason],
    db
  ).catch(() => {});
}

/**
 * หลังเปิดใช้แพ็กเกจ (ชำระเงิน / ต่ออายุ): ล้างพอร์ตชั่วคราว + จำกัดช่อง MT5 ตามสิทธิ์
 */
async function onPackageActivated(userId, opts = {}) {
  const uid = Number(userId || 0);
  if (!uid) return { temporaryDeactivated: 0, totalPorts: 0 };

  await deactivateTemporaryExtraPorts(uid, opts.client || null);

  if (opts.skipPortReconcile) {
    return { temporaryDeactivated: 1, totalPorts: null };
  }

  const pkgRows = await runQuery(
    `
    SELECT us.id AS subscription_id,
           UPPER(COALESCE(p.group_name, p.package_group, p.package_code, '')) AS package_group,
           COALESCE(
             NULLIF(us.ports_max, 0),
             NULLIF(us.ports_min, 0),
             NULLIF(p.ports_max, 0),
             1
           ) AS max_ports
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id = $1
      AND (us.end_at IS NULL OR us.end_at > NOW())
      AND LOWER(TRIM(COALESCE(us.status, ''))) NOT IN ('cancelled', 'deleted')
    ORDER BY
      CASE WHEN LOWER(TRIM(COALESCE(us.status, ''))) = 'active' THEN 0 ELSE 1 END,
      us.updated_at DESC NULLS LAST,
      us.id DESC
    LIMIT 1
  `,
    [uid],
    opts.client || null
  ).catch(() => ({ rows: [] }));

  const pkg = pkgRows.rows?.[0];
  if (!pkg) return { temporaryDeactivated: 1, totalPorts: 0 };

  const group = String(pkg.package_group || '').toUpperCase();
  const cap = packagePortCapForGroup(group, pkg.max_ports);
  const subId = Number(pkg.subscription_id || 0) || null;

  const extraRows = await runQuery(
    `
    SELECT qty, port_type, package_group, expires_at,
           CASE WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN TRUE ELSE FALSE END AS is_expired
    FROM vps_system.mt5_extra_ports
    WHERE user_id = $1
      AND is_active = TRUE
      AND LOWER(TRIM(COALESCE(port_type, ''))) = 'permanent'
      AND $2 <> ''
      AND UPPER(TRIM(COALESCE(package_group, ''))) = $2
    ORDER BY created_at DESC, id DESC
  `,
    [uid, group],
    opts.client || null
  ).catch(() => ({ rows: [] }));

  const { totalPorts } = computePortEntitlement(cap, extraRows.rows || [], group);
  await stopPortsAboveEntitlement(uid, totalPorts, 'package_activated_port_reset', opts.client || null);

  return { temporaryDeactivated: 1, totalPorts };
}

module.exports = {
  deactivateTemporaryExtraPorts,
  pruneStaleTemporaryExtraPorts,
  stopPortsAboveEntitlement,
  onPackageActivated
};
