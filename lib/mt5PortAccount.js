'use strict';

const { adminPortToSystemPortNo } = require('./mt5ReservedPortNo');
const { normalizeSystemFolderPortNo } = require('./mt5ReservedPortNo');

function expectedFolderPortForSlot(portSlot) {
  const slot = Number(portSlot || 0);
  if (!slot) return 0;
  return normalizeSystemFolderPortNo(adminPortToSystemPortNo(slot));
}

/** Lower = higher priority when multiple rows share the same port_slot */
const PORT_ACCOUNT_STATUS_PRIORITY = {
  connected: 0,
  connecting: 1,
  starting: 2,
  checking: 3,
  ready: 4,
  failed: 5,
  cancelled: 6,
  expired: 7,
  deleted: 99
};

const HIDDEN_PORT_STATUSES = new Set(['deleted', 'expired', 'failed']);

function portStatusRank(status) {
  const key = String(status || '').toLowerCase();
  return PORT_ACCOUNT_STATUS_PRIORITY[key] ?? 50;
}

function accountHasEquityMetrics(row) {
  if (!row) return false;
  const equity = row.last_equity ?? row.equity;
  const balance = row.last_balance ?? row.balance;
  if (equity != null && equity !== '' && Number.isFinite(Number(equity))) return true;
  if (balance != null && balance !== '' && Number.isFinite(Number(balance))) return true;
  return false;
}

/** Login สำเร็จ (มี Equity) และพร้อม Run BOT — รวม ready หลังปิด MT5 */
function isRunnableMt5Account(row) {
  if (!row) return false;
  const st = String(row.status || '').toLowerCase();
  if (!accountHasEquityMetrics(row)) return false;
  return st === 'connected' || st === 'ready';
}

/** Pick the single account row to display for a package port slot */
function pickAccountForPortSlot(accounts, slot) {
  const list = (accounts || []).filter((a) => Number(a.port_slot) === Number(slot));
  if (!list.length) return null;

  list.sort((a, b) => {
    const diff = portStatusRank(a.status) - portStatusRank(b.status);
    if (diff !== 0) return diff;
    return Number(b.id) - Number(a.id);
  });

  const best = list[0];
  const st = String(best.status || '').toLowerCase();
  if (HIDDEN_PORT_STATUSES.has(st)) {
    const runningBots = Number(best.running_bots || 0);
    if (st !== 'expired' || runningBots <= 0) return null;
  }
  return best;
}

const PORT_SLOT_HANDOFF_STATUSES = [
  'connected',
  'ready',
  'checking',
  'connecting',
  'starting',
  'failed',
  'cancelled'
];

/** Detach stale rows from a port slot so UI/connect do not pick the wrong login */
async function clearOtherAccountsOnPortSlot(queryFn, userId, portSlot, keepAccountId = null) {
  if (!userId || !portSlot) return;
  const params = [userId, portSlot];
  let sql = `
    UPDATE vps_system.mt5_accounts
    SET port_slot = NULL, updated_at = NOW()
    WHERE user_id = $1
      AND port_slot = $2
  `;
  if (keepAccountId) {
    params.push(keepAccountId);
    sql += ` AND id <> $3`;
  }
  await queryFn(sql, params).catch(() => {});
}

/**
 * ปล่อยบัญชีเก่าบน port_slot เมื่อจะ login คนใหม่ทับช่องเดิม (ไม่ต้องกดลบ PORT)
 * คืนแถวที่ถูก handoff — ใช้ต่อ stop_mt5 / release VPS binding
 */
async function listAccountsToHandoffOnPortSlot(queryFn, userId, portSlot, newLogin, serverName) {
  const uid = Number(userId || 0);
  const slot = Number(portSlot || 0);
  const login = String(newLogin || '').trim();
  const server = String(serverName || '').trim();
  if (!uid || !slot || !login || !server) return [];

  const r = await queryFn(
    `
    SELECT id, vps_id, port_id, assigned_port_no, windows_port_no, mt5_login, status
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND port_slot = $2
      AND LOWER(TRIM(COALESCE(status, ''))) = ANY($5::text[])
      AND NOT (
        mt5_login = $3
        AND COALESCE(server_name, mt5_server, '') = $4
      )
    ORDER BY updated_at DESC
  `,
    [uid, slot, login, server, PORT_SLOT_HANDOFF_STATUSES]
  ).catch(() => ({ rows: [] }));

  return r.rows || [];
}

/**
 * 1 PORT = 1 แถว — ทับ login/รหัสผ่าน/VPS binding บน port_slot เดิม (ไม่ INSERT ซ้ำ)
 * ลำดับ: อัปเดตตาม port_slot → อัปเดตตาม mt5_login → INSERT ใหม่
 */
async function upsertAccountForPortSlot(queryFn, opts = {}) {
  const userId = Number(opts.userId || 0);
  const portSlot = Number(opts.portSlot || 0);
  const mt5Login = String(opts.mt5Login || '').trim();
  const mt5Password = String(opts.mt5Password || '');
  const serverName = String(opts.serverName || '').trim();
  const vpsId = Number(opts.vpsId || 0);
  const portId = Number(opts.portId || 0);
  const allocPortNo = normalizeSystemFolderPortNo(Number(opts.allocPortNo || 0));
  const accountName = String(opts.accountName || `PORT ${portSlot}`);

  if (!allocPortNo) {
    return { id: null, mode: 'invalid_alloc_port' };
  }

  // Login จอง FolderPort 1–20 ชั่วคราว — ไม่ต้องตรงกับ package port_slot (100+slot)
  const enforceSlotFolderMatch = opts.enforceSlotFolderMatch === true;
  if (enforceSlotFolderMatch) {
    const expectedPortNo = expectedFolderPortForSlot(portSlot);
    if (expectedPortNo && allocPortNo !== expectedPortNo) {
      return { id: null, mode: 'invalid_alloc_port_slot_mismatch' };
    }
  }

  if (!userId || !portSlot || !mt5Login || !serverName) {
    return { id: null, mode: 'invalid' };
  }

  if (vpsId && allocPortNo) {
    await queryFn(
      `
      UPDATE vps_system.vps_port_health
      SET running = FALSE,
          mt5_login = NULL,
          balance = NULL,
          equity = NULL,
          updated_at = NOW()
      WHERE node_id = $1
        AND port_number = $2
    `,
      [vpsId, allocPortNo]
    ).catch(() => {});
  }

  const baseParams = [
    userId,
    portSlot,
    mt5Login,
    mt5Password,
    vpsId,
    portId,
    allocPortNo,
    serverName,
    accountName
  ];

  const setSql = `
    mt5_login=$3,
    mt5_password=$4,
    vps_id=$5,
    port_id=$6,
    port_slot=$2,
    assigned_port_no=$7,
    windows_port_no=$7,
    broker='MH Markets',
    server_name=$8,
    mt5_server=$8,
    account_name=$9,
    status='connecting',
    login_verified=FALSE,
    last_balance=NULL,
    last_equity=NULL,
    connected_at=NULL,
    connect_started_at=NOW(),
    last_error=NULL,
    last_login_message='① ส่งคำสั่ง login_mt5 ไป VPS...',
    updated_at=NOW()
  `;

  let r = await queryFn(
    `
    UPDATE vps_system.mt5_accounts
    SET ${setSql}
    WHERE user_id=$1
      AND port_slot=$2
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    RETURNING id
  `,
    baseParams
  ).catch(() => ({ rows: [] }));

  if (r.rows?.[0]) {
    return { id: Number(r.rows[0].id), mode: 'port_slot_overwrite' };
  }

  r = await queryFn(
    `
    UPDATE vps_system.mt5_accounts
    SET ${setSql}
    WHERE user_id=$1
      AND port_slot=$2
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('deleted', 'expired', 'failed')
    RETURNING id
  `,
    baseParams
  ).catch(() => ({ rows: [] }));

  if (r.rows?.[0]) {
    return { id: Number(r.rows[0].id), mode: 'port_slot_revive' };
  }

  r = await queryFn(
    `
    UPDATE vps_system.mt5_accounts
    SET ${setSql}
    WHERE user_id=$1
      AND mt5_login=$3
      AND COALESCE(server_name, mt5_server, '')=$8
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    RETURNING id
  `,
    baseParams
  ).catch(() => ({ rows: [] }));

  if (r.rows?.[0]) {
    return { id: Number(r.rows[0].id), mode: 'login_overwrite' };
  }

  r = await queryFn(
    `
    UPDATE vps_system.mt5_accounts
    SET ${setSql}
    WHERE user_id=$1
      AND mt5_login=$3
      AND COALESCE(server_name, mt5_server, '')=$8
      AND LOWER(TRIM(COALESCE(status, ''))) IN (
        'failed', 'ready', 'cancelled', 'expired', 'deleted'
      )
    RETURNING id
  `,
    baseParams
  ).catch(() => ({ rows: [] }));

  if (r.rows?.[0]) {
    return { id: Number(r.rows[0].id), mode: 'revive' };
  }

  try {
    r = await queryFn(
      `
    INSERT INTO vps_system.mt5_accounts
    (user_id, vps_id, port_id, port_slot, assigned_port_no, windows_port_no,
     mt5_login, mt5_password, broker, server_name, mt5_server, account_name, status,
     login_verified, last_error, last_login_message, connect_started_at, updated_at)
    VALUES
    ($1,$5,$6,$2,$7,$7,$3,$4,'MH Markets',$8,$8,$9,'connecting',FALSE,NULL,'① ส่งคำสั่ง login_mt5 ไป VPS...',NOW(),NOW())
    RETURNING id
  `,
      baseParams
    );
  } catch (insErr) {
    if (insErr?.code !== '23505') throw insErr;
    r = await queryFn(
      `
      UPDATE vps_system.mt5_accounts
      SET ${setSql}
      WHERE user_id=$1
        AND mt5_login=$3
        AND COALESCE(server_name, mt5_server, '')=$8
      RETURNING id
    `,
      baseParams
    ).catch(() => ({ rows: [] }));
  }

  if (r.rows?.[0]) {
    return { id: Number(r.rows[0].id), mode: 'insert' };
  }

  r = await queryFn(
    `
    INSERT INTO vps_system.mt5_accounts
    (
      user_id, vps_id, port_id, port_slot, assigned_port_no, windows_port_no,
      mt5_login, mt5_password, broker, server_name, mt5_server, account_name, status,
      login_verified, last_balance, last_equity, connected_at, connect_started_at,
      last_error, last_login_message, updated_at
    )
    VALUES
    ($1,$5,$6,$2,$7,$7,$3,$4,'MH Markets',$8,$8,$9,'connecting',
     FALSE,NULL,NULL,NULL,NOW(),NULL,'① ส่งคำสั่ง login_mt5 ไป VPS...',NOW())
    ON CONFLICT (user_id, mt5_login, server_name)
    DO UPDATE SET
      mt5_password=EXCLUDED.mt5_password,
      vps_id=EXCLUDED.vps_id,
      port_id=EXCLUDED.port_id,
      port_slot=EXCLUDED.port_slot,
      assigned_port_no=EXCLUDED.assigned_port_no,
      windows_port_no=EXCLUDED.windows_port_no,
      broker='MH Markets',
      mt5_server=EXCLUDED.mt5_server,
      account_name=EXCLUDED.account_name,
      status='connecting',
      login_verified=FALSE,
      last_balance=NULL,
      last_equity=NULL,
      connected_at=NULL,
      connect_started_at=NOW(),
      last_error=NULL,
      last_login_message='① ส่งคำสั่ง login_mt5 ไป VPS...',
      updated_at=NOW()
    RETURNING id
  `,
    baseParams
  ).catch(() => ({ rows: [] }));

  if (r.rows?.[0]) {
    return { id: Number(r.rows[0].id), mode: 'conflict_upsert' };
  }

  return { id: null, mode: 'failed' };
}

/** แถวอื่นที่ค้าง port_slot เดียวกัน — ถอดออก (เก็บแถวหลักไว้แถวเดียว) */
async function expireDuplicatePortSlotRows(queryFn, userId, portSlot, keepAccountId, message) {
  if (!userId || !portSlot || !keepAccountId) return;
  const msg = String(message || 'ถูกแทนที่ด้วยข้อมูล PORT ล่าสุด').trim();
  await queryFn(
    `
    UPDATE vps_system.mt5_accounts
    SET status='expired',
        port_slot=NULL,
        assigned_port_no=NULL,
        windows_port_no=NULL,
        vps_id=NULL,
        port_id=NULL,
        last_login_message=$4,
        updated_at=NOW()
    WHERE user_id=$1
      AND port_slot=$2
      AND id <> $3
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
  `,
    [userId, portSlot, keepAccountId, msg]
  ).catch(() => {});
}

module.exports = {
  pickAccountForPortSlot,
  clearOtherAccountsOnPortSlot,
  listAccountsToHandoffOnPortSlot,
  upsertAccountForPortSlot,
  expireDuplicatePortSlotRows,
  portStatusRank,
  PORT_SLOT_HANDOFF_STATUSES,
  accountHasEquityMetrics,
  isRunnableMt5Account
};
