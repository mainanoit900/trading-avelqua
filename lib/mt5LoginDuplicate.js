'use strict';

const { query } = require('../config/database');

function formatFolderPortLabel(portSlot) {
  const n = Number(portSlot || 0);
  if (!n) return 'FolderPort';
  return `FolderPort P${String(n).padStart(2, '0')}`;
}

/**
 * ตรวจว่า MT5 login ถูกใช้งานอยู่แล้วหรือไม่ (รวม user เดียวกันคนละ PORT)
 */
async function findMt5LoginInUse(mt5Login, serverName, currentUserId, exceptAccountId = null) {
  const login = String(mt5Login || '').trim();
  const server = String(serverName || '').trim();
  if (!login || !server) return null;

  const params = [login, server];
  let sql = `
    SELECT id, user_id, port_slot, assigned_port_no, port_id, status, updated_at, mt5_login
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
      AND LOWER(TRIM(COALESCE(status, ''))) IN (
        'connected', 'connecting', 'checking', 'starting', 'ready', 'failed'
      )
    ORDER BY
      CASE LOWER(COALESCE(status, ''))
        WHEN 'connected' THEN 0
        WHEN 'checking' THEN 1
        WHEN 'connecting' THEN 2
        WHEN 'starting' THEN 3
        WHEN 'ready' THEN 4
        ELSE 5
      END,
      updated_at DESC
    LIMIT 1
  `,
    [uid, login, server, slot]
  ).catch(() => ({ rows: [] }));

  return r.rows?.[0] || null;
}

/**
 * ข้อความมาตรฐาน: User/login ใช้งานอยู่ — 1 PORT = 1 Login = 1 FolderPort
 */
function mt5LoginBusyMessage(row, opts = {}) {
  if (!row) return '';
  const login = String(row.mt5_login || opts.login || '').trim();
  const portHint = Number(row.port_slot || row.assigned_port_no || opts.portSlot || 0);
  const targetSlot = Number(opts.targetPortSlot || 0);
  const folder = formatFolderPortLabel(portHint);
  const st = String(row.status || '').toLowerCase();

  if (targetSlot > 0 && portHint === targetSlot) {
    return '';
  }

  const loginPart = login ? ` (${login})` : '';
  if (st === 'connected') {
    return (
      `User นี้${loginPart} ใช้งานอยู่ที่ PORT ${portHint} · ${folder} แล้ว — ` +
      `คลิก PORT ${portHint} เท่านั้น (1 PORT = 1 Login = 1 FolderPort ห้ามข้ามช่อง)`
    );
  }
  if (['connecting', 'checking', 'starting'].includes(st)) {
    return (
      `User นี้${loginPart} กำลังเชื่อมต่อที่ PORT ${portHint} · ${folder} — ` +
      `รอให้เสร็จหรือใช้เลข Login อื่นที่ PORT ว่าง`
    );
  }
  return (
    `User นี้${loginPart} ใช้งานอยู่ที่ PORT ${portHint} · ${folder} แล้ว — ` +
    `ใช้เลข Login อื่นที่ PORT ${targetSlot || 'ที่เลือก'} (ไม่ข้าม FolderPort)`
  );
}

function mt5LoginInUseMessage(row, targetPortSlot = 0) {
  if (!row) return '';
  if (row.sameUser) {
    return mt5LoginBusyMessage(row, { targetPortSlot });
  }
  const portHint = row.port_slot || row.assigned_port_no || '';
  const login = String(row.mt5_login || '').trim();
  return `User นี้ (${login}) มีผู้ใช้งานในระบบแล้วที่ PORT ${portHint}`;
}

function mt5LoginOnOtherPortMessage(row, targetPortSlot = 0) {
  return mt5LoginBusyMessage(row, { targetPortSlot });
}

module.exports = {
  findMt5LoginInUse,
  findMt5LoginOnOtherUserPort,
  mt5LoginInUseMessage,
  mt5LoginOnOtherPortMessage,
  mt5LoginBusyMessage,
  formatFolderPortLabel
};
