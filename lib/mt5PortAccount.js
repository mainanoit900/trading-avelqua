'use strict';

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
  if (HIDDEN_PORT_STATUSES.has(String(best.status || '').toLowerCase())) return null;
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
  const allocPortNo = Number(opts.allocPortNo || portSlot);
  const accountName = String(opts.accountName || `PORT ${portSlot}`);

  if (!userId || !portSlot || !mt5Login || !serverName) {
    return { id: null, mode: 'invalid' };
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
  PORT_SLOT_HANDOFF_STATUSES
};
