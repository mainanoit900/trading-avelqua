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

module.exports = {
  pickAccountForPortSlot,
  clearOtherAccountsOnPortSlot,
  listAccountsToHandoffOnPortSlot,
  portStatusRank,
  PORT_SLOT_HANDOFF_STATUSES
};
