'use strict';

/**
 * Avelqua VPS Agent API Production
 * Mount path: app.use('/api/vps-agent', require('./routes/vps-agent-api-production'))
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const { parseMt5JournalOutcome, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('../lib/mt5JournalVerify');
const { normalizeLockedServer } = require('../lib/mt5Server');
const {
  verifyLoginFromCommand,
  applyLoginMt5FromCommandResult,
  applyJournalReadCommandResult,
  findLoginCommandInProgress,
  extractJournalEvidence,
  promoteAccountConnected,
  handleLegacyWindowVerifiedConnect,
  tryApplyPendingJournalRead,
  queueJournalReadVerify,
  queueStopMt5ForAccount,
  failAccountFromJournal,
  syncJournalFromLatestCommand
} = require('../lib/mt5LoginCommandVerify');
const { ensureMt5PreviewColumns } = require('../lib/mt5Preview');
const {
  REQUIRED_AGENT_VERSION,
  AGENT_SCRIPT_PATH,
  agentVersionOk,
  queueAgentDeploy,
  getAgentUpgradeState,
  messageForUpgradeState,
  hasJournalGateMarker
} = require('../lib/agentDeploy');
const { patchAccountMt5Preview } = require('../lib/mt5Preview');
const {
  ensureMt5ConnectAttemptTables,
  expireStaleConnectAttempts,
  ingestCommandResultEvent,
  ingestConnectResultEvent,
  ingestPortHealthEvent
} = require('../lib/mt5ConnectAttempt');

const router = express.Router();

function sanitizeJournalText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')
    .slice(-8000);
}

function sanitizeResultValue(value, depth = 0) {
  if (depth > 8) return null;
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeJournalText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeResultValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'undefined') continue;
      out[key] = sanitizeResultValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** เก็บ result ลง jsonb โดยไม่ใส่ content ยาว (กัน PG error จาก null bytes / escape) */
function prepareCommandResultForDb(result) {
  if (!result || typeof result !== 'object') return {};
  const out = sanitizeResultValue(result);
  if (typeof out.content === 'string') {
    out.journalEvidence = sanitizeJournalText(out.content);
    delete out.content;
  }
  if (typeof out.journalEvidence === 'string') {
    out.journalEvidence = sanitizeJournalText(out.journalEvidence);
  }
  return out;
}

function positiveMoney(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function snapshotMetricsFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  const snap = result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : {};
  const balance = positiveMoney(result.balance ?? snap.balance);
  const equity = positiveMoney(result.equity ?? snap.equity);
  if (!balance && !equity) return null;
  return {
    balance,
    equity,
    currency: String(result.currency || result.accountCurrency || snap.currency || '').trim()
  };
}

async function findFreshLiveMetricEvidence(accountId) {
  const id = Number(accountId || 0);
  if (!id) return null;

  const accRes = await query(
    `
    SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.port_slot, a.mt5_login,
           a.last_balance, a.last_equity, a.connect_started_at, a.updated_at,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1
    LIMIT 1
  `,
    [id]
  ).catch(() => ({ rows: [] }));

  const acc = accRes.rows?.[0];
  if (!acc) return null;

  const now = Date.now();
  const startedAtMs = acc.connect_started_at ? new Date(acc.connect_started_at).getTime() : 0;
  const updatedAtMs = acc.updated_at ? new Date(acc.updated_at).getTime() : 0;
  const accountBalance = positiveMoney(acc.last_balance);
  const accountEquity = positiveMoney(acc.last_equity);

  if (
    (accountBalance || accountEquity)
    && updatedAtMs
    && now - updatedAtMs <= 2 * 60 * 1000
    && (!startedAtMs || updatedAtMs + 5000 >= startedAtMs)
  ) {
    return {
      source: 'account_metrics',
      portId: Number(acc.port_id || 0) || null,
      portNo: Number(acc.assigned_port_no || acc.port_slot || 0) || null,
      folderPath: String(acc.folder_path || '').trim(),
      mt5Login: String(acc.mt5_login || '').trim(),
      balance: accountBalance,
      equity: accountEquity
    };
  }

  const snapRes = await query(
    `
    SELECT result, finished_at
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('account_snapshot', 'sync_mt5_account', 'read_account_metrics')
      AND COALESCE(payload->>'accountId', '') = $1::text
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '3 minutes'
    ORDER BY id DESC
    LIMIT 5
  `,
    [String(id)]
  ).catch(() => ({ rows: [] }));

  for (const row of snapRes.rows || []) {
    const metrics = snapshotMetricsFromResult(row.result);
    if (!metrics) continue;
    const finishedAtMs = row.finished_at ? new Date(row.finished_at).getTime() : 0;
    if (!finishedAtMs) continue;
    if (now - finishedAtMs > 3 * 60 * 1000) continue;
    if (startedAtMs && finishedAtMs + 5000 < startedAtMs) continue;
    return {
      source: 'snapshot_command',
      portId: Number(acc.port_id || 0) || null,
      portNo: Number(acc.assigned_port_no || acc.port_slot || 0) || null,
      folderPath: String(acc.folder_path || '').trim(),
      mt5Login: String(acc.mt5_login || '').trim(),
      balance: metrics.balance,
      equity: metrics.equity
    };
  }

  return null;
}

async function promoteConnectedFromLiveMetrics({ accountId, portId, mt5Login, message } = {}) {
  const metrics = await findFreshLiveMetricEvidence(accountId);
  if (!metrics) return null;

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET last_balance=COALESCE($2::numeric, last_balance),
        last_equity=COALESCE($3::numeric, last_equity),
        updated_at=NOW()
    WHERE id=$1
  `,
    [Number(accountId), metrics.balance, metrics.equity]
  ).catch(() => {});

  await promoteAccountConnected({
    accountId: Number(accountId),
    portId: metrics.portId || portId || null,
    mt5Login: String(mt5Login || metrics.mt5Login || '').trim(),
    message: message || 'ยืนยันจากข้อมูล Balance/Equity บน MT5 แล้ว'
  }).catch(() => {});

  return metrics;
}

async function applyRunMt5BotCommandSideEffects(pl, result, ok, message) {
  const instanceId = Number(pl?.instanceId || pl?.instance_id || result?.instanceId || result?.instance_id || 0);
  if (!instanceId) return;

  const balance = positiveMoney(result?.balance ?? result?.mt5_balance ?? result?.mt5Balance);
  const equity = positiveMoney(result?.equity ?? result?.mt5_equity ?? result?.mt5Equity);
  const eaStatus = String(result?.eaStatus ?? result?.ea_status ?? '').trim();
  const failMsg = String(message || result?.message || result?.error || 'run_mt5_bot failed').trim() || 'run_mt5_bot failed';

  if (ok) {
    await query(`
      UPDATE vps_system.bot_instances
      SET status='running',
          ea_status=COALESCE(NULLIF($2::text, ''), 'ready'),
          mt5_balance=COALESCE($3::numeric, mt5_balance),
          mt5_equity=COALESCE($4::numeric, mt5_equity),
          last_error=NULL,
          last_agent_ping=NOW(),
          last_heartbeat=NOW(),
          updated_at=NOW()
      WHERE id=$1
    `, [instanceId, eaStatus, balance, equity]).catch(() => {});
  } else {
    await query(`
      UPDATE vps_system.vps_nodes n
      SET used_ports=GREATEST(0, COALESCE(n.used_ports,0) - COALESCE(bi.port_used,1)),
          used_lot=GREATEST(0, COALESCE(n.used_lot,0) - COALESCE(bi.lot_used,0)),
          status=CASE WHEN n.status='busy' THEN 'online' ELSE n.status END,
          updated_at=NOW()
      FROM vps_system.bot_instances bi
      WHERE bi.id=$1
        AND bi.vps_id=n.id
        AND LOWER(TRIM(COALESCE(bi.status,''))) IN ('pending','restarting')
    `, [instanceId]).catch(() => {});

    await query(`
      UPDATE vps_system.bot_instances
      SET status='failed',
          ea_status='error',
          last_error=$2,
          last_agent_ping=NOW(),
          updated_at=NOW()
      WHERE id=$1
    `, [instanceId, failMsg]).catch(() => {});
  }

  const accountId = Number(pl?.accountId || pl?.account_id || 0);
  if (accountId && (balance != null || equity != null)) {
    await query(`
      UPDATE vps_system.mt5_accounts
      SET last_balance = COALESCE($2::numeric, last_balance),
          last_equity = COALESCE($3::numeric, last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [accountId, balance, equity]).catch(() => {});
  }
}

async function processCommandResultSideEffects(node, commandId, ctype, pl, result, ok = true, message = '') {
  if (ctype === 'run_mt5_bot' || ctype === 'run_mt5') {
    await applyRunMt5BotCommandSideEffects(pl, result, ok, message);
    return;
  }

  const accountId = pl.accountId ?? pl.account_id;
  if (accountId == null || String(accountId) === '') return;

  if (ctype !== 'login_mt5') return;
  const attemptId = String(pl.attemptId || pl.attempt_id || '').trim();

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        finished_at=NOW(),
        updated_at=NOW(),
        error='cancelled: superseded by successful command'
    WHERE status IN ('pending','processing','picked')
      AND (node_id=$1 OR vps_id=$1)
      AND id <> $2
      AND command_type IN ('login_mt5','connect_mt5','run_mt5_bot','run_mt5')
      AND (payload->>'accountId') IS NOT NULL
      AND (payload->>'accountId')::text = $3::text
      AND ($4 = '' OR COALESCE(payload->>'attemptId', '') = $4)
  `,
    [node.id, commandId, String(accountId), attemptId]
  ).catch(() => {});
}

/** Agent ดาวน์โหลดสคริปต์ล่าสุด (payload deploy เล็ก ไม่ค้าง processing) */
router.get('/agent-script', async (req, res) => {
  try {
    const node = await findNode(req);
    if (!node) return res.status(401).send('INVALID_AGENT');
    if (!fs.existsSync(AGENT_SCRIPT_PATH)) {
      return res.status(404).send('agent script not found');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Agent-Build-Id', REQUIRED_AGENT_VERSION);
    return res.send(fs.readFileSync(AGENT_SCRIPT_PATH, 'utf8'));
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

async function ensureAgentTables() {
  await query(`CREATE SCHEMA IF NOT EXISTS vps_system`).catch(() => {});
  await ensureMt5ConnectAttemptTables().catch(() => {});

  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS node_code TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS agent_token TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN DEFAULT TRUE`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'offline'`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS cpu_percent NUMERIC(8,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS ram_percent NUMERIC(8,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS net_down_mbps NUMERIC(18,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS net_up_mbps NUMERIC(18,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS ping_ms NUMERIC(10,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS agent_version TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS process_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS last_pid BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS mt5_login TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS current_mt5_login TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_login_message TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await ensureMt5PreviewColumns();

  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.vps_agent_commands (
      id BIGSERIAL PRIMARY KEY,
      vps_id BIGINT,
      node_id BIGINT,
      port_id BIGINT,
      command_type TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      status TEXT DEFAULT 'pending',
      result JSONB DEFAULT '{}'::jsonb,
      result_message TEXT,
      error TEXT,
      picked_at TIMESTAMPTZ,
      locked_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.vps_node_logs (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT,
      status TEXT,
      level TEXT DEFAULT 'normal',
      cpu_percent NUMERIC(8,2) DEFAULT 0,
      ram_percent NUMERIC(8,2) DEFAULT 0,
      net_down_mbps NUMERIC(18,2) DEFAULT 0,
      net_up_mbps NUMERIC(18,2) DEFAULT 0,
      ping_ms NUMERIC(10,2) DEFAULT 0,
      last_error TEXT DEFAULT '',
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.vps_port_health (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT,
      port_number INT,
      folder_path TEXT,
      running BOOLEAN DEFAULT FALSE,
      process_id BIGINT,
      mt5_login TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(node_id, port_number)
    )
  `).catch(() => {});

  await query(`ALTER TABLE vps_system.vps_port_health ADD COLUMN IF NOT EXISTS mt5_login TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_port_health ADD COLUMN IF NOT EXISTS process_id BIGINT`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.mt5_login_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      account_id BIGINT,
      vps_id BIGINT,
      port_id BIGINT,
      port_no INT,
      mt5_login TEXT,
      server_name TEXT,
      status TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

async function findNode(req) {
  const token = req.headers['x-agent-token'] || req.body?.agent_token || req.query?.token || '';
  if (!token) return null;

  const r = await query(`
    SELECT *
    FROM vps_system.vps_nodes
    WHERE agent_token=$1 OR node_code=$1
    LIMIT 1
  `, [token]);
  return r.rows?.[0] || null;
}

router.post('/heartbeat', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });

    const cpu = Number(req.body.cpu_percent || 0);
    const ram = Number(req.body.ram_percent || 0);
    const down = Number(req.body.net_down_mbps || 0);
    const up = Number(req.body.net_up_mbps || 0);
    const ping = Number(req.body.ping_ms || 0);
    const lastError = req.body.last_error || '';
    const agentBuildId = String(req.body.agent_build_id || req.body.agentBuildId || '').trim();
    const agentVersion = String(
      agentBuildId || req.body.agent_version || req.body.agentVersion || ''
    ).trim();
    const status = node.agent_enabled === false ? 'offline' : 'online';
    const level = lastError ? 'error' : (cpu >= 90 || ram >= 90 || ping >= 400 ? 'alarm' : 'normal');
    const deployRequired = !agentVersionOk(req.body);

    await query(`
      UPDATE vps_system.vps_nodes
      SET status=$2,
          cpu_percent=$3,
          ram_percent=$4,
          net_down_mbps=$5,
          net_up_mbps=$6,
          ping_ms=$7,
          agent_version=$8,
          last_seen_at=NOW(),
          last_heartbeat=NOW(),
          updated_at=NOW()
      WHERE id=$1
    `, [node.id, status, cpu, ram, down, up, ping, agentVersion || null]).catch(async () => {
      await query(`
        UPDATE vps_system.vps_nodes
        SET status=$2, cpu_percent=$3, ram_percent=$4, last_seen_at=NOW(), updated_at=NOW()
        WHERE id=$1
      `, [node.id, status, cpu, ram]);
    });

    await query(`DELETE FROM vps_system.vps_node_logs WHERE created_at < NOW() - INTERVAL '5 days'`).catch(() => {});
    await query(`
      INSERT INTO vps_system.vps_node_logs
      (node_id,status,level,cpu_percent,ram_percent,net_down_mbps,net_up_mbps,ping_ms,last_error,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [node.id, status, level, cpu, ram, down, up, ping, lastError, JSON.stringify(req.body || {})]).catch(() => {});

    const nodeCode = String(node.node_code || req.body.computer_name || '').trim();
    if (nodeCode) {
      await query(`
        UPDATE vps_nodes
        SET status=$2,
            cpu_percent=$3,
            ram_percent=$4,
            net_down_mbps=$5,
            net_up_mbps=$6,
            ping_ms=$7,
            last_seen_at=NOW(),
            updated_at=NOW()
        WHERE UPPER(TRIM(COALESCE(node_name,''))) = UPPER(TRIM($8))
      `, [status, cpu, ram, down, up, ping, nodeCode]).catch(() => {});
    }

    await expireStaleConnectAttempts(node.id).catch(() => {});

    return res.json({
      ok: true,
      node_id: node.id,
      status,
      agent_enabled: node.agent_enabled !== false,
      deploy_required: deployRequired,
      required_agent_version: REQUIRED_AGENT_VERSION,
      agent_script_url: `${(process.env.AVELQUA_PUBLIC_URL || 'https://trading.avelqua.com').replace(/\/$/, '')}/api/vps-agent/agent-script`,
      agent_version: agentVersion || null
    });
  } catch (e) {
    console.error('[AGENT HEARTBEAT ERROR]', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.post('/port-health', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });

    const ports = Array.isArray(req.body.ports) ? req.body.ports : [];
    for (const p of ports) {
      const portNo = Number(p.port_no || p.portNo || p.portNumber || 0);
      if (!portNo) continue;
      const running = !!(p.running ?? p.is_running ?? p.isRunning);
      const pid = p.process_id || p.pid || null;
      const mt5Login = p.mt5_login || p.mt5Login || null;
      const folderPath = p.folder_path || p.folderPath || '';

      await query(`
        INSERT INTO vps_system.vps_port_health
        (node_id, port_number, folder_path, running, process_id, mt5_login, payload, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT (node_id, port_number)
        DO UPDATE SET
          folder_path=EXCLUDED.folder_path,
          running=EXCLUDED.running,
          process_id=EXCLUDED.process_id,
          mt5_login=EXCLUDED.mt5_login,
          payload=EXCLUDED.payload,
          updated_at=NOW()
      `, [node.id, portNo, folderPath, running, pid, mt5Login, JSON.stringify(p)]).catch(() => {});

      await query(`
        UPDATE vps_system.vps_ports
        SET process_id=$3,
            last_pid=$3,
            current_mt5_login=$4,
            updated_at=NOW()
        WHERE vps_id=$1 AND port_no=$2
      `, [node.id, portNo, pid, mt5Login]).catch(() => {});

      await ingestPortHealthEvent(node, p).catch(() => {});
    }

    return res.json({ ok: true, count: ports.length });
  } catch (e) {
    console.error('[PORT HEALTH ERROR]', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.get('/queue', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });

    await query(`
      UPDATE vps_system.vps_nodes
      SET status='online', last_seen_at=NOW(), last_heartbeat=NOW(), updated_at=NOW()
      WHERE id=$1
    `, [node.id]).catch(() => {});

    const { expireStuckMaintenanceCommands } = require('../lib/agentDeploy');
    await expireStuckMaintenanceCommands(node.id).catch(() => {});

    // Avoid idx_vac_no_dup_pending (unique pending per port_id + command_type):
    // only one stuck row per key becomes pending; extras or rows when a pending
    // already exists are cancelled instead of failing the whole UPDATE.
    await query(`
      WITH stuck AS (
        SELECT
          c.id,
          EXISTS (
            SELECT 1
            FROM vps_system.vps_agent_commands p
            WHERE p.status = 'pending'
              AND p.port_id = c.port_id
              AND p.command_type = c.command_type
              AND p.id <> c.id
          ) AS other_pending_exists,
          ROW_NUMBER() OVER (
            PARTITION BY c.port_id, c.command_type
            ORDER BY c.id ASC
          ) AS rn_same_key
        FROM vps_system.vps_agent_commands c
        WHERE c.status IN ('processing', 'picked')
          AND (c.node_id = $1 OR c.vps_id = $1)
          AND c.port_id IS NOT NULL
          AND c.finished_at IS NULL
          AND COALESCE(c.locked_at, c.started_at, c.picked_at, c.updated_at, c.created_at)
              < NOW() - INTERVAL '5 minutes'
      )
      UPDATE vps_system.vps_agent_commands c
      SET
        status = CASE
          WHEN s.other_pending_exists OR s.rn_same_key > 1 THEN 'cancelled'
          ELSE 'pending'
        END,
        locked_at = NULL,
        started_at = NULL,
        updated_at = NOW()
      FROM stuck s
      WHERE c.id = s.id
    `, [node.id]).catch(() => {});

    await query(`
      UPDATE vps_system.vps_agent_commands
      SET status='pending', locked_at=NULL, started_at=NULL, updated_at=NOW()
      WHERE status IN ('processing', 'picked')
        AND (node_id=$1 OR vps_id=$1)
        AND port_id IS NULL
        AND finished_at IS NULL
        AND COALESCE(locked_at, started_at, picked_at, updated_at, created_at)
            < NOW() - INTERVAL '5 minutes'
    `, [node.id]).catch(() => {});

    const r = await query(`
      WITH next_cmd AS (
        SELECT id
        FROM vps_system.vps_agent_commands
        WHERE status = 'pending'
          AND (node_id=$1 OR vps_id=$1)
          AND COALESCE(status, '') NOT IN ('success', 'failed', 'cancelled', 'expired')
        ORDER BY
          CASE
            WHEN command_type IN ('login_mt5', 'connect_mt5', 'run_mt5_bot', 'run_mt5') THEN 0
            WHEN command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent') THEN 2
            ELSE 1
          END,
          id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE vps_system.vps_agent_commands c
      SET
        status='processing',
        node_id=$1,
        vps_id=COALESCE(c.vps_id, $1),
        picked_at=NOW(),
        locked_at=NOW(),
        started_at=NOW(),
        updated_at=NOW()
      FROM next_cmd
      WHERE c.id = next_cmd.id
      RETURNING c.*
    `, [node.id]);

    const row = r.rows?.[0] || null;

    if (!row) {
      return res.json({
        ok: true,
        command: null
      });
    }

    return res.json({
      ok: true,
      command: {
        id: row.id,
        commandType: row.command_type,
        command_type: row.command_type,
        payload: row.payload || {}
      }
    });
  } catch (e) {
    console.error('[QUEUE ERROR]', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.post('/command-result', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });

    const commandId = Number(req.body.command_id || req.body.commandId || 0);
    if (!commandId) return res.status(400).json({ ok: false, message: 'NO_COMMAND_ID' });

    const ok = req.body.status === 'success' || req.body.ok === true;
    const result = req.body.result && typeof req.body.result === 'object' ? req.body.result : {};
    const plRow = await query(
      `SELECT payload, command_type FROM vps_system.vps_agent_commands WHERE id=$1`,
      [commandId]
    ).catch(() => ({ rows: [] }));
    const pl = plRow.rows?.[0]?.payload || {};
    const ctype = String(plRow.rows?.[0]?.command_type || '').toLowerCase();

    await query(`
      UPDATE vps_system.vps_agent_commands
      SET status=$1, result_message=$2, result=$3::jsonb, error=$4, finished_at=NOW(), updated_at=NOW()
      WHERE id=$5 AND (node_id=$6 OR vps_id=$6)
    `, [
      ok ? 'success' : 'failed',
      req.body.message || '',
      prepareCommandResultForDb(result),
      ok ? null : (req.body.message || 'failed'),
      commandId,
      node.id
    ]);

    await processCommandResultSideEffects(node, commandId, ctype, pl, result, ok, req.body.message || '');
    await ingestCommandResultEvent(node, {
      commandId,
      commandType: ctype,
      payload: pl,
      ok,
      result,
      error: ok ? null : (req.body.message || 'failed'),
      message: req.body.message || ''
    }).catch(() => {});

    return res.json({ ok: true });
  } catch (e) {
    console.error('[COMMAND RESULT ERROR]', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.post('/connect-result', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });
    const accountId = Number(req.body.accountId || req.body.account_id || 0);
    const portId = Number(req.body.portId || req.body.port_id || 0);
    const status = String(req.body.status || '').toLowerCase();
    const message = String(req.body.message || '');
    const windowTitle = String(req.body.windowTitle || req.body.mt5WindowTitle || '').trim();
    const previewB64 = String(req.body.previewImage || req.body.mt5PreviewImage || '').trim();

    if (!accountId) return res.status(400).json({ ok: false, message: 'NO_ACCOUNT_ID' });

    if (portId && ['starting', 'checking', 'connected'].includes(status)) {
      await query(`
        UPDATE vps_system.vps_ports
        SET status=$2,
            locked_until=CASE WHEN $2='locked' THEN NOW() + INTERVAL '3 minutes' ELSE locked_until END,
            last_error=NULL,
            updated_at=NOW()
        WHERE id=$1
      `, [portId, status === 'connected' ? 'running' : 'locked']).catch(() => {});
    }

    const outcome = await ingestConnectResultEvent(node, req.body).catch(() => ({ ok: true }));
    return res.json({ ok: true, ...outcome });
  } catch (e) {
    console.error('[CONNECT RESULT ERROR]', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

router.post('/commands/:id/result', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });

    const commandId = Number(req.params.id);
    if (!commandId) return res.status(400).json({ ok: false, message: 'NO_COMMAND_ID' });

    const ok = req.body.ok === true || String(req.body.status || '').toLowerCase() === 'success';
    const result = req.body.result && typeof req.body.result === 'object' ? req.body.result : {};
    const errMsg = String(req.body.error || '');
    const msg = ok
      ? String(result.message || result.status || req.body.message || '').slice(0, 2000)
      : String(errMsg || req.body.message || 'failed').slice(0, 2000);

    const pay = await query(
      `SELECT payload, command_type FROM vps_system.vps_agent_commands WHERE id=$1`,
      [commandId]
    ).catch(() => ({ rows: [] }));
    const pl = pay.rows?.[0]?.payload || {};
    const ctype = String(pay.rows?.[0]?.command_type || '').toLowerCase();

    const updateRes = await query(`
      UPDATE vps_system.vps_agent_commands
      SET status=$1,
          result_message=$2,
          result=$3::jsonb,
          error=$4,
          finished_at=NOW(),
          updated_at=NOW()
      WHERE id=$5 AND (node_id=$6 OR vps_id=$6)
    `, [ok ? 'success' : 'failed', msg, prepareCommandResultForDb(result), ok ? null : msg, commandId, node.id]);

    if (!updateRes.rowCount) {
      await query(`
        UPDATE vps_system.vps_agent_commands
        SET status=$1,
            result_message=$2,
            result=$3::jsonb,
            error=$4,
            finished_at=NOW(),
            updated_at=NOW()
        WHERE id=$5
      `, [ok ? 'success' : 'failed', msg, prepareCommandResultForDb(result), ok ? null : msg, commandId]);
    }

    try {
      await processCommandResultSideEffects(node, commandId, ctype, pl, result, ok, msg);
    } catch (sideEffectError) {
      console.error('[COMMAND RESULT SIDE EFFECT ERROR]', {
        commandId,
        commandType: ctype,
        error: sideEffectError?.message || sideEffectError
      });
    }
    await ingestCommandResultEvent(node, {
      commandId,
      commandType: ctype,
      payload: pl,
      ok,
      result,
      error: ok ? null : msg,
      message: msg
    }).catch(() => {});

    return res.json({ ok: true });
  } catch (e) {
    console.error('[COMMANDS ID RESULT ERROR]', e);
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

module.exports = router;
