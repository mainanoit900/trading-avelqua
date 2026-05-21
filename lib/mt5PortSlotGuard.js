'use strict';

const { query } = require('../config/database');

/** สถานะที่ถือว่า PORT แพ็กเกจของ user นี้ถูกใช้งานแล้ว */
const USER_PORT_SLOT_BUSY_STATUSES = [
  'connecting',
  'checking',
  'connected',
  'ready',
  'starting'
];

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
  const pno = Number(portNo || 0);
  const uid = Number(userId || 0);
  if (!vpsId || !pno || !uid) return null;

  const r = await query(
    `
    SELECT user_id, mt5_login, port_slot, status
    FROM vps_system.mt5_accounts
    WHERE vps_id = $1
      AND user_id <> $2
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'connecting', 'checking', 'starting')
      AND (
        port_slot = $3
        OR assigned_port_no = $3
        OR windows_port_no = $3
        OR (assigned_port_no >= 100 AND assigned_port_no % 100 = $3)
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [vpsId, uid, pno]
  ).catch(() => ({ rows: [] }));

  return r.rows?.[0] || null;
}

module.exports = {
  USER_PORT_SLOT_BUSY_STATUSES,
  getUserPortSlotOccupant,
  isUserPortSlotFreeForLogin,
  findFolderPortUsedByOtherUser
};
