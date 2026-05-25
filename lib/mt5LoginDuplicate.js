'use strict';

const { query } = require('../config/database');
const ACTIVE_PROGRESS_STATUSES = new Set(['connecting', 'checking', 'starting']);
const LIVE_PORT_STATUSES = ['running', 'locked', 'busy', 'used'];
const PROGRESS_MAX_AGE_MS = 20 * 60 * 1000;
const CONNECTED_GRACE_MS = 2 * 60 * 1000;

function formatFolderPortLabel(portSlot) {
  const n = Number(portSlot || 0);
  if (!n) return 'FolderPort';
  return `FolderPort P${String(n).padStart(2, '0')}`;
}

function clean(v) {
  return String(v || '').trim();
}

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function normStatus(v) {
  return clean(v).toLowerCase();
}

function isFresh(ts, maxAgeMs) {
  const ms = ts ? new Date(ts).getTime() : 0;
  return !!ms && Date.now() - ms <= maxAgeMs;
}

function systemPortNumbers(portNo) {
  const n = num(portNo);
  if (!n) return [];
  const out = new Set([n]);
  if (n >= 100) out.add(n % 100);
  else out.add(100 + n);
  return [...out].filter((x) => x > 0);
}

function rowPortNumbers(row) {
  return systemPortNumbers(num(row.assigned_port_no || row.windows_port_no || row.port_slot));
}

async function rowRepresentsLatestActiveUsage(row, login) {
  const status = normStatus(row.status);
  const loginText = clean(login || row.mt5_login);
  const portNos = rowPortNumbers(row);
  const hasBinding = !!(num(row.port_id) || num(row.vps_id) || portNos.length);

  if (ACTIVE_PROGRESS_STATUSES.has(status)) {
    return hasBinding && isFresh(row.updated_at, PROGRESS_MAX_AGE_MS);
  }
  if (status !== 'connected') {
    return false;
  }
  if (hasBinding && (isFresh(row.connected_at, CONNECTED_GRACE_MS) || isFresh(row.updated_at, CONNECTED_GRACE_MS))) {
    return true;
  }

  if (num(row.vps_id) && portNos.length) {
    const live = await query(
      `
      SELECT 1
      FROM vps_system.vps_port_health
      WHERE node_id = $1
        AND port_number = ANY($2::int[])
        AND running = TRUE
        AND updated_at > NOW() - INTERVAL '3 minutes'
        AND (
          COALESCE(NULLIF(TRIM(mt5_login), ''), $3) = $3
        )
      LIMIT 1
    `,
      [num(row.vps_id), portNos, loginText]
    ).catch(() => ({ rows: [] }));
    if (live.rows?.[0]) return true;
  }

  if (num(row.port_id)) {
    const db = await query(
      `
      SELECT 1
      FROM vps_system.vps_ports
      WHERE id = $1
        AND LOWER(TRIM(COALESCE(status, ''))) = ANY($2::text[])
        AND updated_at > NOW() - INTERVAL '15 minutes'
        AND (
          COALESCE(NULLIF(TRIM(current_mt5_login), ''), NULLIF(TRIM(mt5_login), ''), $3) = $3
        )
      LIMIT 1
    `,
      [num(row.port_id), LIVE_PORT_STATUSES, loginText]
    ).catch(() => ({ rows: [] }));
    if (db.rows?.[0]) return true;
  }

  return false;
}

async function findLatestMt5LoginUsage(mt5Login, serverName, exceptAccountId = null) {
  const login = clean(mt5Login);
  const server = clean(serverName);
  if (!login || !server) return null;

  const params = [login, server];
  let sql = `
    SELECT id, user_id, port_slot, assigned_port_no, windows_port_no, port_id, vps_id,
           status, updated_at, connected_at, mt5_login
    FROM vps_system.mt5_accounts
    WHERE mt5_login = $1
      AND COALESCE(server_name, mt5_server, '') = $2
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
  `;
  if (exceptAccountId) {
    params.push(exceptAccountId);
    sql += ` AND id <> $${params.length}`;
  }
  sql += `
    ORDER BY
      COALESCE(connected_at, updated_at) DESC NULLS LAST,
      updated_at DESC,
      id DESC
    LIMIT 8
  `;

  const r = await query(sql, params).catch(() => ({ rows: [] }));
  for (const row of r.rows || []) {
    if (await rowRepresentsLatestActiveUsage(row, login)) return row;
  }
  return null;
}

/**
 * ตรวจว่า MT5 login ถูกใช้งานอยู่แล้วหรือไม่ (รวม user เดียวกันคนละ PORT)
 */
async function findMt5LoginInUse(mt5Login, serverName, currentUserId, exceptAccountId = null) {
  const row = await findLatestMt5LoginUsage(mt5Login, serverName, exceptAccountId);
  if (!row) return null;

  return {
    ...row,
    sameUser: Number(row.user_id) === Number(currentUserId)
  };
}

/** Login ถูกใช้บน PORT แพ็กเกจอื่นของ user เดียวกัน */
async function findMt5LoginOnOtherUserPort(userId, mt5Login, serverName, targetPortSlot) {
  const uid = Number(userId || 0);
  const login = clean(mt5Login);
  const server = clean(serverName);
  const slot = Number(targetPortSlot || 0);
  if (!uid || !login || !server || !slot) return null;

  const row = await findLatestMt5LoginUsage(login, server);
  if (!row || Number(row.user_id) !== uid) return null;
  const portHint = Number(row.port_slot || row.assigned_port_no || 0);
  if (!portHint || portHint === slot) return null;
  return row;
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

  const loginPart = login ? ` (${login})` : '';
  if (targetSlot > 0 && portHint === targetSlot) {
    if (st === 'connected') {
      return `User นี้${loginPart} ใช้งานอยู่ที่ PORT ${portHint} · ${folder} แล้ว`;
    }
    if (['connecting', 'checking', 'starting'].includes(st)) {
      return `User นี้${loginPart} กำลังเชื่อมต่อที่ PORT ${portHint} · ${folder} — รอให้เสร็จก่อน`;
    }
  }
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
  findLatestMt5LoginUsage,
  findMt5LoginInUse,
  findMt5LoginOnOtherUserPort,
  mt5LoginInUseMessage,
  mt5LoginOnOtherPortMessage,
  mt5LoginBusyMessage,
  formatFolderPortLabel
};
