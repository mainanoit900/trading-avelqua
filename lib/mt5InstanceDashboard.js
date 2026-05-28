'use strict';

const { query } = require('../config/database');

const ACTIVE_STATUSES = ['running', 'pending', 'restarting', 'connecting', 'starting'];
const DISPLAY_STATUSES = ['stopped', 'connecting', 'running', 'fail'];

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parseRunPayload(row) {
  let raw = row?.run_payload;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function orderTimeModeLabel(mode) {
  return String(mode || 'auto').trim().toLowerCase() === '24h' ? 'Open 24H.' : 'Auto trading';
}

function enrichDashboardRow(row) {
  const payload = parseRunPayload(row);
  const payloadLot = num(payload.lot, NaN);
  const payloadCap = num(payload.capitalUsed ?? payload.capital, NaN);
  const runTimeMode = String(payload.runTimeMode || payload.run_time_mode || 'auto').trim().toLowerCase();
  const displayLot = Number.isFinite(payloadLot) ? payloadLot : num(row.lot_used, 0);
  const displayFunding = Number.isFinite(payloadCap) ? payloadCap : num(row.capital_used, 0);
  return {
    run_time_mode: runTimeMode === '24h' ? '24h' : 'auto',
    order_time_label: orderTimeModeLabel(runTimeMode),
    display_lot: Number(displayLot.toFixed(2)),
    display_funding: Number(displayFunding.toFixed(2))
  };
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
        bi.start_equity,
        bi.profit,
        bi.restart_count,
        bi.last_error,
        bi.last_agent_ping,
        bi.updated_at,
        bi.started_at,
        bi.mt5_account_id,
        bi.run_payload,
        bc.display_name,
        bc.bot_name,
        bc.bot_code,
        a.mt5_login,
        n.node_name,
        n.node_code,
        n.ping_ms,
        n.cpu_percent,
        n.ram_percent,
        (
          SELECT MAX(el.created_at)
          FROM vps_system.mt5_equity_logs el
          WHERE el.instance_id = bi.id
        ) AS last_equity_snapshot_at,
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

  const instances = (rows.rows || []).map((row) => {
    const balance = num(row.mt5_balance, 0);
    const equity = num(row.mt5_equity, 0);
    const startEquity = num(row.start_equity, 0);
    let profit = num(row.profit, NaN);
    if (!Number.isFinite(profit)) {
      profit = startEquity > 0 ? equity - startEquity : equity - balance;
    }
    return {
      ...row,
      mt5_balance: balance,
      mt5_equity: equity,
      start_equity: startEquity,
      profit: Number(profit.toFixed(2)),
      display_status: normalizeInstanceDisplayStatus(row),
      ...enrichDashboardRow(row)
    };
  });

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
  orderTimeModeLabel,
  enrichDashboardRow,
  purgeStaleBotInstances,
  fetchDashboardInstances,
  fetchActiveRunInstances
};
