'use strict';

const { query } = require('../config/database');

const ACTIVE_STATUSES = ['running', 'pending', 'restarting', 'connecting', 'starting'];
const DISPLAY_STATUSES = ['stopped', 'connecting', 'running', 'fail'];

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function normalizeInstanceDisplayStatus(row) {
  const status = String(row?.status || '').trim().toLowerCase();
  const ea = String(row?.ea_status || '').trim().toLowerCase();
  const err = String(row?.last_error || '').trim();

  if (status === 'deleted') return 'stopped';
  if (status === 'stopped') return 'stopped';
  if (status === 'failed' || ea === 'failed' || ea === 'error') return 'fail';
  if (status === 'running' && err && ea === 'error') return 'fail';
  if (status === 'running') return 'running';
  if (ACTIVE_STATUSES.includes(status) || status === 'pending') return 'connecting';
  if (status) return status;
  return 'connecting';
}

/** คงแถวล่าสุดต่อบัญชี/PORT — ลบประวัติซ้ำ (soft delete) */
async function purgeStaleBotInstances(userId) {
  const uid = num(userId, 0);
  if (!uid) return { purged: 0 };

  const result = await query(
    `
    WITH ranked AS (
      SELECT
        bi.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(bi.mt5_account_id, bi.id)
          ORDER BY
            CASE
              WHEN LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
              THEN 0
              ELSE 1
            END,
            bi.updated_at DESC NULLS LAST,
            bi.id DESC
        ) AS rn
      FROM vps_system.bot_instances bi
      WHERE bi.user_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) <> 'deleted'
    )
    UPDATE vps_system.bot_instances bi
    SET status = 'deleted',
        updated_at = NOW()
    FROM ranked r
    WHERE bi.id = r.id
      AND r.rn > 1
    RETURNING bi.id
    `,
    [uid]
  );

  return { purged: result.rowCount || 0 };
}

async function fetchDashboardInstances(userId, { limit = 10, offset = 0 } = {}) {
  const uid = num(userId, 0);
  const lim = Math.max(1, Math.min(50, num(limit, 10)));
  const off = Math.max(0, num(offset, 0));

  await purgeStaleBotInstances(uid).catch(() => {});

  const countRows = await query(
    `
    WITH ranked AS (
      SELECT bi.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(bi.mt5_account_id, bi.id)
          ORDER BY
            CASE
              WHEN LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
              THEN 0
              ELSE 1
            END,
            bi.updated_at DESC NULLS LAST,
            bi.id DESC
        ) AS rn
      FROM vps_system.bot_instances bi
      WHERE bi.user_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) <> 'deleted'
    )
    SELECT COUNT(*)::int AS total FROM ranked WHERE rn = 1
    `,
    [uid]
  );
  const total = num(countRows.rows?.[0]?.total, 0);

  const rows = await query(
    `
    WITH ranked AS (
      SELECT
        bi.id,
        bi.status,
        bi.ea_status,
        bi.assigned_port_no,
        bi.lot_used,
        bi.trade_level,
        bi.capital_used,
        bi.mt5_balance,
        bi.mt5_equity,
        bi.restart_count,
        bi.last_error,
        bi.last_agent_ping,
        bi.updated_at,
        bi.started_at,
        bi.mt5_account_id,
        bc.display_name,
        bc.bot_name,
        bc.bot_code,
        a.mt5_login,
        n.node_name,
        n.node_code,
        n.ping_ms,
        n.cpu_percent,
        n.ram_percent,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(bi.mt5_account_id, bi.id)
          ORDER BY
            CASE
              WHEN LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
              THEN 0
              ELSE 1
            END,
            bi.updated_at DESC NULLS LAST,
            bi.id DESC
        ) AS rn
      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
      LEFT JOIN vps_system.vps_nodes n ON n.id = bi.vps_id
      LEFT JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
      WHERE bi.user_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) <> 'deleted'
    )
    SELECT * FROM ranked
    WHERE rn = 1
    ORDER BY
      CASE
        WHEN LOWER(TRIM(COALESCE(status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
        THEN 0
        ELSE 1
      END,
      updated_at DESC NULLS LAST,
      id DESC
    LIMIT $2 OFFSET $3
    `,
    [uid, lim, off]
  );

  const instances = (rows.rows || []).map((row) => ({
    ...row,
    display_status: normalizeInstanceDisplayStatus(row)
  }));

  const pageSize = lim;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return {
    instances,
    total,
    pageSize,
    pageCount
  };
}

async function fetchActiveRunInstances(userId) {
  const uid = num(userId, 0);
  const rows = await query(
    `
    SELECT id, mt5_account_id, status, assigned_port_no, ea_status
    FROM vps_system.bot_instances
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
    ORDER BY id DESC
    `,
    [uid]
  );
  const seen = new Set();
  const out = [];
  for (const row of rows.rows || []) {
    const accountId = num(row.mt5_account_id, 0);
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    out.push({
      id: num(row.id),
      mt5_account_id: accountId,
      status: normalizeInstanceDisplayStatus(row),
      raw_status: String(row.status || ''),
      assigned_port_no: num(row.assigned_port_no, 0)
    });
  }
  return out;
}

module.exports = {
  ACTIVE_STATUSES,
  DISPLAY_STATUSES,
  normalizeInstanceDisplayStatus,
  purgeStaleBotInstances,
  fetchDashboardInstances,
  fetchActiveRunInstances
};
