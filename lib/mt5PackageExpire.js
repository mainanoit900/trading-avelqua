'use strict';

/**
 * เมื่อแพ็กเกจหมดอายุ: ปิด MT5 ทั้งหมด, เคลียร์ PORT แพ็กเกจ, admin ports → ว่าง
 */

const { query } = require('../config/database');
const { clearAllFolderPortsForUser } = require('./mt5PortCleanup');

const ACTIVE_ACCOUNT_STATUSES = [
  'ready',
  'connected',
  'checking',
  'failed',
  'connecting',
  'starting'
];

/**
 * @returns {Promise<{ stoppedPorts: number, accountsCleared: number }>}
 */
async function cleanupUserOnPackageExpired(userId, reason = 'package_expired') {
  const uid = Number(userId || 0);
  if (!uid) return { stoppedPorts: 0, accountsCleared: 0 };

  const cleared = await clearAllFolderPortsForUser(uid, reason).catch(() => ({ cleared: 0 }));

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

  const clearedAccounts = await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='expired',
        port_slot=NULL,
        port_id=NULL,
        vps_id=NULL,
        assigned_port_no=NULL,
        windows_port_no=NULL,
        current_attempt_id=NULL,
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
        command_type IN ('login_mt5', 'run_mt5_bot', 'start_mt5', 'account_snapshot')
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
    stoppedPorts: Number(cleared.cleared || 0),
    accountsCleared: clearedAccounts.rows?.length || 0
  };
}

module.exports = {
  cleanupUserOnPackageExpired,
  ACTIVE_ACCOUNT_STATUSES
};
