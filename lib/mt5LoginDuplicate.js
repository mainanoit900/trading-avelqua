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

/**
 * ตรวจว่าผู้ใช้คนนี้มี MT5 กำลังใช้งานอยู่บน PORT/Folder อื่นแล้วหรือไม่
 * ใช้ทั้ง mt5_accounts ปัจจุบัน และ fallback จาก vps_port_health กรณี account row ถูก clear ไปแล้ว
 */
async function findUserActivePortInUse(currentUserId, exceptAccountId = null) {
  const userId = Number(currentUserId || 0);
  if (!userId) return null;

  const params = [userId];
  let sql = `
    SELECT id, user_id, mt5_login, port_slot, assigned_port_no, port_id, status, updated_at
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'connecting', 'checking', 'starting', 'ready')
  `;
  if (exceptAccountId) {
    params.push(exceptAccountId);
    sql += ` AND id <> $${params.length}`;
  }
  sql += ` ORDER BY updated_at DESC LIMIT 1`;

  const direct = await query(sql, params).catch(() => ({ rows: [] }));
  if (direct.rows?.[0]) {
    return {
      ...direct.rows[0],
      sameUser: true,
      from: 'account'
    };
  }

  const fbParams = [userId];
  let fallbackSql = `
    SELECT
      a.id,
      a.user_id,
      a.mt5_login,
      COALESCE(NULLIF(a.port_slot, 0), h.port_number) AS port_slot,
      COALESCE(NULLIF(a.assigned_port_no, 0), h.port_number) AS assigned_port_no,
      a.port_id,
      COALESCE(NULLIF(TRIM(a.status), ''), 'connected') AS status,
      h.updated_at
    FROM vps_system.vps_port_health h
    JOIN LATERAL (
      SELECT id, user_id, mt5_login, port_slot, assigned_port_no, port_id, status, updated_at
      FROM vps_system.mt5_accounts
      WHERE user_id = $1
        AND mt5_login = h.mt5_login
  `;
  if (exceptAccountId) {
    fbParams.push(exceptAccountId);
    fallbackSql += ` AND id <> $${fbParams.length}`;
  }
  fallbackSql += `
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    ) a ON TRUE
    WHERE h.running = TRUE
      AND h.updated_at > NOW() - INTERVAL '10 minutes'
    ORDER BY h.updated_at DESC
    LIMIT 1
  `;

  const fallback = await query(fallbackSql, fbParams).catch(() => ({ rows: [] }));
  if (!fallback.rows?.[0]) return null;
  return {
    ...fallback.rows[0],
    sameUser: true,
    from: 'port_health'
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

function mt5UserPortInUseMessage(row) {
  if (!row) return '';
  const portHint = row.port_slot || row.assigned_port_no || row.port_id || '';
  const loginHint = String(row.mt5_login || '').trim();
  const loginText = loginHint ? `MT5 ${loginHint}` : 'MT5';
  return `${loginText} กำลังใช้งานอยู่ที่ PORT ${portHint} — ไม่อนุญาตให้ซ้อนข้าม PORT/FOLDER กรุณาปิดตัวเดิมก่อน`;
}

module.exports = {
  findMt5LoginInUse,
  findUserActivePortInUse,
  mt5LoginInUseMessage,
  mt5UserPortInUseMessage
};
