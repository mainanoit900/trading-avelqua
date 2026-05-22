'use strict';

const { query } = require('../config/database');

/**
 * ตรวจว่า MT5 login ถูกใช้งานอยู่แล้วหรือไม่ (รวม user เดียวกันคนละ PORT)
 */
async function findMt5LoginInUse(mt5Login, serverName, currentUserId, exceptAccountId = null) {
  const login = String(mt5Login || '').trim();
  const server = String(serverName || '').trim();
  if (!login || !server) return null;

  const params = [login, server];
  let sql = `
    SELECT id, user_id, port_slot, assigned_port_no, port_id, status, updated_at
    FROM vps_system.mt5_accounts
    WHERE mt5_login = $1
      AND COALESCE(server_name, mt5_server, '') = $2
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'connecting', 'checking', 'starting')
  `;
  if (exceptAccountId) {
    params.push(exceptAccountId);
    sql += ` AND id <> $${params.length}`;
  }
  sql += ` ORDER BY updated_at DESC LIMIT 1`;

  const r = await query(sql, params).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return null;

  const inProgress = ['connecting', 'checking', 'starting'].includes(
    String(row.status || '').toLowerCase()
  );
  if (inProgress) {
    const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    if (Date.now() - updatedAt > 30 * 60 * 1000) return null;
    if (!row.port_id && !row.assigned_port_no) return null;
  }

  return {
    ...row,
    sameUser: Number(row.user_id) === Number(currentUserId)
  };
}

function mt5LoginInUseMessage(row) {
  if (!row) return '';
  const portHint = row.port_slot || row.assigned_port_no || row.port_id || '';
  if (row.sameUser) {
    return `Login นี้อยู่ที่ PORT ${portHint} แล้ว — ใช้ PORT นั้นเปิด BOT ได้เลย (1 ช่อง = 1 Login ห้ามซ้ำข้าม PORT)`;
  }
  return `บัญชี MT5 นี้มีผู้ใช้งานอยู่ในระบบแล้วที่ PORT ${portHint}`;
}

/** Login ถูกใช้บน PORT แพ็กเกจอื่นของ user เดียวกัน */
async function findMt5LoginOnOtherUserPort(userId, mt5Login, serverName, targetPortSlot) {
  const uid = Number(userId || 0);
  const login = String(mt5Login || '').trim();
  const server = String(serverName || '').trim();
  const slot = Number(targetPortSlot || 0);
  if (!uid || !login || !server || !slot) return null;

  const r = await query(
    `
    SELECT id, port_slot, assigned_port_no, status, mt5_login
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND mt5_login = $2
      AND COALESCE(server_name, mt5_server, '') = $3
      AND port_slot IS NOT NULL
      AND port_slot <> $4
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'connecting', 'checking', 'starting')
    ORDER BY
      CASE LOWER(COALESCE(status, ''))
        WHEN 'connected' THEN 0
        WHEN 'checking' THEN 1
        WHEN 'connecting' THEN 2
        ELSE 3
      END,
      updated_at DESC
    LIMIT 1
  `,
    [uid, login, server, slot]
  ).catch(() => ({ rows: [] }));

  return r.rows?.[0] || null;
}

function mt5LoginOnOtherPortMessage(row) {
  if (!row) return '';
  const portHint = row.port_slot || row.assigned_port_no || '';
  const st = String(row.status || '').toLowerCase();
  if (st === 'connected') {
    return `Login นี้เชื่อมต่ออยู่ที่ PORT ${portHint} แล้ว — คลิก PORT ${portHint} ไปขั้นตอน 3 เปิด BOT (ห้ามใช้เลขเดียวกันที่ PORT อื่น)`;
  }
  return `Login นี้กำลังเชื่อมต่อที่ PORT ${portHint} อยู่ — รอให้เสร็จหรือใช้เลข Login อื่นที่ PORT ว่าง`;
}

module.exports = {
  findMt5LoginInUse,
  findMt5LoginOnOtherUserPort,
  mt5LoginInUseMessage,
  mt5LoginOnOtherPortMessage
};
