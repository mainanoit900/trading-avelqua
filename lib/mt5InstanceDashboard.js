'use strict';

const { query } = require('../config/database');
const { buildRunSummary } = require('./mt5BotPresets');

const ACTIVE_STATUSES = ['running', 'pending', 'restarting', 'connecting', 'starting'];
const DISPLAY_STATUSES = ['stopped', 'connecting', 'running', 'fail'];
const ACTIVE_STATUS_SQL = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

/** ลำดับแถว active ต่อบัญชี */
const INSTANCE_RANK_ORDER = `
            CASE
              WHEN LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_STATUS_SQL})
              THEN 0
              ELSE 1
            END,
            bi.started_at DESC NULLS LAST,
            bi.id DESC`;

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

function formatRunSummaryLot(summary) {
  if (!summary || summary.botKind === 'quantum') return 'EA อัตโนมัติ';
  const lot = num(summary.lot, NaN);
  if (!Number.isFinite(lot)) return '-';
  const lotPlus = num(summary.lotPlus, lot);
  if (Math.abs(lotPlus - lot) > 0.0001) {
    return Number(lot.toFixed(2)) + ' / ' + Number(lotPlus.toFixed(2));
  }
  return Number(lot.toFixed(2));
}

function enrichDashboardRow(row) {
  const payload = parseRunPayload(row);
  let summary = payload.runSummary && typeof payload.runSummary === 'object' ? payload.runSummary : null;
  const runTimeMode = String(
    summary?.runTimeMode || payload.runTimeMode || payload.run_time_mode || 'auto'
  ).trim().toLowerCase();

  let displayFunding;
  let displayLot;
  let displayLotText;

  if (!summary) {
    const payloadLot = num(payload.lot, NaN);
    const payloadCap = num(payload.capitalUsed ?? payload.capital, NaN);
    const cap = Number.isFinite(payloadCap) ? payloadCap : num(row.capital_used, 0);
    const lot = Number.isFinite(payloadLot) ? payloadLot : num(row.lot_used, 0);
    if (cap > 0 || lot > 0) {
      summary = buildRunSummary(
        {
          botKind: String(payload.botKind || 'ak'),
          capital: cap,
          lot,
          lotPlus: num(payload.lotPlus, lot),
          trade: { trade_level: row.trade_level || payload.tradeLevel || 'medium' }
        },
        row.trade_level || payload.tradeLevel || 'medium',
        runTimeMode
      );
    }
  }

  if (summary) {
    displayFunding = Number(num(summary.capital, 0).toFixed(2));
    displayLotText = formatRunSummaryLot(summary);
    const lotNum = summary.botKind === 'quantum' ? NaN : num(summary.lot, NaN);
    displayLot = Number.isFinite(lotNum) ? Number(lotNum.toFixed(2)) : null;
  } else {
    displayLot = num(row.lot_used, 0);
    displayFunding = num(row.capital_used, 0);
    displayLotText = String(displayLot);
  }

  const endedAt = row.stopped_at || payload.endedAt || null;

  return {
    run_time_mode: runTimeMode === '24h' ? '24h' : 'auto',
    order_time_label: summary?.timeLabel || orderTimeModeLabel(runTimeMode),
    display_lot: displayLot,
    display_lot_text: displayLotText,
    display_funding: displayFunding,
    history_ended_at: endedAt
  };
}

function positiveMoney(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Live: ครั้งแรกใช้ค่าจาก agent/บัญชีทันที หลังมี snapshot ใช้ equity จาก log (อัปเดตทุก 30 นาที) */
function mapLiveInstanceRow(row) {
  const snapshotEq = positiveMoney(row.snapshot_equity);
  const hasSnapshot = !!(row.last_equity_snapshot_at && snapshotEq != null);
  let balance = positiveMoney(row.mt5_balance);
  let equity = positiveMoney(row.mt5_equity);
  if (balance == null) balance = positiveMoney(row.account_last_balance) ?? 0;
  if (equity == null) equity = positiveMoney(row.account_last_equity) ?? 0;
  if (hasSnapshot) {
    equity = snapshotEq;
  } else if (equity <= 0 && balance > 0) {
    equity = balance;
  }
  let startEquity = positiveMoney(row.start_equity) ?? equity;
  let profit = num(row.profit, NaN);
  if (!Number.isFinite(profit)) {
    profit = startEquity > 0 && equity > 0 ? equity - startEquity : equity - balance;
  }
  const metricsAt = hasSnapshot
    ? row.last_equity_snapshot_at
    : (row.last_agent_ping || row.started_at || row.updated_at);
  return {
    ...row,
    mt5_balance: balance,
    mt5_equity: equity,
    start_equity: startEquity,
    profit: Number.isFinite(profit) ? Number(profit.toFixed(2)) : 0,
    live_balance: balance,
    live_equity: equity,
    live_profit: Number.isFinite(profit) ? Number(profit.toFixed(2)) : null,
    live_metrics_at: metricsAt,
    live_metrics_from_snapshot: hasSnapshot,
    display_status: normalizeInstanceDisplayStatus(row),
    ...attachConnectingMeta(row),
    ...enrichDashboardRow(row)
  };
}

function mapInstanceRow(row) {
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
    ...attachConnectingMeta(row),
    ...enrichDashboardRow(row)
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

/** ลบเฉพาะ active ซ้ำต่อบัญชี — ไม่ลบประวัติ stopped/failed */
async function purgeDuplicateActiveBotInstances(userId) {
  const uid = num(userId, 0);
  if (!uid) return { purged: 0 };

  const result = await query(
    `
    WITH ranked AS (
      SELECT
        bi.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(bi.mt5_account_id, bi.id)
          ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
        ) AS rn
      FROM vps_system.bot_instances bi
      WHERE bi.user_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_STATUS_SQL})
    )
    UPDATE vps_system.bot_instances bi
    SET status = 'stopped',
        stopped_at = COALESCE(bi.stopped_at, NOW()),
        updated_at = NOW(),
        ea_status = 'stopped',
        last_error = COALESCE(bi.last_error, 'superseded_by_newer_run')
    FROM ranked r
    WHERE bi.id = r.id
      AND r.rn > 1
    RETURNING bi.id
    `,
    [uid]
  );

  return { purged: result.rowCount || 0 };
}

/** @deprecated ใช้ purgeDuplicateActiveBotInstances */
async function purgeStaleBotInstances(userId) {
  return purgeDuplicateActiveBotInstances(userId);
}

const INSTANCE_SELECT = `
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
        bi.stopped_at,
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
        a.last_balance AS account_last_balance,
        a.last_equity AS account_last_equity,
        (
          SELECT el.equity
          FROM vps_system.mt5_equity_logs el
          WHERE el.instance_id = bi.id
          ORDER BY el.created_at DESC, el.id DESC
          LIMIT 1
        ) AS snapshot_equity,
        (
          SELECT LOWER(TRIM(COALESCE(c.status, '')))
          FROM vps_system.vps_agent_commands c
          WHERE (c.vps_id = bi.vps_id OR c.node_id = bi.vps_id)
            AND LOWER(TRIM(COALESCE(c.command_type, ''))) IN ('run_mt5_bot', 'run_mt5')
            AND TRIM(COALESCE(c.payload->>'instanceId', '')) = TRIM(bi.id::text)
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT 1
        ) AS agent_command_status`;

function connectingHintForRow(row) {
  const cmd = String(row?.agent_command_status || '').trim().toLowerCase();
  if (!cmd || cmd === 'pending') return 'รอ VPS รับคำสั่ง';
  if (['processing', 'picked', 'running', 'in_progress'].includes(cmd)) return 'VPS กำลังเปิดบอท';
  if (cmd === 'success' || cmd === 'done') return 'รอข้อมูล Balance/Equity';
  if (cmd === 'failed' || cmd === 'error') return 'คำสั่งล้มเหลว — กำลังตรวจสอบ';
  return 'กำลังเชื่อมต่อบอท';
}

function attachConnectingMeta(row) {
  const since = row?.started_at || row?.updated_at || null;
  const elapsedSec = since
    ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000))
    : 0;
  return {
    connecting_since: since,
    connecting_elapsed_sec: elapsedSec,
    connecting_hint: connectingHintForRow(row),
    agent_command_status: row?.agent_command_status || null
  };
}

/** Live: 1 แถวต่อ PORT ที่กำลัง active */
async function fetchLiveDashboardInstances(userId, { limit = 10, offset = 0 } = {}) {
  const uid = num(userId, 0);
  const lim = Math.max(1, Math.min(50, num(limit, 10)));
  const off = Math.max(0, num(offset, 0));

  await purgeDuplicateActiveBotInstances(uid).catch(() => {});

  const countRows = await query(
    `
    WITH ranked AS (
      SELECT bi.id,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(bi.mt5_account_id, bi.id)
          ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
        ) AS rn
      FROM vps_system.bot_instances bi
      WHERE bi.user_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_STATUS_SQL})
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
        ${INSTANCE_SELECT},
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(bi.mt5_account_id, bi.id)
          ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
        ) AS rn
      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
      LEFT JOIN vps_system.vps_nodes n ON n.id = bi.vps_id
      LEFT JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
      WHERE bi.user_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_STATUS_SQL})
    )
    SELECT * FROM ranked
    WHERE rn = 1
    ORDER BY started_at DESC NULLS LAST, id DESC
    LIMIT $2 OFFSET $3
    `,
    [uid, lim, off]
  );

  const instances = (rows.rows || []).map(mapLiveInstanceRow);
  const pageCount = Math.max(1, Math.ceil(total / lim));

  return {
    instances,
    total,
    pageSize: lim,
    pageCount,
    metricsIntervalMinutes: Number(process.env.MT5_EQUITY_SNAPSHOT_MINUTES || 30)
  };
}

/** ประวัติ: ทุกครั้งที่ Run = 1 แถว (หยุด/error แล้วยังอยู่) */
async function fetchHistoryInstances(userId, { limit = 10, offset = 0 } = {}) {
  const uid = num(userId, 0);
  const lim = Math.max(1, Math.min(50, num(limit, 10)));
  const off = Math.max(0, num(offset, 0));

  const countRows = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM vps_system.bot_instances bi
    WHERE bi.user_id = $1
      AND LOWER(TRIM(COALESCE(bi.status, ''))) <> 'deleted'
    `,
    [uid]
  );
  const total = num(countRows.rows?.[0]?.total, 0);

  const rows = await query(
    `
    SELECT
      ${INSTANCE_SELECT}
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
    LEFT JOIN vps_system.vps_nodes n ON n.id = bi.vps_id
    LEFT JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
    WHERE bi.user_id = $1
      AND LOWER(TRIM(COALESCE(bi.status, ''))) <> 'deleted'
    ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
    LIMIT $2 OFFSET $3
    `,
    [uid, lim, off]
  );

  const instances = (rows.rows || []).map(mapInstanceRow);
  const pageCount = Math.max(1, Math.ceil(total / lim));

  return { instances, total, pageSize: lim, pageCount };
}

/** @deprecated ใช้ fetchLiveDashboardInstances / fetchHistoryInstances */
async function fetchDashboardInstances(userId, opts) {
  return fetchHistoryInstances(userId, opts);
}

/**
 * บันทึกจบรอบเมื่อหยุดหรือ error (ไม่ลบแถว)
 */
async function finalizeBotInstanceRecord(instanceId, { status = 'stopped', lastError = null, db = null } = {}) {
  const id = num(instanceId, 0);
  if (!id) return null;
  const st = String(status || 'stopped').trim().toLowerCase();
  const sql = `
    UPDATE vps_system.bot_instances
    SET status = $2,
        stopped_at = COALESCE(stopped_at, NOW()),
        updated_at = NOW(),
        ea_status = CASE
          WHEN $2 IN ('failed', 'error') THEN 'error'
          ELSE COALESCE(NULLIF(TRIM(ea_status), ''), 'stopped')
        END,
        last_error = CASE WHEN $3::text IS NOT NULL AND $3::text <> '' THEN $3 ELSE last_error END,
        run_payload = COALESCE(run_payload, '{}'::jsonb) || jsonb_build_object(
          'endedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'endedBalance', COALESCE(mt5_balance, 0),
          'endedEquity', COALESCE(mt5_equity, 0),
          'endedStatus', $2
        )
    WHERE id = $1
    RETURNING *
  `;
  const params = [id, st === 'error' ? 'failed' : st, lastError];
  if (db && typeof db.query === 'function') {
    const r = await db.query(sql, params);
    return r.rows?.[0] || null;
  }
  const r = await query(sql, params);
  return r.rows?.[0] || null;
}

/** ปิดรอบ active เก่าบนบัญชีเดียวกันก่อน Run ใหม่ */
async function stopActiveInstancesForAccount(mt5AccountId, userId, db = null) {
  const accountId = num(mt5AccountId, 0);
  const uid = num(userId, 0);
  if (!accountId || !uid) return 0;

  const sql = `
    UPDATE vps_system.bot_instances
    SET status = 'stopped',
        stopped_at = COALESCE(stopped_at, NOW()),
        updated_at = NOW(),
        ea_status = 'stopped',
        run_payload = COALESCE(run_payload, '{}'::jsonb) || jsonb_build_object(
          'endedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
          'endedStatus', 'stopped',
          'endedReason', 'replaced_by_new_run'
        )
    WHERE mt5_account_id = $1
      AND user_id = $2
      AND LOWER(TRIM(COALESCE(status, ''))) IN (${ACTIVE_STATUS_SQL})
    RETURNING id
  `;
  const params = [accountId, uid];
  if (db && typeof db.query === 'function') {
    const r = await db.query(sql, params);
    return r.rowCount || 0;
  }
  const r = await query(sql, params);
  return r.rowCount || 0;
}

async function fetchActiveRunInstances(userId) {
  const uid = num(userId, 0);
  const rows = await query(
    `
    SELECT
      bi.id,
      bi.mt5_account_id,
      bi.status,
      bi.assigned_port_no,
      bi.ea_status,
      bi.started_at,
      (
        SELECT LOWER(TRIM(COALESCE(c.status, '')))
        FROM vps_system.vps_agent_commands c
        WHERE (c.vps_id = bi.vps_id OR c.node_id = bi.vps_id)
          AND LOWER(TRIM(COALESCE(c.command_type, ''))) IN ('run_mt5_bot', 'run_mt5')
          AND TRIM(COALESCE(c.payload->>'instanceId', '')) = TRIM(bi.id::text)
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT 1
      ) AS agent_command_status
    FROM vps_system.bot_instances bi
    WHERE bi.user_id = $1
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_STATUS_SQL})
    ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
    `,
    [uid]
  );
  const seen = new Set();
  const out = [];
  for (const row of rows.rows || []) {
    const accountId = num(row.mt5_account_id, 0);
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    const meta = attachConnectingMeta(row);
    out.push({
      id: num(row.id),
      mt5_account_id: accountId,
      status: normalizeInstanceDisplayStatus(row),
      raw_status: String(row.status || ''),
      assigned_port_no: num(row.assigned_port_no, 0),
      started_at: row.started_at || null,
      agent_command_status: meta.agent_command_status,
      connecting_since: meta.connecting_since,
      connecting_hint: meta.connecting_hint,
      connecting_elapsed_sec: meta.connecting_elapsed_sec
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
  purgeDuplicateActiveBotInstances,
  fetchDashboardInstances,
  fetchLiveDashboardInstances,
  fetchHistoryInstances,
  finalizeBotInstanceRecord,
  stopActiveInstancesForAccount,
  fetchActiveRunInstances
};
