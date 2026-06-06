'use strict';

const { query } = require('../config/database');
const { adminPortToSystemPortNo } = require('./adminVpsPortPicker');
const {
  resolveSystemVpsId,
  reconcilePortIdleWhenAgentFree,
  adminPortNoFromSystem,
  queueForceStopMt5,
  setAdminAllocationStatus
} = require('./adminVpsBridge');
const { portNoVariants } = require('./mt5PortIsolation');
const {
  cancelConnectCommandsForAccount,
  cancelConnectCommandsForPort
} = require('./vpsAgentCommandQueue');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * เลข port บน VPS ที่ตรงกับ package slot — ไม่ใช้ assigned_port_no ค้างจาก PORT เก่า
 */
function systemPortNosForPackageSlot(portSlot, assignedPortNo = 0, windowsPortNo = 0) {
  const slot = num(portSlot);
  const expected = slot > 0 ? adminPortToSystemPortNo(slot) : 0;
  const nos = new Set();
  if (expected > 0) nos.add(expected);
  const assigned = num(assignedPortNo);
  const windows = num(windowsPortNo);
  if (assigned > 0) nos.add(normalizeSystemFolderPortNo(assigned));
  if (windows > 0) nos.add(normalizeSystemFolderPortNo(windows));
  return [...nos].filter((n) => n > 0);
}

/** เลข FolderPort ที่ต้องเคลียร์ — ใช้ assigned จริงก่อน (login ชั่วคราว) แล้วค่อย fallback package slot */
function resolveReleasePortNos(portSlot, assignedPortNo = 0, windowsPortNo = 0) {
  const nos = new Set();
  const assigned = normalizeSystemFolderPortNo(num(assignedPortNo));
  const windows = normalizeSystemFolderPortNo(num(windowsPortNo));
  if (assigned > 0) nos.add(assigned);
  if (windows > 0) nos.add(windows);
  if (!nos.size && num(portSlot) > 0) {
    for (const n of systemPortNosForPackageSlot(portSlot, assignedPortNo, windowsPortNo)) {
      nos.add(n);
    }
  }
  return [...nos].filter((n) => n > 0 && n <= 120);
}

function normalizeSystemFolderPortNo(portNo) {
  const n = num(portNo);
  if (n <= 0) return 0;
  if (n >= 100) return n;
  return adminPortToSystemPortNo(n);
}

function primarySystemPortForPackageSlot(portSlot, assignedPortNo = 0, windowsPortNo = 0) {
  const nos = systemPortNosForPackageSlot(portSlot, assignedPortNo, windowsPortNo);
  return nos[0] || 0;
}

/** Payload มาตรฐานเมื่อปล่อย FolderPort — kill MT5 + ล้าง session เก่า */
function buildStopMt5ReleasePayload({
  portNo,
  portSlot = null,
  assignedPortNo = null,
  windowsPortNo = null,
  folderPath = null,
  accountId = null,
  mt5Login = null,
  reason = 'release_folder_port'
} = {}) {
  const port = num(portNo);
  const folder = folderPath ? String(folderPath).trim() : null;
  return {
    port,
    portNumber: port,
    port_no: port,
    portSlot: portSlot ? num(portSlot) : undefined,
    assignedPortNo: assignedPortNo ? num(assignedPortNo) : undefined,
    windowsPortNo: windowsPortNo ? num(windowsPortNo) : undefined,
    folder_path: folder,
    folderPath: folder,
    vpsFolderPath: folder,
    forceKill: true,
    closeMt5: true,
    clearSession: true,
    mt5Login: mt5Login ? String(mt5Login).trim() : null,
    accountId: accountId ? num(accountId) : undefined,
    reason
  };
}

/**
 * เคลียร์ FolderPort + ปิด MT5 + ปล่อย pool — ใช้ตอนลบ/ยกเลิก/หมดแพ็กเกจ
 */
async function clearFolderPortBinding(opts = {}) {
  const userId = num(opts.userId);
  const accountId = num(opts.accountId);
  const vpsId = num(opts.vpsId);
  const portId = num(opts.portId);
  const portSlot = num(opts.portSlot);
  const folderPath = String(opts.folderPath || '').trim() || null;
  const mt5Login = opts.mt5Login ? String(opts.mt5Login).trim() : null;
  const reason = String(opts.reason || 'release_folder_port');

  let systemPortNos = resolveReleasePortNos(portSlot, opts.assignedPortNo, opts.windowsPortNo);
  if (!systemPortNos.length && folderPath) {
    const m = folderPath.match(/PORT[-_ ]*0*(\d+)/i);
    if (m) systemPortNos = [adminPortToSystemPortNo(num(m[1]))];
  }

  if (accountId && vpsId) {
    await cancelConnectCommandsForAccount(accountId, vpsId).catch(() => 0);
  }
  if (portId && vpsId) {
    await cancelConnectCommandsForPort(portId, vpsId).catch(() => 0);
  }

  const forceRelease = opts.forceRelease !== false;

  if (vpsId && systemPortNos.length) {
    const variantNos = [...new Set(systemPortNos.flatMap((p) => portNoVariants(p)))].filter((n) => n > 0);

    for (const stopPortNo of systemPortNos) {
      await queueForceStopMt5(vpsId, stopPortNo, folderPath, reason).catch(() => false);
      await query(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW(), NOW())
      `,
        [
          vpsId,
          portId || null,
          JSON.stringify(
            buildStopMt5ReleasePayload({
              portNo: stopPortNo,
              portSlot: portSlot || undefined,
              assignedPortNo: opts.assignedPortNo,
              windowsPortNo: opts.windowsPortNo,
              folderPath,
              accountId: accountId || undefined,
              mt5Login,
              reason
            })
          )
        ]
      ).catch(() => {});
    }

    await query(
      `
      UPDATE vps_system.vps_port_health
      SET running=FALSE,
          pid='[]'::jsonb,
          process_id=NULL,
          mt5_login=NULL,
          balance=NULL,
          equity=NULL,
          updated_at=NOW()
      WHERE node_id=$1
        AND port_number = ANY($2::int[])
    `,
      [vpsId, variantNos]
    ).catch(() => {});
  }

  if (portId) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available',
          locked_by_user_id=NULL,
          locked_until=NULL,
          process_id=NULL,
          mt5_login=NULL,
          current_mt5_login=NULL,
          updated_at=NOW()
      WHERE id=$1
    `,
      [portId]
    ).catch(() => {});
  }

  if (vpsId && systemPortNos.length) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available',
          locked_by_user_id=NULL,
          locked_until=NULL,
          process_id=NULL,
          mt5_login=NULL,
          current_mt5_login=NULL,
          updated_at=NOW()
      WHERE vps_id=$1
        AND port_no = ANY($2::int[])
    `,
      [vpsId, systemPortNos]
    ).catch(() => {});
  }

  if (userId && vpsId && systemPortNos.length) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available',
          locked_by_user_id=NULL,
          locked_until=NULL,
          process_id=NULL,
          mt5_login=NULL,
          current_mt5_login=NULL,
          updated_at=NOW()
      WHERE locked_by_user_id=$1
        AND vps_id=$2
        AND port_no = ANY($3::int[])
    `,
      [userId, vpsId, systemPortNos]
    ).catch(() => {});
  }

  if (systemPortNos.length && vpsId) {
    const { adminNodeId } = await resolveSystemVpsId(vpsId).catch(() => ({}));
    for (const stopPortNo of systemPortNos) {
      const adminPort = adminPortNoFromSystem(stopPortNo) || stopPortNo;
      if (forceRelease && adminNodeId && adminPort >= 1 && adminPort <= 20) {
        await setAdminAllocationStatus(adminNodeId, adminPort, 'free').catch(() => {});
      }
      if (forceRelease && adminNodeId && folderPath) {
        await query(
          `
          UPDATE vps_allocations
          SET status='free',
              mt5_status='stopped',
              is_active=TRUE,
              updated_at=NOW()
          WHERE node_id=$1
            AND TRIM(COALESCE(folder_path, base_path, '')) = TRIM($2)
        `,
          [adminNodeId, folderPath]
        ).catch(() => {});
      }
      await reconcilePortIdleWhenAgentFree(adminNodeId || vpsId, adminPort, folderPath || '', {
        accountId,
        userId,
        portSlot,
        forceRelease
      }).catch(() => {});
    }
  }

  return { ok: true, portNos: systemPortNos };
}

/** เคลียร์ FolderPort/MT5 ทุกช่องของ user (หมดแพ็กเกจ) */
async function clearAllFolderPortsForUser(userId, reason = 'package_expired') {
  const uid = num(userId);
  if (!uid) return { cleared: 0 };

  const seen = new Set();
  let cleared = 0;

  const accounts = await query(
    `
    SELECT
      a.id AS account_id,
      a.port_slot,
      a.vps_id,
      a.port_id,
      a.assigned_port_no,
      a.windows_port_no,
      a.mt5_login,
      COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id = $1
      AND (
        a.port_slot IS NOT NULL
        OR a.vps_id IS NOT NULL
        OR a.port_id IS NOT NULL
        OR a.assigned_port_no IS NOT NULL
      )
      AND LOWER(TRIM(COALESCE(a.status, ''))) NOT IN ('deleted')
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const row of accounts.rows || []) {
    const key = `${row.vps_id}:${row.port_id}:${row.port_slot}:${row.assigned_port_no}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await clearFolderPortBinding({
      userId: uid,
      accountId: row.account_id,
      vpsId: row.vps_id,
      portId: row.port_id,
      portSlot: row.port_slot,
      assignedPortNo: row.assigned_port_no,
      windowsPortNo: row.windows_port_no,
      folderPath: row.folder_path,
      mt5Login: row.mt5_login,
      reason
    }).catch(() => {});
    cleared += 1;
  }

  const lockedPorts = await query(
    `
    SELECT p.id AS port_id, p.vps_id, p.port_no, p.folder_path
    FROM vps_system.vps_ports p
    WHERE p.locked_by_user_id = $1
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const row of lockedPorts.rows || []) {
    const key = `lock:${row.vps_id}:${row.port_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await clearFolderPortBinding({
      userId: uid,
      vpsId: row.vps_id,
      portId: row.port_id,
      assignedPortNo: row.port_no,
      folderPath: row.folder_path,
      reason
    }).catch(() => {});
    cleared += 1;
  }

  return { cleared };
}

/** ปล่อย FolderPort ชั่วคราวหลัง login สำเร็จ (Phase 1) — เก็บ connected + package port_slot */
async function releaseTemporaryLoginFolder(opts = {}) {
  const accountId = num(opts.accountId);
  const userId = num(opts.userId);
  const vpsId = num(opts.vpsId);
  const portId = num(opts.portId);
  const portNo = num(opts.assignedPortNo || opts.portNo);
  const adminNodeId = num(opts.adminNodeId);
  const folderPath = String(opts.folderPath || '').trim() || null;
  const mt5Login = opts.mt5Login ? String(opts.mt5Login).trim() : null;

  if (vpsId && portNo) {
    await clearFolderPortBinding({
      userId,
      accountId,
      vpsId,
      portId,
      assignedPortNo: portNo,
      folderPath,
      mt5Login,
      reason: opts.reason || 'login_temp_release'
    }).catch(() => {});
  }

  if (accountId) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET vps_id = NULL,
          port_id = NULL,
          assigned_port_no = NULL,
          windows_port_no = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND LOWER(COALESCE(status, '')) IN ('connected', 'ready', 'checking')
    `,
      [accountId]
    ).catch(() => {});
  }

  if (adminNodeId && portNo) {
    const { setAdminAllocationStatus } = require('./adminVpsBridge');
    const adminPort = portNo >= 100 ? portNo - 100 : portNo;
    if (adminPort >= 1 && adminPort <= 20) {
      await setAdminAllocationStatus(adminNodeId, adminPort, 'free').catch(() => {});
    }
  }

  return { ok: true };
}

module.exports = {
  buildStopMt5ReleasePayload,
  systemPortNosForPackageSlot,
  resolveReleasePortNos,
  primarySystemPortForPackageSlot,
  clearFolderPortBinding,
  clearAllFolderPortsForUser,
  releaseTemporaryLoginFolder
};
