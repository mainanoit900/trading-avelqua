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

module.exports = {
  pickAccountForPortSlot,
  clearOtherAccountsOnPortSlot,
  portStatusRank
};
