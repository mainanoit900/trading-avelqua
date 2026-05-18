'use strict';

/**
 * เมื่อแพ็กเกจหมดอายุ: ปิด MT5 ทั้งหมด, เคลียร์ PORT แพ็กเกจ, admin ports → ว่าง
 */

const { query } = require('../config/database');
const {
  resolveSystemVpsId,
  reconcilePortIdleWhenAgentFree,
  adminPortNoFromSystem
} = require('./adminVpsBridge');

const ACTIVE_ACCOUNT_STATUSES = [
  'ready',
  'connected',
  'checking',
  'failed',
  'connecting',
  'starting'
];

function folderPathForPort(portNo, folderPath) {
  const fp = String(folderPath || '').trim();
  if (fp) return fp;
  const n = adminPortNoFromSystem(portNo);
  if (!n) return '';
  return `C:\\MT5_PORTS\\VPS-WIN-01-PORT-${String(n).padStart(2, '0')}`;
}

/**
 * @returns {Promise<{ stoppedPorts: number, accountsCleared: number }>}
 */
async function cleanupUserOnPackageExpired(userId, reason = 'package_expired') {
  const uid = Number(userId || 0);
  if (!uid) return { stoppedPorts: 0, accountsCleared: 0 };

  const rows = await query(
    `
    SELECT
      a.id AS account_id,
      a.port_slot,
      a.vps_id,
      a.port_id,
      a.assigned_port_no,
      a.windows_port_no,
      COALESCE(p.folder_path, '') AS folder_path,
      COALESCE(p.port_no, a.assigned_port_no, a.windows_port_no) AS port_no
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id = $1
      AND LOWER(TRIM(COALESCE(a.status, ''))) = ANY($2::text[])
  `,
    [uid, ACTIVE_ACCOUNT_STATUSES]
  ).catch(() => ({ rows: [] }));

  const reconciled = new Set();

  for (const row of rows.rows || []) {
    const vpsId = Number(row.vps_id || 0);
    const portNo = Number(row.assigned_port_no || row.windows_port_no || row.port_no || 0);
    const adminPort = adminPortNoFromSystem(portNo);
    const folderPath = folderPathForPort(portNo, row.folder_path);

    if (vpsId && portNo) {
      await query(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1, $1, 'stop_mt5', $2::jsonb, 'pending', NOW(), NOW())
      `,
        [
          vpsId,
          JSON.stringify({
            port: adminPort,
            port_no: portNo,
            portNumber: adminPort,
            folder_path: folderPath,
            folderPath,
            vpsFolderPath: folderPath,
            accountId: row.account_id,
            reason
          })
        ]
      ).catch(() => {});
    }

    if (vpsId && adminPort) {
      const { adminNodeId } = await resolveSystemVpsId(vpsId);
      const key = `${adminNodeId}:${adminPort}:${folderPath}`;
      if (adminNodeId && !reconciled.has(key)) {
        reconciled.add(key);
        await reconcilePortIdleWhenAgentFree(adminNodeId, adminPort, folderPath).catch(() => {});
      }
    }
  }

  await query(
    `
    UPDATE vps_system.vps_ports
    SET status='available',
        locked_by_user_id=NULL,
        locked_until=NULL,
        process_id=NULL,
        last_pid=NULL,
        mt5_login=NULL,
        current_mt5_login=NULL,
        last_error='แพ็กเกจหมดอายุ',
        updated_at=NOW()
    WHERE locked_by_user_id = $1
  `,
    [uid]
  ).catch(() => {});

  const cleared = await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='expired',
        port_slot=NULL,
        port_id=NULL,
        vps_id=NULL,
        assigned_port_no=NULL,
        windows_port_no=NULL,
        last_error='แพ็กเกจหมดอายุ',
        last_login_message='แพ็กเกจหมดอายุ',
        updated_at=NOW()
    WHERE user_id=$1
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted')
      AND (
        port_slot IS NOT NULL
        OR LOWER(TRIM(COALESCE(status, ''))) = ANY($2::text[])
      )
    RETURNING id
  `,
    [uid, ACTIVE_ACCOUNT_STATUSES]
  ).catch(() => ({ rows: [] }));

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='แพ็กเกจหมดอายุ',
        finished_at=NOW(),
        updated_at=NOW()
    WHERE LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND (
        command_type IN ('login_mt5', 'run_mt5_bot', 'start_mt5')
        AND (
          (payload->>'userId')::text = $1::text
          OR (payload->>'accountId')::text IN (
            SELECT id::text FROM vps_system.mt5_accounts WHERE user_id = $1::bigint
          )
        )
      )
  `,
    [String(uid)]
  ).catch(() => {});

  await query(
    `
    UPDATE vps_system.bot_instances
    SET status='stopped',
        stopped_at=COALESCE(stopped_at, NOW()),
        updated_at=NOW(),
        last_error=$2
    WHERE user_id=$1
      AND status IN ('running', 'pending', 'restarting')
  `,
    [uid, reason]
  ).catch(() => {});

  const { deactivateTemporaryExtraPorts } = require('./mt5PackagePorts');
  await deactivateTemporaryExtraPorts(uid).catch(() => {});

  return {
    stoppedPorts: rows.rows?.length || 0,
    accountsCleared: cleared.rows?.length || 0
  };
}

module.exports = {
  cleanupUserOnPackageExpired,
  ACTIVE_ACCOUNT_STATUSES
};
