'use strict';

/**
 * Avelqua VPS Agent API Production
 * Mount path: app.use('/api/vps-agent', require('./routes/vps-agent-api-production'))
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const {
  parseMt5JournalOutcome,
  messageIndicatesLoginFailed,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG
} = require('../lib/mt5JournalVerify');
const { normalizeLockedServer } = require('../lib/mt5Server');
const {
  verifyLoginFromCommand,
  applyLoginMt5FromCommandResult,
  applyLoginMt5CommandFailed,
  applyJournalReadCommandResult,
  findLoginCommandInProgress,
  extractJournalEvidence,
  promoteAccountConnected,
  handleLegacyWindowVerifiedConnect,
  tryApplyPendingJournalRead,
  queueJournalReadVerify,
  queueStopMt5ForAccount,
  failAccountFromJournal
} = require('../lib/mt5LoginCommandVerify');
const { ensureMt5PreviewColumns } = require('../lib/mt5Preview');
const { applyMt5LiveStatus } = require('../lib/mt5LiveStatus');
const {
  normalizeAgentCommandType,
  normalizeRunBotPayloadAction
} = require('../lib/mt5CommandNormalize');
const {
  REQUIRED_AGENT_VERSION,
  AGENT_SCRIPT_PATH,
  agentVersionOk,
  queueAgentDeploy,
  getAgentUpgradeState,
  messageForUpgradeState,
  hasJournalGateMarker,
  hasRunBotMarker,
  expireStuckMaintenanceCommands
} = require('../lib/agentDeploy');
const { patchAccountMt5Preview } = require('../lib/mt5Preview');
const { applyEquityFromCommandResult } = require('../lib/mt5EquitySync');
const { applyRunBotCommandResult } = require('../lib/mt5RunBotResult');
const { sanitizePgText, deepSanitizeForPg, toJsonbParam } = require('../lib/pgSanitize');

const router = express.Router();

function sanitizeJournalText(text) {
  return sanitizePgText(text).slice(-8000);
}

/** เก็บ result ลง jsonb โดยไม่ใส่ content ยาว (กัน PG error จาก null bytes / escape) */
function prepareCommandResultForDb(result) {
  if (!result || typeof result !== 'object') return {};
  const out = deepSanitizeForPg({ ...result });
  if (typeof out.content === 'string') {
    const j = sanitizeJournalText(out.content);
    if (j && /authorized on|authorization on/i.test(j)) {
      out.journalEvidence = j;
    }
    delete out.content;
  }
  if (typeof out.journalEvidence === 'string') {
    out.journalEvidence = sanitizeJournalText(out.journalEvidence);
  }
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && out[k].length > 16000) {
      out[k] = sanitizePgText(out[k]).slice(-8000);
    }
  }
  return out;
}

async function processCommandResultSideEffects(node, commandId, ctype, pl, result, opts = {}) {
  const ok = opts.ok !== false;
  const message = String(opts.message || '');

  const t = String(ctype || '').toLowerCase();
  const isRunBotCmd =
    t === 'run_bot' ||
    t === 'restart_ea' ||
    (pl?.instanceId != null &&
      ['run_mt5_bot', 'run_mt5', 'restart_mt5_bot', 'restart_mt5'].includes(t));

  if (isRunBotCmd) {
    await applyRunBotCommandResult({ pl, result, ok, message }).catch((e) => {
      console.error('[run_bot result]', e.message || e);
    });
    return;
  }

  const accountId = pl.accountId ?? pl.account_id;
  const purpose = String(pl.purpose || '');

  if (ctype === 'login_mt5' || ctype === 'connect_mt5') {
    if (!ok) {
      await applyLoginMt5CommandFailed(node, pl, { message, result }).catch((e) => {
        console.error('[login_mt5 failed]', e.message || e);
      });
      return;
    }
    await applyLoginMt5FromCommandResult(node, pl, result).catch(() => {});
    return;
  }

  if (!ok) return;
  if (
    (ctype === 'read_file' || ctype === 'port_read_file')
    && purpose === 'verify_mt5_journal'
  ) {
    await applyJournalReadCommandResult(node, pl, result).catch(() => {});
    const aid = pl.accountId ?? pl.account_id;
    if (aid != null && String(aid) !== '') {
      await tryApplyPendingJournalRead(Number(aid), node.id).catch(() => {});
    }
  }

  let equityApplied = false;
  if (
    (ctype === 'read_file' || ctype === 'port_read_file')
    && (purpose === 'equity_sync' || purpose === 'equity_sync_journal')
  ) {
    const aid = Number(pl.accountId ?? pl.account_id ?? 0);
    if (aid > 0) {
      equityApplied = await applyEquityFromCommandResult(aid, result).catch(() => false);
    }
  }

  if (
    ok &&
    ['sync_mt5_account', 'account_snapshot', 'read_account_metrics', 'dashboard', 'watchdog'].includes(
      t
    )
  ) {
    const aid = Number(pl.accountId ?? pl.account_id ?? 0);
    const instanceId = Number(pl.instanceId ?? pl.instance_id ?? 0);
    const portNo = Number(pl.portNumber ?? pl.port ?? pl.port_no ?? pl.portSlot ?? 0);
    const { metricsFromSnapshotResult, metricsFromCommandResult, applyEquityToAccount } = require('../lib/mt5EquitySync');
    let metrics = metricsFromSnapshotResult(result);
    if (!metrics || (!metrics.balance && !metrics.equity)) {
      metrics = metricsFromCommandResult(result, portNo);
    }
    if (metrics && (metrics.balance || metrics.equity)) {
      if (aid > 0) {
        await applyEquityToAccount(aid, metrics.balance, metrics.equity).catch(() => {});
      }
      if (instanceId > 0) {
        await applyMt5LiveStatus({
          instanceId,
          accountId: aid || undefined,
          port: pl.portNumber ?? pl.port ?? pl.port_no,
          balance: metrics.balance,
          equity: metrics.equity,
          profit: metrics.profit,
          status: 'running'
        }).catch(() => {});
      }
      equityApplied = true;
    }
  }

  if (accountId == null || String(accountId) === '') return;

  const shouldCancelSiblings =
    ctype === 'login_mt5' ||
    (purpose.startsWith('equity_sync') && equityApplied);

  if (!shouldCancelSiblings) return;

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
      AND (payload->>'accountId') IS NOT NULL
      AND (payload->>'accountId')::text = $3::text
  `,
    [node.id, commandId, String(accountId)]
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

router.post('/mt5/live-status', async (req, res) => {
  try {
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });
    const out = await applyMt5LiveStatus(req.body || {});
    return res.json(out);
  } catch (e) {
    console.error('[mt5/live-status]', e.message || e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

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

    if (deployRequired && node.agent_enabled !== false) {
      try {
        await expireStuckMaintenanceCommands(node.id);
        await queueAgentDeploy(node.id);
      } catch (deployErr) {
        console.error('[heartbeat deploy]', deployErr.message || deployErr);
      }
    }

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
      await query(
        `
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
           OR UPPER(TRIM(COALESCE(node_name,''))) = UPPER(TRIM($9))
      `,
        [status, cpu, ram, down, up, ping, nodeCode, String(node.node_code || '').trim()]
      ).catch(() => {});
    }

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

function mt5FolderForPort(portNo) {
  const n = Number(portNo) || 1;
  return `C:\\MT5_PORTS\\VPS-WIN-01-PORT-${String(n).padStart(2, '0')}`;
}

router.get('/running-sync', async (req, res) => {
  try {
    await ensureAgentTables();
    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });

    const rows = await query(
      `
      SELECT bi.id AS "instanceId",
             bi.assigned_port_no AS port,
             bi.mt5_account_id AS "accountId",
             bi.user_id AS "userId"
      FROM vps_system.bot_instances bi
      WHERE bi.vps_id = $1
        AND bi.status IN ('running', 'pending', 'restarting', 'starting')
        AND bi.assigned_port_no IS NOT NULL
      ORDER BY bi.id DESC
      LIMIT 50
    `,
      [node.id]
    );

    const items = (rows.rows || []).map((r) => {
      const port = Number(r.port || 0);
      const folder = mt5FolderForPort(port);
      return {
        instanceId: r.instanceId,
        port,
        portNumber: port,
        portSlot: port,
        accountId: r.accountId,
        userId: r.userId,
        vpsFolderPath: folder,
        folder_path: folder
      };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ ok: false, items: [], message: e.message });
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

    await query(
      `
      UPDATE vps_system.vps_agent_commands
      SET command_type = CASE command_type
            WHEN 'run_bot' THEN 'run_mt5_bot'
            WHEN 'restart_ea' THEN 'restart_mt5_bot'
            ELSE command_type
          END,
          updated_at = NOW()
      WHERE (node_id = $1 OR vps_id = $1)
        AND status = 'pending'
        AND command_type IN ('run_bot', 'restart_ea')
    `,
      [node.id]
    ).catch(() => {});

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
            WHEN command_type IN ('login_mt5', 'connect_mt5') THEN 0
            WHEN command_type IN ('run_mt5_bot', 'run_mt5', 'run_bot', 'restart_mt5_bot', 'restart_ea') THEN 1
            WHEN command_type IN (
              'deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent'
            ) THEN 3
            WHEN command_type IN ('dashboard', 'watchdog', 'account_snapshot', 'sync_mt5_account') THEN 4
            ELSE 2
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

    let row = r.rows?.[0] || null;

    if (!row) {
      return res.json({
        ok: true,
        command: null
      });
    }

    const normalizedType = normalizeAgentCommandType(row.command_type);
    if (normalizedType !== row.command_type) {
      await query(
        `UPDATE vps_system.vps_agent_commands SET command_type=$2, updated_at=NOW() WHERE id=$1`,
        [row.id, normalizedType]
      ).catch(() => {});
      row = { ...row, command_type: normalizedType };
    }

    const payload = normalizeRunBotPayloadAction(row.payload || {}, normalizedType);

    return res.json({
      ok: true,
      command: {
        id: row.id,
        commandType: normalizedType,
        command_type: normalizedType,
        payload
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

    await processCommandResultSideEffects(node, commandId, ctype, pl, result, {
      ok,
      message: req.body.message || ''
    });

    await query(`
      UPDATE vps_system.vps_agent_commands
      SET status=$1, result_message=$2, result=$3::jsonb, error=$4, finished_at=NOW(), updated_at=NOW()
      WHERE id=$5 AND (node_id=$6 OR vps_id=$6)
    `, [
      ok ? 'success' : 'failed',
      sanitizePgText(req.body.message || ''),
      toJsonbParam(prepareCommandResultForDb(result)),
      ok ? null : sanitizePgText(req.body.message || 'failed'),
      commandId,
      node.id
    ]);

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
    const message = req.body.message || '';
    const pid = req.body.process_id || req.body.pid || null;
    const mt5Login = req.body.mt5Login || req.body.mt5_login || null;
    const portNo = Number(req.body.portNumber || req.body.portNo || req.body.port_no || req.body.port || 0);
    const windowTitle = String(req.body.windowTitle || req.body.mt5WindowTitle || '').trim();
    const previewB64 = String(req.body.previewImage || req.body.mt5PreviewImage || '').trim();

    if (!accountId) return res.status(400).json({ ok: false, message: 'NO_ACCOUNT_ID' });

    if (status === 'starting' || status === 'checking') {
      const loginHint = String(mt5Login || '').trim();
      const titleBlob = `${windowTitle} ${message}`;
      if (messageIndicatesLoginFailed(titleBlob, loginHint)) {
        await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
          vpsId: node.id,
          portNo,
          reason: 'journal_during_checking'
        }).catch(() => {});
        return res.json({ ok: true, failed: true, message: MT5_FAIL_USER_MSG });
      }

      await patchAccountMt5Preview(accountId, {
        status,
        message: message || (status === 'starting' ? 'กำลังเปิดหน้าจอ MT5...' : 'กำลังตรวจ Login MT5...'),
        windowTitle,
        previewB64
      });

      if (portId) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='locked', locked_until=NOW() + INTERVAL '3 minutes', last_error=NULL, updated_at=NOW()
          WHERE id=$1
        `, [portId]).catch(() => {});
      }

      return res.json({ ok: true });
    }

    if (status === 'connected') {
      const loginVerified = req.body.loginVerified === true || req.body.login_verified === true;
      const windowVerified = req.body.windowVerified === true || req.body.window_verified === true;
      if (!loginVerified) {
        console.warn('[connect-result] ignore connected without loginVerified', { accountId, mt5Login });
        return res.json({ ok: true, ignored: true, reason: 'LOGIN_NOT_VERIFIED' });
      }

      let loginForJournal = String(mt5Login || '').trim();
      if (!loginForJournal) {
        const accRow = await query(
          `SELECT mt5_login FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
          [accountId]
        ).catch(() => ({ rows: [] }));
        loginForJournal = String(accRow.rows?.[0]?.mt5_login || '').trim();
      }

      let journalEvidence = sanitizeJournalText(
        extractJournalEvidence(
          req.body.journalEvidence,
          req.body.journal_evidence,
          req.body.journal,
          req.body.latestLog,
          req.body.logText,
          message
        ) || ''
      );
      let journalVerdict = journalEvidence && loginForJournal
        ? parseMt5JournalOutcome(journalEvidence, loginForJournal)
        : null;

      if (journalVerdict === 'failed' || messageIndicatesLoginFailed(journalEvidence || message, loginForJournal)) {
        await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
          vpsId: node.id,
          portNo,
          reason: 'journal_rejected_connected'
        }).catch(() => {});
        return res.json({ ok: true, failed: true, message: MT5_FAIL_USER_MSG });
      }

      if (windowVerified && loginVerified && journalVerdict === 'success') {
        await patchAccountMt5Preview(accountId, {
          message: message || MT5_SUCCESS_MSG,
          windowTitle,
          previewB64
        });
        await promoteAccountConnected({
          accountId,
          portId,
          mt5Login: loginForJournal || mt5Login,
          message: message || MT5_SUCCESS_MSG
        });
        await query(`
          UPDATE vps_system.mt5_accounts
          SET last_balance=COALESCE($2,last_balance), last_equity=COALESCE($3,last_equity)
          WHERE id=$1
        `, [accountId, req.body.balance || null, req.body.equity || null]).catch(() => {});
        if (portId) {
          await query(`
            UPDATE vps_system.vps_ports
            SET status='running', process_id=$2, last_pid=$2, mt5_login=$3, current_mt5_login=$3,
                locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
            WHERE id=$1
          `, [portId, pid, mt5Login]).catch(() => {});
        }
        await query(`
          INSERT INTO vps_system.mt5_login_history
          (account_id, vps_id, port_id, port_no, mt5_login, status, message)
          VALUES ($1,$2,$3,$4,$5,'connected',$6)
        `, [accountId, node.id, portId || null, portNo || null, mt5Login, message || MT5_SUCCESS_MSG]).catch(() => {});
        return res.json({ ok: true, connected: true, fastPath: 'window_verified' });
      }

      if (journalVerdict !== 'success') {
        const cmdVerify = await verifyLoginFromCommand({
          accountId,
          vpsId: node.id,
          mt5Login: loginForJournal,
          portNo
        }).catch(() => ({ ok: false }));
        if (cmdVerify.ok) {
          journalVerdict = 'success';
          if (cmdVerify.journalEvidence) journalEvidence = cmdVerify.journalEvidence;
        } else if (cmdVerify.reason === 'JOURNAL_FAILED') {
          journalVerdict = 'failed';
        }
      }

      if (journalVerdict !== 'success') {
        const accMeta = await query(
          `
          SELECT a.port_id, p.folder_path
          FROM vps_system.mt5_accounts a
          LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
          WHERE a.id=$1
          LIMIT 1
        `,
          [accountId]
        ).catch(() => ({ rows: [] }));
        const folderPath = accMeta.rows?.[0]?.folder_path || '';
        const metaPortId = Number(accMeta.rows?.[0]?.port_id || portId || 0);

        const legacyHandled = await handleLegacyWindowVerifiedConnect({
          accountId,
          vpsId: node.id,
          portId: metaPortId,
          portNo,
          mt5Login: loginForJournal,
          message,
          folderPath
        }).catch(() => false);
        if (legacyHandled === true) {
          return res.json({ ok: true, connected: true, status: 'connected' });
        }
        if (legacyHandled === 'pending') {
          return res.json({ ok: true, pending: true, reason: 'JOURNAL_VERIFY' });
        }

        const pendingJournal = await tryApplyPendingJournalRead(accountId, node.id).catch(() => false);
        if (pendingJournal) {
          return res.json({ ok: true, connected: true, status: 'connected' });
        }

        if (folderPath) {
          await queueJournalReadVerify({
            accountId,
            vpsId: node.id,
            folderPath,
            mt5Login: loginForJournal
          }).catch(() => {});
        }

        const inProgress = await findLoginCommandInProgress(accountId, node.id);
        if (inProgress) {
          await query(`
            UPDATE vps_system.mt5_accounts
            SET status='checking', last_error=NULL,
                last_login_message=$2, updated_at=NOW()
            WHERE id=$1
          `, [accountId, message || 'กำลังตรวจสอบ Login MT5 จาก Journal...']).catch(() => {});
          return res.json({ ok: true, pending: true, reason: 'LOGIN_IN_PROGRESS' });
        }

        const reportedVer = req.body.agentBuildId || req.body.agent_build_id
          || req.body.agentVersion || req.body.agent_version || null;
        const legacyAgent =
          !journalEvidence &&
          !String(reportedVer || '').includes('journal-gate') &&
          !String(reportedVer || '').includes('equity-live') &&
          !String(reportedVer || '').includes('algo-live');
        let upgradeState = 'ready';
        if (legacyAgent) {
          upgradeState = await getAgentUpgradeState(node.id);
          if (upgradeState === 'legacy') {
            await queueAgentDeploy(node.id).catch(() => {});
            upgradeState = await getAgentUpgradeState(node.id);
          }
          if (upgradeState === 'needs_restart') {
            await query(`
              INSERT INTO vps_system.vps_agent_commands
              (vps_id, node_id, command_type, payload, status, created_at, updated_at)
              SELECT $1, $1, 'restart_agent', '{"service_name":"AvelquaPythonAgent"}'::jsonb, 'pending', NOW(), NOW()
              WHERE NOT EXISTS (
                SELECT 1 FROM vps_system.vps_agent_commands
                WHERE vps_id=$1 AND command_type='restart_agent'
                  AND LOWER(COALESCE(status,'')) IN ('pending','processing','picked')
                  AND created_at > NOW() - INTERVAL '5 minutes'
              )
            `, [node.id]).catch(() => {});
          }
        }
        let failMsg = 'ไม่พบ authorized on MohicansMarkets-Live ใน Journal — กรุณาลองใหม่อีกครั้ง';
        if (journalVerdict === 'failed') {
          failMsg = MT5_FAIL_USER_MSG;
          await failAccountFromJournal(accountId, metaPortId || portId, failMsg, {
            vpsId: node.id,
            portNo,
            folderPath
          }).catch(() => {});
        } else if (String(message || '').includes('ทันเวลา') || String(message || '').includes('timeout')) {
          failMsg = 'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่';
        } else if (legacyAgent && upgradeState !== 'ready') {
          failMsg = messageForUpgradeState(upgradeState);
        }
        console.warn('[connect-result] reject connected (journal)', {
          accountId,
          mt5Login: loginForJournal,
          journalVerdict,
          hasEvidence: Boolean(journalEvidence),
          agentVersion: req.body.agentVersion || req.body.agent_version || null
        });

        if (journalVerdict !== 'failed') {
          await failAccountFromJournal(accountId, metaPortId || portId, failMsg, {
            vpsId: node.id,
            portNo,
            folderPath
          }).catch(() => {});
        }

        await query(`
          INSERT INTO vps_system.mt5_login_history
          (account_id, vps_id, port_id, port_no, mt5_login, status, message)
          VALUES ($1,$2,$3,$4,$5,'failed',$6)
        `, [accountId, node.id, portId || null, portNo || null, loginForJournal || mt5Login, failMsg]).catch(() => {});

        return res.json({ ok: true, rejected: true, reason: 'JOURNAL_NOT_VERIFIED', failed: true, message: failMsg });
      }

      await patchAccountMt5Preview(accountId, {
        message: message || MT5_SUCCESS_MSG,
        windowTitle,
        previewB64
      });

      await promoteAccountConnected({
        accountId,
        portId,
        mt5Login: loginForJournal || mt5Login,
        message: message || MT5_SUCCESS_MSG
      });

      await query(`
        UPDATE vps_system.mt5_accounts
        SET last_balance=COALESCE($2,last_balance), last_equity=COALESCE($3,last_equity)
        WHERE id=$1
      `, [accountId, req.body.balance || null, req.body.equity || null]).catch(() => {});

      if (portId) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='running', process_id=$2, last_pid=$2, mt5_login=$3, current_mt5_login=$3,
              locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
          WHERE id=$1
        `, [portId, pid, mt5Login]).catch(() => {});
      }

      await query(`
        INSERT INTO vps_system.mt5_login_history
        (account_id, vps_id, port_id, port_no, mt5_login, status, message)
        VALUES ($1,$2,$3,$4,$5,'connected',$6)
      `, [accountId, node.id, portId || null, portNo || null, mt5Login, message || 'connected']).catch(() => {});

      return res.json({ ok: true, connected: true });
    }

    if (status === 'failed') {
      let failMsg = message || MT5_FAIL_USER_MSG;
      if (/ทันเวลา|timeout/i.test(String(failMsg))) {
        failMsg = 'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่';
      } else {
        const evidence = sanitizeJournalText(
          req.body.journalEvidence || req.body.journal_evidence || ''
        ).trim();
        const loginForFail = String(mt5Login || '').trim();
        if (evidence && loginForFail && parseMt5JournalOutcome(evidence, loginForFail) === 'failed') {
          failMsg = MT5_FAIL_USER_MSG;
        }
      }
      const failMeta = await query(
        `
        SELECT a.port_id, p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1
        LIMIT 1
      `,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const failFolder = failMeta.rows?.[0]?.folder_path || '';
      const failPortId = Number(failMeta.rows?.[0]?.port_id || portId || 0);
      await failAccountFromJournal(accountId, failPortId, failMsg, {
        vpsId: node.id,
        portNo,
        folderPath: failFolder,
        reason: 'agent_reported_failed'
      }).catch(() => {});

      await query(`
        INSERT INTO vps_system.mt5_login_history
        (account_id, vps_id, port_id, port_no, mt5_login, status, message)
        VALUES ($1,$2,$3,$4,$5,'failed',$6)
      `, [accountId, node.id, portId || null, portNo || null, mt5Login, failMsg]).catch(() => {});

      return res.json({ ok: true, failed: true, message: failMsg });
    }

    if (status === 'stopped') {
      await query(`
        UPDATE vps_system.mt5_accounts
        SET status='stopped', last_login_message=$2, updated_at=NOW()
        WHERE id=$1
      `, [accountId, message || 'MT5 stopped']).catch(() => {});

      if (portId) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, process_id=NULL, last_pid=NULL,
              mt5_login=NULL, current_mt5_login=NULL, updated_at=NOW()
          WHERE id=$1
        `, [portId]).catch(() => {});
      }

      return res.json({ ok: true, stopped: true });
    }

    await failAccountFromJournal(accountId, portId, message || MT5_FAIL_USER_MSG, {
      vpsId: node.id,
      portNo,
      folderPath: '',
      reason: 'connect_result_other'
    }).catch(() => {});

    await query(`
      INSERT INTO vps_system.mt5_login_history
      (account_id, vps_id, port_id, port_no, mt5_login, status, message)
      VALUES ($1,$2,$3,$4,$5,'failed',$6)
    `, [accountId, node.id, portId || null, portNo || null, mt5Login, message || 'failed']).catch(() => {});

    return res.json({ ok: true, failed: true });
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

    try {
      await processCommandResultSideEffects(node, commandId, ctype, pl, result, {
        ok,
        message: msg
      });
    } catch (sideErr) {
      console.error('[COMMANDS ID RESULT side-effects]', sideErr.message || sideErr);
    }

    let resultJson = '{}';
    try {
      resultJson = toJsonbParam(prepareCommandResultForDb(result));
    } catch (jsonErr) {
      console.error('[COMMANDS ID RESULT jsonb]', jsonErr.message || jsonErr);
      resultJson = '{}';
    }

    const upd = await query(
      `
      UPDATE vps_system.vps_agent_commands
      SET status=$1,
          result_message=$2,
          result=$3::jsonb,
          error=$4,
          finished_at=NOW(),
          updated_at=NOW()
      WHERE id=$5 AND (node_id=$6 OR vps_id=$6)
      RETURNING id
    `,
      [
        ok ? 'success' : 'failed',
        sanitizePgText(msg),
        resultJson,
        ok ? null : sanitizePgText(msg),
        commandId,
        node.id
      ]
    ).catch((e) => {
      throw e;
    });

    if (!upd.rows?.[0]) {
      await query(
        `
        UPDATE vps_system.vps_agent_commands
        SET status=$1,
            result_message=$2,
            result=$3::jsonb,
            error=$4,
            finished_at=NOW(),
            updated_at=NOW()
        WHERE id=$5
      `,
        [
          ok ? 'success' : 'failed',
          sanitizePgText(msg),
          resultJson,
          ok ? null : sanitizePgText(msg),
          commandId
        ]
      ).catch(() => {});
    }

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
