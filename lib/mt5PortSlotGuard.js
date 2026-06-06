'use strict';

const { query } = require('../config/database');
const { portNoVariants } = require('./mt5PortIsolation');

/** บัญชีที่ผูก assigned_port_no ตรงกับ package port_slot */
function sqlCorrectlyBoundSlotFolder(alias = 'a') {
  const a = alias;
  return `(
    ${a}.assigned_port_no = (100 + ${a}.port_slot)
    OR (${a}.assigned_port_no = ${a}.port_slot AND ${a}.port_slot > 0 AND ${a}.port_slot < 100)
  )`;
}

/** สถานะที่ถือว่า PORT แพ็กเกจของ user นี้ถูกใช้งานแล้ว */
const USER_PORT_SLOT_BUSY_STATUSES = [
  'connecting',
  'checking',
  'connected',
  'ready',
  'starting'
];

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const ACTIVE_BOT_STATUSES = [
  'running',
  'pending',
  'starting',
  'connecting',
  'restarting'
];

/** package port_slot ที่ user ใช้อยู่ (บัญชี active + บอทรัน) */
async function getUserBusyPortSlots(userId) {
  const uid = Number(userId || 0);
  if (!uid) return [];

  const slots = new Set();
  const acc = await query(
    `
    SELECT DISTINCT port_slot
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND port_slot IS NOT NULL
      AND LOWER(TRIM(COALESCE(status, ''))) = ANY($2::text[])
  `,
    [uid, USER_PORT_SLOT_BUSY_STATUSES]
  ).catch(() => ({ rows: [] }));
  for (const row of acc.rows || []) {
    const s = num(row.port_slot);
    if (s > 0) slots.add(s);
  }

  const bots = await query(
    `
    SELECT DISTINCT a.port_slot
    FROM vps_system.bot_instances bi
    JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
    WHERE bi.user_id = $1
      AND bi.stopped_at IS NULL
      AND LOWER(TRIM(COALESCE(bi.status, ''))) = ANY($2::text[])
      AND a.port_slot IS NOT NULL
  `,
    [uid, ACTIVE_BOT_STATUSES]
  ).catch(() => ({ rows: [] }));
  for (const row of bots.rows || []) {
    const s = num(row.port_slot);
    if (s > 0) slots.add(s);
  }

  return [...slots].sort((a, b) => a - b);
}

async function getUserPortSlotOccupant(userId, slot) {
  const uid = Number(userId || 0);
  const s = Number(slot || 0);
  if (!uid || !s) return null;

  const r = await query(
    `
    SELECT id, mt5_login, port_slot, status
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND port_slot = $2
      AND LOWER(TRIM(COALESCE(status, ''))) = ANY($3::text[])
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `,
    [uid, s, USER_PORT_SLOT_BUSY_STATUSES]
  ).catch(() => ({ rows: [] }));

  return r.rows?.[0] || null;
}

async function isUserPortSlotFreeForLogin(userId, slot, totalPorts, mt5Login = '') {
  const s = Number(slot || 0);
  const max = Number(totalPorts || 0);
  if (s < 1 || s > max) {
    return { ok: false, code: 'INVALID_SLOT', message: `PORT ${s} ไม่อยู่ในแพ็กเกจ (สูงสุด ${max} PORT)` };
  }

  const occ = await getUserPortSlotOccupant(userId, s);
  if (!occ) return { ok: true };

  const sameLogin = String(occ.mt5_login || '').trim() === String(mt5Login || '').trim();
  const st = String(occ.status || '').toLowerCase();
  if (sameLogin && st === 'connected') {
    return { ok: true, alreadyConnected: true, accountId: occ.id };
  }
  if (sameLogin && ['connecting', 'checking', 'starting'].includes(st)) {
    return { ok: true, inProgress: true, accountId: occ.id };
  }

  return {
    ok: false,
    code: 'SLOT_BUSY',
    message: `PORT ${s} ใช้โดย Login ${occ.mt5_login} อยู่แล้ว — เลือก PORT ว่างอื่นหรือลบบัญชีเดิมก่อน`,
    occupant: occ
  };
}

/** Folder PORT บน VPS — ห้าม user อื่นใช้เลข PORT เดียวกันพร้อมกัน */
async function findFolderPortUsedByOtherUser(systemVpsId, portNo, userId) {
  const vpsId = Number(systemVpsId || 0);
  const uid = Number(userId || 0);
  const variants = portNoVariants(portNo);
  if (!vpsId || !variants.length || !uid) return null;

  const r = await query(
    `
    SELECT a.user_id, a.mt5_login, a.port_slot, a.assigned_port_no, a.status, 'account' AS conflict_type
    FROM vps_system.mt5_accounts a
    WHERE a.vps_id = $1
      AND a.user_id <> $2
      AND LOWER(TRIM(COALESCE(a.status, ''))) IN ('connected', 'connecting', 'checking', 'starting', 'ready')
      AND a.assigned_port_no = ANY($3::int[])
      AND a.port_slot IS NOT NULL
      AND ${sqlCorrectlyBoundSlotFolder('a')}
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [vpsId, uid, variants]
  ).catch(() => ({ rows: [] }));

  if (r.rows?.[0]) return r.rows[0];

  const bot = await query(
    `
    SELECT bi.user_id, a.mt5_login, bi.assigned_port_no, bi.status, 'bot' AS conflict_type
    FROM vps_system.bot_instances bi
    JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
    WHERE bi.vps_id = $1
      AND bi.user_id <> $2
      AND bi.assigned_port_no = ANY($3::int[])
      AND bi.stopped_at IS NULL
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
        'running', 'pending', 'starting', 'connecting', 'restarting'
      )
    ORDER BY bi.updated_at DESC
    LIMIT 1
  `,
    [vpsId, uid, variants]
  ).catch(() => ({ rows: [] }));

  return bot.rows?.[0] || null;
}

async function assertFolderPortFreeForUser(vpsId, portNo, userId) {
  const conflict = await findFolderPortUsedByOtherUser(vpsId, portNo, userId);
  if (!conflict) return { ok: true };

  const login = String(conflict.mt5_login || '').trim() || '-';
  const portLabel = num(conflict.assigned_port_no || portNo);
  const kind = conflict.conflict_type === 'bot' ? 'บอทกำลังรัน' : 'MT5 ใช้งานอยู่';
  return {
    ok: false,
    code: 'FOLDER_PORT_BUSY',
    message: `FolderPort ${portLabel} ถูก User อื่นใช้อยู่ (${kind} Login ${login}) — ระบบเลือก PORT ว่างให้อัตโนมัติ กรุณาลองใหม่`,
    conflict
  };
}

/** ใช้ใน WHERE ของ vps_ports — ส่ง userId เป็น parameter แรกของ NOT EXISTS block */
function vpsPortNotBusyByOthersClause(userIdParamIndex) {
  const u = `$${Number(userIdParamIndex) || 1}`;
  return `
  AND NOT EXISTS (
    SELECT 1
    FROM vps_system.mt5_accounts a
    WHERE a.vps_id = p.vps_id
      AND a.user_id <> ${u}
      AND a.assigned_port_no = ANY(
        ARRAY[p.port_no, CASE WHEN p.port_no >= 100 THEN p.port_no - 100 ELSE p.port_no + 100 END]
      )
      AND LOWER(TRIM(COALESCE(a.status, ''))) IN (
        'connected', 'connecting', 'checking', 'starting', 'ready'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM vps_system.bot_instances bi
    WHERE bi.vps_id = p.vps_id
      AND bi.user_id <> ${u}
      AND bi.assigned_port_no = ANY(
        ARRAY[p.port_no, CASE WHEN p.port_no >= 100 THEN p.port_no - 100 ELSE p.port_no + 100 END]
      )
      AND bi.stopped_at IS NULL
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
        'running', 'pending', 'starting', 'connecting', 'restarting'
      )
  )
  `;
}

const VPS_PORT_BINDING_STATUSES = [
  'connecting',
  'checking',
  'starting',
  'connected',
  'ready'
];

/** ปล่อยแถวอื่นบน vps+folder เดียวกันก่อน promote connected (กัน uq_mt5_running_vps_port) */
async function releaseStaleVpsPortBindings(vpsId, portNo, keepAccountId = null) {
  const vid = num(vpsId);
  const pno = num(portNo);
  if (!vid || !pno) return 0;

  const params = [vid, pno];
  let sql = `
    UPDATE vps_system.mt5_accounts
    SET status='expired',
        assigned_port_no=NULL,
        windows_port_no=NULL,
        vps_id=NULL,
        port_id=NULL,
        last_login_message='ถูกแทนที่ด้วยการเชื่อมต่อใหม่',
        updated_at=NOW()
    WHERE vps_id=$1
      AND assigned_port_no=$2
      AND LOWER(COALESCE(status, '')) = ANY($3::text[])
      AND NOT EXISTS (
        SELECT 1 FROM vps_system.bot_instances bi
        WHERE bi.mt5_account_id = vps_system.mt5_accounts.id
          AND bi.stopped_at IS NULL
          AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
            'running', 'pending', 'restarting', 'starting', 'connecting'
          )
      )
  `;
  params.push(VPS_PORT_BINDING_STATUSES);
  if (keepAccountId) {
    params.push(Number(keepAccountId));
    sql += ` AND id <> $${params.length}`;
  }

  const r = await query(sql, params).catch(() => ({ rows: [] }));
  return r.rows?.length || 0;
}

/** ล้าง misbind + แถวค้างก่อน promote account เป็น connected */
async function clearVpsPortPromotionBlockers(vpsId, portNo, keepAccountId = null) {
  const purged = await purgeMisboundFolderOccupants(vpsId, portNo).catch(() => 0);
  const released = await releaseStaleVpsPortBindings(vpsId, portNo, keepAccountId).catch(() => 0);
  return (purged || 0) + (released || 0);
}

/** ล้างบัญชี misbind ค้างบน FolderPort (ไม่บล็อก user อื่น) */
async function purgeMisboundFolderOccupants(vpsId, portNo) {
  const vid = num(vpsId);
  const variants = portNoVariants(portNo);
  if (!vid || !variants.length) return 0;

  const r = await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='cancelled',
        assigned_port_no=NULL,
        windows_port_no=NULL,
        vps_id=NULL,
        port_id=NULL,
        last_login_message='ยกเลิก — ผูก FolderPort ไม่ตรง PORT',
        updated_at=NOW()
    WHERE vps_id=$1
      AND assigned_port_no = ANY($2::int[])
      AND port_slot IS NOT NULL
      AND LOWER(COALESCE(status, '')) IN ('checking', 'connecting', 'starting', 'ready')
      AND NOT ${sqlCorrectlyBoundSlotFolder('mt5_accounts')}
    RETURNING id
  `,
    [vid, variants]
  ).catch(() => ({ rows: [] }));

  return r.rows?.length || 0;
}

module.exports = {
  USER_PORT_SLOT_BUSY_STATUSES,
  ACTIVE_BOT_STATUSES,
  sqlCorrectlyBoundSlotFolder,
  clearVpsPortPromotionBlockers,
  releaseStaleVpsPortBindings,
  purgeMisboundFolderOccupants,
  assertFolderPortFreeForUser,
  findFolderPortUsedByOtherUser,
  getUserBusyPortSlots,
  getUserPortSlotOccupant,
  isUserPortSlotFreeForLogin,
  vpsPortNotBusyByOthersClause
};
