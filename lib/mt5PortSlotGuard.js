'use strict';

const { query } = require('../config/database');
const { portNoVariants } = require('./mt5PortIsolation');

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
    SELECT user_id, mt5_login, port_slot, assigned_port_no, status, 'account' AS conflict_type
    FROM vps_system.mt5_accounts
    WHERE vps_id = $1
      AND user_id <> $2
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'connecting', 'checking', 'starting', 'ready')
      AND assigned_port_no = ANY($3::int[])
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

module.exports = {
  USER_PORT_SLOT_BUSY_STATUSES,
  assertFolderPortFreeForUser,
  findFolderPortUsedByOtherUser,
  getUserPortSlotOccupant,
  isUserPortSlotFreeForLogin,
  vpsPortNotBusyByOthersClause
};
