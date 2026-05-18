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
    return `บัญชี MT5 นี้กำลังใช้งานอยู่ที่ PORT ${portHint} — ไม่สามารถ Login ซ้ำได้`;
  }
  return `บัญชี MT5 นี้มีผู้ใช้งานอยู่ในระบบแล้วที่ PORT ${portHint}`;
}

module.exports = {
  findMt5LoginInUse,
  mt5LoginInUseMessage
};
