const fs = require('fs');
const path = require('path');
const express = require('express');
// ===== REDIS QUEUE =====
const Redis = require('ioredis');
const redis = new Redis();

// lock key
function getUserLockKey(userId) {
  return `lock:user:${userId}`;
}

function getUserRunAccountLockKey(userId, mt5AccountId) {
  return `lock:user:${userId}:run:acct:${mt5AccountId}`;
}

function getConnectSlotLockKey(userId, portSlot) {
  return `lock:user:${userId}:mt5:slot:${portSlot}`;
}

const { requireLogin } = require('../middleware/requireAuth');
const { query, getClient, repairVpsAgentCommandSequences } = require('../config/database');
const { parseMt5JournalOutcome } = require('../lib/mt5JournalVerify');
const { pickAccountForPortSlot } = require('../lib/mt5PortAccount');
const {
  packageLotLimits,
  normalizeTradeLevel,
  tradeLevelLabel,
  clampLot,
  computePresetForBot,
  presetSummary,
  buildRunSummary,
  isProductionBot,
  validateRunCapital,
  botUiMeta,
  botKind
} = require('../lib/mt5BotPresets');
const { buildEaTimeProfile } = require('../lib/mt5EaTimeProfile');
const { buildEaSetPayloadFields } = require('../lib/mt5EaSet');
const {
  purgeStaleBotInstances,
  fetchHistoryInstances,
  fetchLiveDashboardInstances,
  fetchActiveRunInstances,
  finalizeBotInstanceRecord,
  stopActiveInstancesForAccount
} = require('../lib/mt5InstanceDashboard');
const { createConnectAttempt, repairUserMt5AccountStatuses, ensureMt5ConnectAttemptTables } = require('../lib/mt5ConnectAttempt');
const { abortConnectForRemovedAccount } = require('../lib/vpsAgentCommandQueue');
const { queueBotRunCommands, assertNoRecentBotRunAttempt } = require('../lib/mt5BotRunPhase2');
const {
  PACKAGE_PORT_MAP,
  packagePortCapForGroup,
  packagePortRangeLabel,
  computePortEntitlement
} = require('../lib/mt5PortEntitlement');
const { fetchEquityChartForInstance, recordEquityLog, seedInstanceLiveMetrics } = require('../lib/mt5EquityChart');
const { acquireVpsRunBotSlot, releaseVpsRunBotSlot } = require('../lib/mt5RunBotGate');
const { computeRunBotQueueDelaySec, computeLoginQueueDelaySec, computeJournalTimeoutSec, countActiveLoginsOnVps } = require('../lib/mt5MultiPortLogin');
const { acquireVpsLoginSlot, releaseVpsLoginSlot } = require('../lib/mt5LoginGate');

const router = express.Router();

function readBotMq5Source(botCode) {
  const code = String(botCode || '').trim();
  if (!code) return {};

  const candidates = [
    path.join(process.cwd(), 'BOT_MT5', `${code}.mq5`),
    path.join(process.cwd(), 'BOT_MT5', `${code.replace(/-/g, '_')}.mq5`)
  ];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      return {
        eaSourceFileName: path.basename(filePath),
        eaSourceContent: fs.readFileSync(filePath, 'utf8'),
        eaForceCompile: true
      };
    } catch (_) {}
  }

  return {};
}

router.post('/mt5/connect-result', async (req, res) => {
  try {
    const {
      userId,
      portSlot,
      portNumber,
      mt5Login,
      mt5Password,
      serverName,
      status,
      message
    } = req.body || {};

    if (!userId || !portSlot || !mt5Login) {
      return res.json({ ok: false, message: 'missing data' });
    }

const loginVerified = req.body.loginVerified === true || req.body.login_verified === true;
const journalEvidence = String(req.body.journalEvidence || req.body.journal_evidence || '').trim();
const journalOk = journalEvidence && mt5Login
  ? parseMt5JournalOutcome(journalEvidence, mt5Login) === 'success'
  : false;

if (status !== 'connected' || !loginVerified || !journalOk) {
  await ensureMt5AccountRuntimeColumns().catch(() => {});

  await query(`
    INSERT INTO vps_system.mt5_accounts
    (user_id, mt5_login, mt5_password, broker, server_name, account_name, status, port_slot, vps_id, assigned_port_no, last_error, updated_at)
    VALUES ($1,$2,$3,'MH Markets',$4,$5,'failed',$6,$7,$8,$9,NOW())
    ON CONFLICT (user_id, mt5_login, server_name) DO UPDATE SET
      mt5_password=EXCLUDED.mt5_password,
      port_slot=EXCLUDED.port_slot,
      vps_id=EXCLUDED.vps_id,
      assigned_port_no=EXCLUDED.assigned_port_no,
      status='failed',
      last_error=EXCLUDED.last_error,
      updated_at=NOW()
  `, [
    userId,
    mt5Login,
    mt5Password || '',
    serverName || 'MohicansMarkets-Live',
    `PORT ${portSlot}`,
    portSlot,
    Number(req.body.nodeId || 0) || null,
    Number(portNumber || 0) || null,
    message || 'MT5 login failed'
  ]);

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='failed',
        last_error=$4,
        updated_at=NOW()
    WHERE user_id=$1
      AND mt5_login=$2
      AND server_name=$3
      AND LOWER(TRIM(COALESCE(status,''))) IN ('checking','connected','ready')
  `, [
    userId,
    mt5Login,
    serverName || 'MohicansMarkets-Live',
    message || 'MT5 login failed'
  ]).catch(() => {});

  return res.json({
    ok: true,
    saved: true,
    connected: false,
    status: 'failed',
    message: message || 'MT5 login failed'
  });
}

const usedPort = await query(`
  SELECT id
  FROM vps_system.mt5_accounts
  WHERE user_id=$1
    AND port_slot=$2
    AND status IN ('ready','connected','checking')
    AND NOT (
      mt5_login=$3
      AND server_name=$4
    )
  LIMIT 1
`, [userId, portSlot, mt5Login, serverName || 'MohicansMarkets-Live']);

    if (usedPort.rows[0]) {
      return res.json({ ok: false, message: `PORT ${portSlot} ถูกใช้งานแล้ว` });
    }

await ensureMt5AccountRuntimeColumns().catch(() => {});

await query(`
  INSERT INTO vps_system.mt5_accounts
  (user_id, mt5_login, mt5_password, broker, server_name, account_name, status, port_slot, vps_id, assigned_port_no, last_balance, last_equity, updated_at)
      VALUES ($1,$2,$3,'MH Markets',$4,$5,'connected',$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (user_id, mt5_login, server_name) DO UPDATE SET
        mt5_password=EXCLUDED.mt5_password,
        port_slot=EXCLUDED.port_slot,
        vps_id=EXCLUDED.vps_id,
        assigned_port_no=EXCLUDED.assigned_port_no,
        last_balance=COALESCE(EXCLUDED.last_balance, vps_system.mt5_accounts.last_balance),
        last_equity=COALESCE(EXCLUDED.last_equity, vps_system.mt5_accounts.last_equity),
        status='connected',
        updated_at=NOW()
    `, [
      userId,
      mt5Login,
      mt5Password,
      serverName || 'MohicansMarkets-Live',
      `PORT ${portSlot}`,
      portSlot,
      Number(req.body.nodeId || 0) || null,
      Number(portNumber || 0) || null,
      req.body.balance || null,
      req.body.equity || null
    ]);

    return res.json({
  ok: true,
  saved: true,
  connected: true,
  message: 'MT5 connected successfully',
  portSlot,
  portNumber: portNumber || null
});
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5/agent-running-list', requireAgentToken, async (req, res) => {
  try {
    const vpsId = Number(req.agentNode?.id || 0);
    if (!vpsId) {
      return res.json({ ok: false, items: [], message: 'Unknown agent node' });
    }

    const rows = await query(`
      SELECT bi.id AS "instanceId",
             bi.assigned_port_no AS port,
             bi.mt5_account_id AS "accountId",
             bi.user_id AS "userId",
             bi.run_payload AS "runPayload"
      FROM vps_system.bot_instances bi
      WHERE bi.vps_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running','pending','restarting','starting','connecting')
        AND bi.stopped_at IS NULL
        AND COALESCE(bi.run_payload->>'userStopped', '') NOT IN ('true', '1', 'yes')
        AND bi.assigned_port_no IS NOT NULL
      ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
      LIMIT 100
    `, [vpsId]);

    res.json({ ok: true, items: rows.rows });
  } catch (e) {
    res.json({ ok: false, items: [], message: e.message });
  }
});

// ===== EQUITY LOG TABLE AUTO CREATE =====
async function ensureEquityLogTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.mt5_equity_logs (
      id BIGSERIAL PRIMARY KEY,
      instance_id BIGINT,
      equity NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(()=>{});
}

// ===== TEST DB LOCK RESERVE PORT ไม่ผ่านหน้า Login ใช้ทดสอบเท่านั้น =====
router.post('/mt5/test-reserve-port', async (req, res) => {
  try {
    const token = req.headers['x-test-token'];

    if (token !== 'TEST123') {
      return res.status(403).json({
        ok: false,
        message: 'invalid test token'
      });
    }

    const userId = Number(req.body?.userId || 1);

    const result = await reserveMt5Port(userId);
    return res.json(result);

  } catch (err) {
    console.error('[TEST RESERVE PORT ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

// ===== TEST DB LOCK RELEASE PORT ไม่ผ่านหน้า Login ใช้ทดสอบเท่านั้น =====
router.post('/mt5/test-release-port', async (req, res) => {
  try {
    const token = req.headers['x-test-token'];

    if (token !== 'TEST123') {
      return res.status(403).json({
        ok: false,
        message: 'invalid test token'
      });
    }

    const portId = Number(
  req.body?.port_id ||
  req.query?.port_id ||
  1
);

    await releasePortLock(portId);

    return res.json({
      ok: true
    });

  } catch (err) {
    console.error('[TEST RELEASE PORT ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

async function requireAgentToken(req, res, next) {
  try {
    const token = String(
      req.get('x-agent-token') || req.body?.agent_token || req.query?.token || ''
    ).trim();
    if (!token) return res.status(401).json({ ok: false, message: 'Unauthorized' });

    const node = await query(`
      SELECT id, node_code
      FROM vps_system.vps_nodes
      WHERE agent_token=$1 OR node_code=$1
      LIMIT 1
    `, [token]).catch(() => ({ rows: [] }));

    if (!node.rows?.length) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    req.agentNode = node.rows[0];
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' });
  }
}

async function handleMt5LiveStatusCallback(req, res) {
  try {
    const { applyMt5LiveStatus } = require('../lib/mt5LiveStatus');
    const result = await applyMt5LiveStatus(req.body || {});
    return res.json(result);
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
}

async function handleMt5AccountMetricsCallback(req, res) {
  try {
    const accountId = Number(req.body?.accountId || req.body?.account_id || 0) || null;
    const userId = Number(req.body?.userId || req.body?.user_id || 0) || null;
    const portNumber = Number(req.body?.portNumber || req.body?.port || req.body?.port_no || 0) || null;
    const balance = req.body?.balance ?? null;
    const equity = req.body?.equity ?? null;

    if (!accountId && !(userId && portNumber)) {
      return res.json({ ok: false, message: 'accountId or userId+portNumber required' });
    }

    await query(`
      WITH target AS (
        SELECT id
        FROM vps_system.mt5_accounts
        WHERE ($1::bigint IS NOT NULL AND id = $1)
           OR (
             $2::bigint IS NOT NULL
             AND $3::int IS NOT NULL
             AND user_id = $2
             AND (assigned_port_no = $3 OR port_slot = $3)
           )
        ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, updated_at DESC NULLS LAST, id DESC
        LIMIT 1
      )
      UPDATE vps_system.mt5_accounts a
      SET last_balance = COALESCE($4::numeric, a.last_balance),
          last_equity = COALESCE($5::numeric, a.last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE a.id IN (SELECT id FROM target)
    `, [accountId, userId, portNumber, balance, equity]);

    const activeInst = await query(
      `
      SELECT id FROM vps_system.bot_instances
      WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
        AND (
          ($1::bigint IS NOT NULL AND mt5_account_id = $1)
          OR ($2::bigint IS NOT NULL AND $3::int IS NOT NULL AND user_id = $2 AND assigned_port_no = $3)
        )
      ORDER BY started_at DESC NULLS LAST, id DESC
      LIMIT 1
      `,
      [accountId, userId, portNumber]
    );
    const instId = activeInst.rows?.[0]?.id;
    if (instId && (balance != null || equity != null)) {
      await query(
        `
        UPDATE vps_system.bot_instances
        SET mt5_balance = COALESCE($2::numeric, mt5_balance),
            mt5_equity = COALESCE($3::numeric, mt5_equity),
            last_agent_ping = NOW(),
            last_heartbeat = NOW(),
            updated_at = NOW()
        WHERE id = $1
        `,
        [instId, balance, equity]
      ).catch(() => {});
    }
    if (instId && equity != null && Number(equity) > 0) {
      await seedInstanceLiveMetrics(instId, balance, equity).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
}

router.post('/mt5/live-status', requireAgentToken, handleMt5LiveStatusCallback);
router.post('/mt5/account-metrics', requireAgentToken, handleMt5AccountMetricsCallback);

router.use(requireLogin);

// ===== VPS CACHE =====
let VPS_CACHE = {
  data: null,
  timestamp: 0
};

async function getVpsCached(db) {
  const now = Date.now();

  if (VPS_CACHE.data && (now - VPS_CACHE.timestamp < 3000)) {
    return VPS_CACHE.data;
  }

  try {
    const vps = await db.query(`
      SELECT * FROM vps_nodes
      WHERE status = 'online'
    `);

    VPS_CACHE = {
      data: vps.rows,
      timestamp: now
    };

    return vps.rows;

  } catch (e) {
    return VPS_CACHE.data || [];
  }
}

async function findFreePortWithRetry(db, retry = 3) {

  for (let i = 0; i < retry; i++) {

    const result = await findFreePortCore(db);

    if (result.success) return result;

    // รอ 1 วินาทีแล้วลองใหม่
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
  }

  return { success: false, message: 'หา VPS ไม่เจอหลัง retry' };
}

async function findFreePortCore(db) {

  const vpsList = await getVpsCached(db);

  // เรียง VPS ที่โหลดน้อยก่อน
  vpsList.sort((a, b) => {
    return (a.cpu + a.ram) - (b.cpu + b.ram);
  });

  for (const vps of vpsList) {

    if (vps.cpu > 80 || vps.ram > 80 || vps.ping > 150) continue;

    const ports = await db.query(`
      SELECT * FROM vps_ports
      WHERE vps_id = $1 AND status = 'free'
      ORDER BY port ASC
      LIMIT 1
    `, [vps.id]);

    if (ports.rows.length > 0) {
      return {
        success: true,
        vps,
        port: ports.rows[0]
      };
    }
  }

  return { success: false };
}

const FIXED_SERVER = 'MohicansMarkets-Live';
const FIXED_BROKER = 'mhmarkets';

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function clean(v) {
  return String(v || '').trim();
}

function fmtDate(v) {
  if (!v) return 'ไม่จำกัด';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return 'ไม่จำกัด';
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: '2-digit' });
}

function flash(req, key, value) {
  req.session[key] = value;
}

function pullFlash(req) {
  const out = { success: req.session.success || '', error: req.session.error || '' };
  delete req.session.success;
  delete req.session.error;
  return out;
}

async function safeQuery(sql, params = [], fallback = []) {
  try {
    const r = await query(sql, params);
    return r.rows || [];
  } catch (e) {
    return fallback;
  }
}

// ===== DB LOCK RESERVE MT5 PORT (จาก /admin/vps → vps_allocations) =====
const {
  reserveAdminPortForLogin,
  buildMt5LoginPayload,
  formatPickMessage: formatAdminPickMessage
} = require('../lib/adminVpsPortPicker');
const { fetchVpsActiveLoginLoadMap } = require('../lib/vpsLoginLoad');
const { setAdminAllocationStatus, parsePortNumber, resolveSystemVpsId, reconcilePortIdleWhenAgentFree } = require('../lib/adminVpsBridge');
const { buildStopMt5ReleasePayload } = require('../lib/mt5PortCleanup');

async function reserveMt5Port(userId) {
  const adminReserve = await reserveAdminPortForLogin(userId);
  if (adminReserve.ok) return adminReserve;

  const client = await getClient();

  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
      WHERE status='locked'
        AND locked_until IS NOT NULL
        AND locked_until < NOW()
    `).catch(() => {});

    const portRes = await client.query(`
      SELECT
        p.id AS port_id,
        p.vps_id,
        p.port_no,
        p.folder_path,
        p.status
      FROM vps_system.vps_ports p
      INNER JOIN vps_system.vps_nodes n ON n.id = p.vps_id
      WHERE LOWER(COALESCE(p.status, '')) IN ('available', 'free', 'idle')
        AND LOWER(COALESCE(p.status, '')) NOT IN ('disabled', 'off', 'deleted')
        AND COALESCE(n.agent_enabled, TRUE) = TRUE
        AND LOWER(TRIM(COALESCE(n.status, ''))) IN ('online', 'available', 'active', 'connected')
        AND COALESCE(n.cpu_percent, 0) <= COALESCE(n.max_cpu_percent, 80)
        AND COALESCE(n.ram_percent, 0) <= COALESCE(n.max_ram_percent, 85)
        AND COALESCE(n.ping_ms, 0) <= COALESCE(n.max_ping_ms, 150)
        AND COALESCE(TRIM(p.folder_path), '') <> ''
      ORDER BY (
        SELECT COUNT(*)::int
        FROM (
          SELECT vps_id FROM vps_system.mt5_connect_attempts
          WHERE vps_id = n.id
            AND LOWER(COALESCE(status, '')) IN ('starting', 'checking')
            AND created_at > NOW() - INTERVAL '20 minutes'
          UNION ALL
          SELECT vps_id FROM vps_system.vps_agent_commands
          WHERE vps_id = n.id
            AND LOWER(COALESCE(command_type, '')) IN ('login_mt5', 'connect_mt5')
            AND LOWER(COALESCE(status, '')) IN ('pending', 'processing')
            AND created_at > NOW() - INTERVAL '20 minutes'
        ) active
      ) ASC,
      COALESCE(n.cpu_percent, 0) ASC,
      COALESCE(n.ping_ms, 0) ASC,
      p.port_no ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `);

    const port = portRes.rows[0];

    if (!port) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        message: adminReserve.message || 'ไม่มี PORT ว่างในขณะนี้ — ตรวจสอบ /admin/vps'
      };
    }

    await client.query(`
      UPDATE vps_system.vps_ports
      SET
        status='locked',
        locked_by_user_id=$1,
        locked_until=NOW() + INTERVAL '2 minutes',
        updated_at=NOW()
      WHERE id=$2
    `, [userId, port.port_id]);

    await client.query('COMMIT');

    return { ok: true, port };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ===== DB LOCK RELEASE MT5 PORT =====
async function releasePortLock(portId) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE vps_system.vps_ports
      SET
        status='available',
        locked_by_user_id=NULL,
        locked_until=NULL,
        updated_at=NOW()
      WHERE id=$1
    `, [portId]);

    await client.query('COMMIT');

    return true;

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function releaseReservedPort(reservedPort) {
  if (!reservedPort) return;
  if (reservedPort.port_id) {
    await releasePortLock(reservedPort.port_id).catch(() => {});
  }
  const portNo = num(reservedPort.port_number);
  if (reservedPort.admin_node_id && portNo) {
    await setAdminAllocationStatus(
      reservedPort.admin_node_id,
      portNo,
      'free',
      reservedPort.allocation_id
    ).catch(() => {});
  }
}

async function reserveVpsPortForConnect(userId, existingPortId, portSlot = 0) {
  const pid = num(existingPortId);
  if (pid > 0) {
    const row = await query(
      `
      SELECT
        p.id AS port_id,
        p.vps_id,
        p.port_no,
        p.folder_path,
        n.node_name
      FROM vps_system.vps_ports p
      INNER JOIN vps_system.vps_nodes n ON n.id = p.vps_id
      WHERE p.id = $1
      LIMIT 1
    `,
      [pid]
    ).catch(() => ({ rows: [] }));
    const port = row.rows?.[0];
    if (port && String(port.folder_path || '').trim()) {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='locked',
            locked_by_user_id=$2,
            locked_until=NOW() + INTERVAL '3 minutes',
            updated_at=NOW()
        WHERE id=$1
      `,
        [port.port_id, userId]
      ).catch(() => {});
      return {
        ok: true,
        port: {
          port_id: port.port_id,
          vps_id: port.vps_id,
          port_number: port.port_no,
          port_no: port.port_no,
          folder_path: port.folder_path,
          node_name: port.node_name
        },
        reused: true
      };
    }
  }

  const slot = num(portSlot);
  if (slot > 0) {
    const preferred = await query(
      `
      SELECT
        p.id AS port_id,
        p.vps_id,
        p.port_no,
        p.folder_path,
        n.node_name
      FROM vps_system.vps_ports p
      INNER JOIN vps_system.vps_nodes n ON n.id = p.vps_id
      WHERE LOWER(COALESCE(p.status, '')) IN ('available', 'free', 'idle')
        AND LOWER(COALESCE(p.status, '')) NOT IN ('disabled', 'off', 'deleted')
        AND COALESCE(n.agent_enabled, TRUE) = TRUE
        AND LOWER(TRIM(COALESCE(n.status, ''))) IN ('online', 'available', 'active', 'connected')
        AND COALESCE(TRIM(p.folder_path), '') <> ''
        AND (
          p.port_no = $1
          OR p.folder_path ~* ('PORT[-_ ]*0?' || $1::text || '([^0-9]|$)')
        )
      ORDER BY
        CASE WHEN p.port_no = $1 THEN 0 ELSE 1 END,
        COALESCE(n.cpu_percent, 0) ASC,
        COALESCE(n.ping_ms, 0) ASC,
        p.port_no ASC
      LIMIT 1
      FOR UPDATE OF p SKIP LOCKED
    `,
      [slot]
    ).catch(() => ({ rows: [] }));

    const pick = preferred.rows?.[0];
    if (pick) {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='locked',
            locked_by_user_id=$2,
            locked_until=NOW() + INTERVAL '3 minutes',
            updated_at=NOW()
        WHERE id=$1
      `,
        [pick.port_id, userId]
      ).catch(() => {});
      return {
        ok: true,
        port: {
          port_id: pick.port_id,
          vps_id: pick.vps_id,
          port_number: pick.port_no,
          port_no: pick.port_no,
          folder_path: pick.folder_path,
          node_name: pick.node_name
        },
        reused: false,
        matchedSlot: true
      };
    }
  }

  return reserveMt5Port(userId);
}

function resolveConnectPortSlot(summary, requestedSlot, usedSlotSet, busySlotSet = null) {
  const total = Math.max(1, num(summary?.totalPorts, 1));
  const busy = busySlotSet instanceof Set ? busySlotSet : new Set();
  const req = num(requestedSlot);
  if (req >= 1 && req <= total) {
    if (usedSlotSet.has(req)) {
      return { ok: false, message: `PORT ${req} กำลังเชื่อมต่ออยู่ — รอให้เสร็จก่อน หรือเลือก PORT อื่น` };
    }
    if (busy.has(req)) {
      return { ok: false, message: `PORT ${req} มีบัญชีอยู่แล้ว — เลือก PORT ว่างสำหรับ login พร้อมกัน` };
    }
    return { ok: true, portSlot: req };
  }
  for (let i = 1; i <= total; i++) {
    if (!usedSlotSet.has(i) && !busy.has(i)) return { ok: true, portSlot: i, autoPicked: true };
  }
  return { ok: false, message: `PORT ตามแพ็กเกจเต็มแล้ว — ลบ PORT เก่าก่อน login พร้อมกัน` };
}

/** ปิดสถานะ connecting/checking ที่ค้าง + ปลดล็อกพอร์ต VPS — ให้ล็อกอินซ้ำได้หลังครั้งก่อนล้มเหลว */
async function expireStaleConnectingForLogin(userId, mt5Login, serverName) {
  const stale = await safeQuery(
    `
    SELECT id, port_id
    FROM vps_system.mt5_accounts
    WHERE mt5_login=$1
      AND server_name=$2
      AND LOWER(TRIM(COALESCE(status,''))) IN ('connecting','checking')
      AND (
        (user_id=$3 AND updated_at < NOW() - INTERVAL '90 seconds')
        OR (updated_at < NOW() - INTERVAL '15 minutes')
      )
  `,
    [mt5Login, serverName, userId],
    []
  );

  for (const row of stale || []) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='failed',
          last_error=$2,
          updated_at=NOW()
      WHERE id=$1
    `,
      [row.id, 'การเชื่อมต่อค้างเกินเวลา — ลองใหม่ได้']
    ).catch(() => {});
    if (row.port_id) {
      await releasePortLock(row.port_id).catch(() => {});
    }
  }
}

async function ensureMt5AccountRuntimeColumns(db = { query }) {
  const runner = db.query ? db : { query };
  await runner.query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_id bigint`).catch(() => {});
  await runner.query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS vps_id bigint`).catch(() => {});
  await runner.query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS assigned_port_no int`).catch(() => {});
  await runner.query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS windows_port_no int`).catch(() => {});
  await runner.query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance numeric`).catch(() => {});
  await runner.query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity numeric`).catch(() => {});
}

// ===== PUSH COMMAND QUEUE =====
async function pushCommand(db, vps_id, command, payload) {
  await db.query(`
    INSERT INTO vps_command_queue (vps_id, command, payload)
    VALUES ($1, $2, $3::jsonb)
  `, [vps_id, command, JSON.stringify(payload)]);
}

async function getPackage(userId) {

  const rows = await safeQuery(`
    SELECT us.id AS subscription_id,
           us.package_id,
           COALESCE(
             NULLIF(us.ports_max, 0),
             NULLIF(us.ports_min, 0),
             NULLIF(to_jsonb(p)->>'ports_max','')::int,
             NULLIF(to_jsonb(p)->>'max_ports','')::int,
             NULLIF(to_jsonb(p)->>'port_limit','')::int,
             1
           ) AS max_ports,
           COALESCE(to_jsonb(us)->>'package_name_snapshot', to_jsonb(p)->>'name_th', to_jsonb(p)->>'name', to_jsonb(p)->>'name_en', 'แพ็กเกจปัจจุบัน') AS package_name,
           UPPER(COALESCE(to_jsonb(p)->>'group_name', to_jsonb(p)->>'package_group', to_jsonb(p)->>'package_code', to_jsonb(us)->>'package_group_snapshot', '')) AS package_group,
           COALESCE(NULLIF(to_jsonb(p)->>'duration_days','')::int, NULLIF(to_jsonb(p)->>'days','')::int, NULLIF(to_jsonb(p)->>'package_days','')::int, 0) AS duration_days,
           COALESCE(NULLIF(to_jsonb(p)->>'lot_min','')::numeric, NULLIF(to_jsonb(p)->>'min_lot','')::numeric, NULLIF(to_jsonb(p)->>'lot_from','')::numeric, 0.01) AS lot_min,
           COALESCE(NULLIF(to_jsonb(p)->>'lot_max','')::numeric, NULLIF(to_jsonb(p)->>'max_lot','')::numeric, NULLIF(to_jsonb(p)->>'lot_to','')::numeric, 0.01) AS lot_max,
           us.status,
           us.start_at,
           us.end_at,
           CASE WHEN us.end_at IS NOT NULL AND us.end_at <= NOW() THEN TRUE ELSE FALSE END AS is_expired,
           COALESCE(to_jsonb(us)->>'source', to_jsonb(us)->>'payment_method', '') AS subscription_source,
           COALESCE(to_jsonb(us)->>'coupon_code', to_jsonb(us)->>'coupon_code_snapshot', '') AS coupon_code
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id=$1
      AND COALESCE(us.status,'')='active'
      AND (us.end_at IS NULL OR us.end_at > NOW())
    ORDER BY us.end_at DESC NULLS LAST, us.id DESC
    LIMIT 1
  `, [userId]);

  const pkg = rows[0] || {
    subscription_id: null,
    package_id: null,
    max_ports: 0,
    package_name: 'ยังไม่มีแพ็กเกจ หรือแพ็กเกจหมดอายุ',
    package_group: '',
    duration_days: 0,
    lot_min: 0.01,
    lot_max: 0.01,
    start_at: null,
    end_at: null,
    status: 'expired',
    is_expired: true,
    subscription_source: '',
    coupon_code: ''
  };

  if (!pkg.package_group) {
    const nameUpper = String(pkg.package_name || pkg.package_name_snapshot || '').toUpperCase();
    if (nameUpper.includes('ADVANCED')) pkg.package_group = 'ADVANCED';
    else if (nameUpper.includes('PRO')) pkg.package_group = 'PRO';
    else if (nameUpper.includes('BASIC')) pkg.package_group = 'BASIC';
  }
  pkg.is_expired = !pkg.subscription_id || pkg.status !== 'active' || (!!pkg.end_at && new Date(pkg.end_at).getTime() <= Date.now());
  return pkg;
}

function packageTierFromText(text) {
  const upper = String(text || '').trim().toUpperCase();
  if (upper.includes('ADVANCED')) return 'ADVANCED';
  if (upper.includes('PRO')) return 'PRO';
  if (upper.includes('BASIC')) return 'BASIC';
  return upper;
}

async function getPackagePaymentDetail(userId, pkg = null) {
  const rows = await safeQuery(`
    SELECT id, payment_method, payment_status, package_name_snapshot,
           amount, discount_amount, final_amount, currency_code, package_id,
           coupon_id, coupon_code_snapshot, coupon_code, created_at, updated_at
    FROM payments
    WHERE user_id=$1
      AND payment_status='paid'
    ORDER BY updated_at DESC, id DESC
    LIMIT 30
  `, [userId], []);
  if (!rows.length) return null;
  const targetPackageId = Number(pkg?.package_id || 0);
  const targetTier = packageTierFromText(pkg?.package_name || pkg?.package_group || '');
  const startMs = pkg?.start_at ? new Date(pkg.start_at).getTime() : 0;
  const scored = rows.map((row, idx) => {
    let score = idx * 0.001;
    if (targetPackageId && Number(row.package_id || 0) !== targetPackageId) score += 1000;
    const rowTier = packageTierFromText(row.package_name_snapshot);
    if (targetTier && rowTier && rowTier !== targetTier) score += 100;
    const rowMs = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    if (startMs && rowMs) score += Math.min(Math.abs(rowMs - startMs) / 1000, 86400);
    return { row, score };
  });
  scored.sort((a, b) => a.score - b.score || Number(b.row.id) - Number(a.row.id));
  return scored[0]?.row || rows[0] || null;
}

async function getCouponDetails(userId, paymentDetail = null) {
  const paymentId = Number(paymentDetail?.id || 0);
  if (!paymentId) return [];
  const rows = await safeQuery(`
    SELECT c.coupon_code,
           c.coupon_name,
           c.coupon_type,
           c.free_days,
           c.free_package_group,
           c.discount_amount,
           c.discount_percent,
           c.expires_at,
           cu.used_at
    FROM coupon_usages cu
    LEFT JOIN coupons c ON c.id=cu.coupon_id
    WHERE cu.user_id=$1
      AND cu.payment_id=$2
    ORDER BY cu.used_at DESC NULLS LAST, cu.id DESC
    LIMIT 5
  `, [userId, paymentId], []);
  return rows || [];
}


async function ensureExtraPortsTable(db = { query }) {
  const runner = db.query ? db : { query };
  await runner.query(`CREATE SCHEMA IF NOT EXISTS vps_system`).catch(() => {});
  await runner.query(`
    CREATE TABLE IF NOT EXISTS vps_system.mt5_extra_ports (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      qty INT NOT NULL DEFAULT 1,
      port_type TEXT NOT NULL DEFAULT 'temporary',
      subscription_id BIGINT,
      package_id BIGINT,
      package_group TEXT,
      price_scoin NUMERIC NOT NULL DEFAULT 0,
      expires_at TIMESTAMP NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS qty INT NOT NULL DEFAULT 1`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS port_type TEXT NOT NULL DEFAULT 'temporary'`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS subscription_id BIGINT`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS package_id BIGINT`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS package_group TEXT`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS price_scoin NUMERIC NOT NULL DEFAULT 0`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`).catch(() => {});
  await runner.query(`CREATE INDEX IF NOT EXISTS idx_mt5_extra_ports_user ON vps_system.mt5_extra_ports(user_id, is_active, port_type)`).catch(() => {});
}

/** PORT ชั่วคราวผูก subscription รอบปัจจุบัน — หมดแพ็กเกจ/รอบใหม่ต้องซื้อใหม่ */
async function deactivateOrphanTemporaryPorts(userId, subscriptionId) {
  const sid = num(subscriptionId);
  if (!sid) return;
  await ensureExtraPortsTable().catch(() => {});
  await query(
    `
    UPDATE vps_system.mt5_extra_ports
    SET is_active=FALSE, updated_at=NOW()
    WHERE user_id=$1
      AND port_type='temporary'
      AND is_active=TRUE
      AND (
        COALESCE(subscription_id, 0) <> $2
        OR created_at < COALESCE((
          SELECT start_at FROM user_subscriptions WHERE id=$2 LIMIT 1
        ), NOW())
      )
  `,
    [userId, sid]
  ).catch(() => {});
}

async function getExtraPortRows(userId, subscriptionId, packageId, packageGroup = '') {
  await ensureExtraPortsTable().catch(() => {});
  const groupUpper = String(packageGroup || '').toUpperCase().trim();
  const subId = num(subscriptionId);
  return await safeQuery(`
    SELECT id, qty, port_type, subscription_id, package_id, package_group, price_scoin, expires_at, is_active, created_at,
           CASE WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN TRUE ELSE FALSE END AS is_expired
    FROM vps_system.mt5_extra_ports
    WHERE user_id=$1
      AND is_active=TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (
        (port_type='temporary'
          AND subscription_id=$3
          AND created_at >= COALESCE((
            SELECT start_at FROM user_subscriptions WHERE id=$3 LIMIT 1
          ), created_at))
        OR
        (port_type='permanent' AND (
          $2 = ''
          OR UPPER(COALESCE(package_group,'')) = $2
          OR TRIM(COALESCE(package_group,'')) = ''
        ))
      )
    ORDER BY created_at DESC, id DESC
  `, [userId, groupUpper, subId], []);
}

async function getExtraPorts(userId, subscriptionId, packageId, packageGroup = '') {
  const ent = computePortEntitlement(
    0,
    await getExtraPortRows(userId, subscriptionId, packageId, packageGroup),
    packageGroup
  );
  return ent.temporaryExtra + ent.permanentExtra;
}

async function stopAndExpireMt5Accounts(userId, reason = 'package_expired') {
  await ensureMt5AccountRuntimeColumns().catch(() => {});
  // Also stop bot instances explicitly (so EA is halted before MT5 close).
  const inst = await safeQuery(
    `
    SELECT bi.id, bi.vps_id, bi.port_id, bi.assigned_port_no,
           COALESCE(vp.folder_path,'') AS folder_path,
           COALESCE(bi.run_payload->>'botCode', bi.run_payload->>'eaName', '') AS bot_code,
           COALESCE(bi.run_payload->>'mt5Login', '') AS mt5_login
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.vps_ports vp ON vp.id = bi.port_id
    WHERE bi.user_id=$1
      AND bi.status IN ('running','pending','restarting')
      AND bi.vps_id IS NOT NULL
      AND COALESCE(bi.assigned_port_no,0) > 0
    ORDER BY bi.id DESC
  `,
    [userId],
    []
  );

  for (const row of inst || []) {
    const stopNodeId = num(row.vps_id);
    const stopPortNo = num(row.assigned_port_no);
    if (!stopNodeId || !stopPortNo) continue;
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1, $1, $2, 'stop_mt5_bot', $3::jsonb, 'pending', NOW(), NOW())
    `,
      [
        stopNodeId,
        row.port_id || null,
        JSON.stringify({
          action: 'stop_bot_trading',
          commandType: 'stop_mt5_bot',
          instanceId: String(row.id),
          port: stopPortNo,
          portNumber: stopPortNo,
          portSlot: stopPortNo,
          folder_path: row.folder_path || null,
          vpsFolderPath: row.folder_path || null,
          stopTradingOnly: false,
          forceKill: true,
          closeMt5: true,
          botCode: row.bot_code || null,
          mt5Login: row.mt5_login || null,
          expectedMt5Login: row.mt5_login || null,
          closeAllPositions: true,
          reason
        })
      ]
    ).catch(() => {});
  }

  const rows = await safeQuery(`
  SELECT 
    a.id,
    a.port_slot,
    a.port_id,
    a.vps_id,
    a.assigned_port_no,
    a.windows_port_no,
    COALESCE(vp.folder_path, '') AS folder_path
  FROM vps_system.mt5_accounts a
  LEFT JOIN vps_system.vps_ports vp ON vp.id = a.port_id
  WHERE a.user_id=$1
    AND LOWER(TRIM(COALESCE(a.status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
`, [userId], []);


  for (const a of rows) {
    const stopNodeId = num(a.vps_id);
    const stopPortNo = num(a.assigned_port_no) || num(a.windows_port_no) || num(a.port_slot);
    if (stopNodeId && stopPortNo) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at)
        VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW())
      `, [stopNodeId, a.port_id || null, JSON.stringify({
        port: stopPortNo,
        portSlot: a.port_slot,
        assignedPortNo: a.assigned_port_no,
        windowsPortNo: a.windows_port_no,
        folder_path: a.folder_path || null,
        vpsFolderPath: a.folder_path || null,
        forceKill: true,
        closeMt5: true,
        reason
      })]).catch(() => {});
      if (a.port_id) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
          WHERE id=$1
        `, [a.port_id]).catch(() => {});
      } else {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
          WHERE vps_id=$1 AND port_no=$2
        `, [stopNodeId, stopPortNo]).catch(() => {});
      }
    }
  }

  if (rows.length) {
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='expired', assigned_port_no=NULL, windows_port_no=NULL, vps_id=NULL, port_id=NULL, updated_at=NOW()
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
    `, [userId]).catch(() => {});
  }

  await query(`
    UPDATE vps_system.bot_instances
    SET status='stopped',
        stopped_at=COALESCE(stopped_at, NOW()),
        updated_at=NOW(),
        last_error=$2,
        ea_status='stopped'
    WHERE user_id=$1
      AND status IN ('running','pending','restarting')
  `, [userId, reason]).catch(() => {});
}


async function stopPortsAboveEntitlement(userId, totalPorts, reason = 'port_entitlement_reduced') {
  await ensureMt5AccountRuntimeColumns().catch(() => {});
  const limit = Math.max(0, num(totalPorts));
  const rows = await safeQuery(`
    SELECT a.id, a.mt5_login, a.port_slot, a.port_id, a.vps_id, a.assigned_port_no, a.windows_port_no,
           COALESCE(vp.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports vp ON vp.id = a.port_id
    WHERE a.user_id=$1
      AND LOWER(TRIM(COALESCE(a.status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
      AND COALESCE(a.port_slot,0) > $2
  `, [userId, limit], []);

  for (const a of rows) {
    const stopNodeId = num(a.vps_id);
    const stopPortNo = num(a.assigned_port_no) || num(a.windows_port_no);
    const folderPath = String(a.folder_path || '').trim();
    if (stopNodeId && stopPortNo && folderPath) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at)
        VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW())
      `, [stopNodeId, a.port_id || null, JSON.stringify({
        port: stopPortNo,
        portSlot: a.port_slot,
        assignedPortNo: a.assigned_port_no,
        windowsPortNo: a.windows_port_no,
        folder_path: folderPath,
        vpsFolderPath: folderPath,
        mt5Login: a.mt5_login || null,
        expectedMt5Login: a.mt5_login || null,
        userId,
        accountId: num(a.id) || null,
        forceKill: true,
        closeMt5: true,
        reason
      })]).catch(() => {});
      if (a.port_id) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
          WHERE id=$1
        `, [a.port_id]).catch(() => {});
      }
    }
  }

  if (rows.length) {
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='expired', assigned_port_no=NULL, windows_port_no=NULL, vps_id=NULL, port_id=NULL, updated_at=NOW()
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
        AND COALESCE(port_slot,0) > $2
    `, [userId, limit]).catch(() => {});
  }

  await query(`
    UPDATE vps_system.bot_instances
    SET status='stopped', stopped_at=COALESCE(stopped_at,NOW()), updated_at=NOW(), last_error=$3
    WHERE user_id=$1
      AND status IN ('running','pending','restarting')
      AND COALESCE(port_used, assigned_port_no, 0) > $2
  `, [userId, limit, reason]).catch(() => {});
}

async function getPortSummary(userId) {
  const pkg = await getPackage(userId);
  const packageExpired = !!pkg.is_expired || !pkg.subscription_id;

if (packageExpired) {
  const { applyPackageExpiredSideEffects } = require('../lib/mt5ExpiryEnforcer');
  await applyPackageExpiredSideEffects(userId, 'package_expired_auto_stop');
}

  if (!packageExpired && pkg.subscription_id) {
    await deactivateOrphanTemporaryPorts(userId, pkg.subscription_id);
  }

  const extraPortRows = packageExpired ? [] : await getExtraPortRows(
  userId,
  pkg.subscription_id,
  pkg.package_id,
  pkg.package_group
);
  const group = String(pkg.package_group || pkg.group_name || '').toUpperCase();

  const packageMaxPorts = packageExpired
    ? 0
    : packagePortCapForGroup(group, pkg.max_ports);
  const entitlement = packageExpired
    ? {
        packageMaxPorts: 0,
        includedPorts: 0,
        maxExtraPurchases: 0,
        temporaryExtra: 0,
        permanentExtra: 0,
        totalPorts: 0,
        canAddTemporary: false,
        canAddPermanent: false
      }
    : computePortEntitlement(packageMaxPorts, extraPortRows, group);

  const { totalPorts, temporaryExtra, permanentExtra, includedPorts } = entitlement;
  const freePorts = includedPorts;
  const extraPorts = temporaryExtra + permanentExtra;

  if (!packageExpired) {
    await stopPortsAboveEntitlement(userId, totalPorts, 'port_entitlement_reduced_auto_stop');
  }

  const portStats = await getUserPortSlotStats(userId, totalPorts);
  const paymentDetail = await getPackagePaymentDetail(userId, pkg);
  const couponDetails = await getCouponDetails(userId, paymentDetail);

  return buildPortSummaryResult({
    pkg,
    packageExpired,
    freePorts,
    extraPorts,
    extraPortRows,
    packageMaxPorts,
    includedPorts,
    maxExtraPurchases: entitlement.maxExtraPurchases,
    totalPorts,
    temporaryExtra,
    permanentExtra,
    canAddTemporary: entitlement.canAddTemporary,
    canAddPermanent: entitlement.canAddPermanent,
    portStats,
    displayPortCount: totalPorts,
    paymentDetail,
    couponDetails
  });
}

function buildPortSummaryResult({
  pkg,
  packageExpired,
  freePorts,
  extraPorts,
  extraPortRows,
  packageMaxPorts,
  includedPorts,
  maxExtraPurchases,
  totalPorts,
  temporaryExtra,
  permanentExtra,
  canAddTemporary,
  canAddPermanent,
  portStats,
  displayPortCount,
  paymentDetail,
  couponDetails
}) {
  return {
    pkg,
    packageExpired,
    freePorts,
    extraPorts,
    extraPortRows,
    packageMaxPorts,
    includedPorts: includedPorts ?? 1,
    maxExtraPurchases: maxExtraPurchases ?? packageMaxPorts,
    packagePortRange: packagePortRangeLabel(packageMaxPorts),
    totalPorts,
    temporaryExtra: temporaryExtra ?? 0,
    permanentExtra: permanentExtra ?? 0,
    canAddTemporary: canAddTemporary !== false,
    canAddPermanent: canAddPermanent !== false,
    ...portStats,
    displayPortCount: displayPortCount ?? totalPorts,
    connectedCount: portStats.availablePortCount,
    paymentDetail,
    couponDetails
  };
}

/** สถิติพอร์ตสำหรับแสดงผล — นับจากสิทธิ์รวม (แพ็กเกจ + ที่ซื้อเพิ่ม) */
async function getUserPortSlotStats(userId, totalPortsEntitled = 0) {
  const rows = await safeQuery(
    `
    SELECT port_slot, LOWER(TRIM(COALESCE(status, ''))) AS st
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND port_slot IS NOT NULL
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
  `,
    [userId],
    []
  );
  let connectedOnlyCount = 0;
  for (const r of rows) {
    if (r.st === 'connected') connectedOnlyCount += 1;
  }
  const entitled = Math.max(0, num(totalPortsEntitled));
  const availablePortCount = Math.max(0, entitled - connectedOnlyCount);
  return {
    createdPortCount: entitled,
    connectedOnlyCount,
    availablePortCount,
    displayPortCount: entitled
  };
}

/** Same numbers as getPortSummary for page render — expiry kill runs via cron only (no cross-user side effects). */
async function getPortSummaryReadOnly(userId) {
  const { repairFailedAccountsHoldingSlots } = require('../lib/mt5LoginCommandVerify');
  await repairFailedAccountsHoldingSlots(userId).catch(() => {});

  const pkg = await getPackage(userId);
  const packageExpired = !!pkg.is_expired || !pkg.subscription_id;

  if (!packageExpired && pkg.subscription_id) {
    await deactivateOrphanTemporaryPorts(userId, pkg.subscription_id);
  }

  const extraPortRows = packageExpired ? [] : await getExtraPortRows(
    userId,
    pkg.subscription_id,
    pkg.package_id,
    pkg.package_group
  );
  const group = String(pkg.package_group || pkg.group_name || '').toUpperCase();

  const packageMaxPorts = packageExpired
    ? 0
    : packagePortCapForGroup(group, pkg.max_ports);

  const entitlement = packageExpired
    ? {
        packageMaxPorts: 0,
        includedPorts: 0,
        maxExtraPurchases: 0,
        temporaryExtra: 0,
        permanentExtra: 0,
        totalPorts: 0,
        canAddTemporary: false,
        canAddPermanent: false
      }
    : computePortEntitlement(packageMaxPorts, extraPortRows, group);

  const portStats = await getUserPortSlotStats(userId, entitlement.totalPorts);
  const paymentDetail = await getPackagePaymentDetail(userId, pkg);
  const couponDetails = await getCouponDetails(userId, paymentDetail);

  return buildPortSummaryResult({
    pkg,
    packageExpired,
    freePorts: entitlement.includedPorts,
    extraPorts: entitlement.temporaryExtra + entitlement.permanentExtra,
    extraPortRows,
    packageMaxPorts,
    includedPorts: entitlement.includedPorts,
    maxExtraPurchases: entitlement.maxExtraPurchases,
    totalPorts: entitlement.totalPorts,
    temporaryExtra: entitlement.temporaryExtra,
    permanentExtra: entitlement.permanentExtra,
    canAddTemporary: entitlement.canAddTemporary,
    canAddPermanent: entitlement.canAddPermanent,
    portStats,
    displayPortCount: entitlement.totalPorts,
    paymentDetail,
    couponDetails
  });
}


async function findAvailableVpsPort() {
  await ensureMt5AccountRuntimeColumns().catch(() => {});

  const { findBestAdminPortForLogin } = require('../lib/adminVpsPortPicker');
  const adminPick = await findBestAdminPortForLogin();
  if (adminPick) {
    return {
      ...adminPick,
      node_id: adminPick.admin_node_id,
      port_id: adminPick.allocation_id,
      source: 'admin_vps_allocations'
    };
  }

  return null;
}


function vpsProbeText(vps) {
  if (!vps) return formatAdminPickMessage(null);
  return formatAdminPickMessage(vps);
}

async function ensureBotCatalog() {
  await query(`
    INSERT INTO vps_system.bot_catalog (bot_code, bot_name, display_name, symbol, required_ports, default_lot, max_lot, is_demo, sort_order, is_active)
    VALUES
    ('AK-SNIPER-VIP-VER4.0','AK-SNIPER-VIP-VER4.0','AK-SNIPER-VIP-VER4.0','XAUUSD',1,0.01,50,FALSE,10,TRUE),
    ('QUEEN-SNIPER-AI-V1.0','QUEEN-SNIPER-AI-V1.0','QUEEN-SNIPER-AI-V1.0','XAUUSD',1,0.01,50,FALSE,20,TRUE),
    ('Quantum-Queen-MT5-3.65','Quantum-Queen-MT5-3.65','Quantum-Queen-MT5-3.65','XAUUSD',1,0.01,50,FALSE,30,TRUE)
    ON CONFLICT (bot_code) DO UPDATE SET
      bot_name=EXCLUDED.bot_name,
      display_name=EXCLUDED.display_name,
      symbol=EXCLUDED.symbol,
      required_ports=EXCLUDED.required_ports,
      default_lot=EXCLUDED.default_lot,
      max_lot=EXCLUDED.max_lot,
      is_demo=EXCLUDED.is_demo,
      sort_order=EXCLUDED.sort_order,
      is_active=TRUE,
      updated_at=NOW()
  `).catch(() => {});
  await query(`
    UPDATE vps_system.bot_catalog
    SET is_active=FALSE, updated_at=NOW()
    WHERE UPPER(bot_code) NOT IN (
      'AK-SNIPER-VIP-VER4.0',
      'QUEEN-SNIPER-AI-V1.0',
      'QUANTUM-QUEEN-MT5-3.65'
    )
  `).catch(() => {});
}

router.get('/mt5/check-port', async (req, res) => {
  try {
    const userId = req.user.id;
    const summary = await getPortSummaryReadOnly(userId);
    const portSlot = Math.max(1, num(req.query.port_slot, 1));
    if (portSlot > summary.totalPorts) {
      return res.status(400).json({ ok: false, error: `แพ็กเกจนี้ใช้ได้ ${summary.totalPorts} PORT` });
    }
    const vps = await findAvailableVpsPort();
    if (!vps) {
      return res.json({ ok: false, available: false, error: 'ยังไม่พบ Windows VPS/PORT ที่เปิดใช้งานและว่างตามเงื่อนไข CPU/RAM/PING' });
    }
    return res.json({
      ok: true,
      available: true,
      portSlot,
      message: vpsProbeText(vps),
      vps: {
        node_id: vps.node_id,
        node_name: vps.node_name,
        node_code: vps.node_code,
        node_status: vps.node_status,
        port_id: vps.port_id,
        port_name: vps.port_name,
        port_number: vps.port_number,
        folder_path: vps.folder_path,
        cpu_percent: vps.cpu_percent,
        ram_percent: vps.ram_percent,
        ping_ms: vps.ping_ms,
        source: vps.source,
        ai_score: vps.ai_score,
        free_ports: vps.free_ports
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/mt5/find-port', async (req, res) => {
  try {
    const userId = req.user.id;
    const summary = await getPortSummaryReadOnly(userId);
    if (summary.packageExpired || summary.totalPorts <= 0) {
      return res.json({ ok: false, expired: true, message: 'แพ็คเกจหมดอายุ กรุณาต่ออายุแพ็กเกจก่อนใช้งาน MT5' });
    }

    const usedSlots = await safeQuery(`
      SELECT port_slot
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND port_slot IS NOT NULL
        AND LOWER(TRIM(COALESCE(status,''))) IN ('connecting','checking','connected','ready','starting')
    `, [userId]);
    const usedSlotSet = new Set((usedSlots || []).map(r => num(r.port_slot)));
    const usedPorts = (usedSlots || []).length;
    let nextPortSlot = 0;
    for (let i = 1; i <= summary.totalPorts; i += 1) {
      if (!usedSlotSet.has(i)) { nextPortSlot = i; break; }
    }
    if (!nextPortSlot) {
      return res.json({ ok: false, message: `PORT เต็มแล้ว (${usedPorts}/${summary.totalPorts})` });
    }

    const vps = await findAvailableVpsPort();

    if (!vps) {
      return res.json({
        ok: false,
        message: 'ไม่พบ VPS/PORT ว่าง'
      });
    }

    return res.json({
      ok: true,
      vps_id: vps.node_id,
      vps_name: vps.node_name,
      port: vps.port_number,
      port_id: vps.port_id,
      port_slot: nextPortSlot,
      ai_score: vps.ai_score,
      source: vps.source,
      cpu_percent: vps.cpu_percent,
      ram_percent: vps.ram_percent,
      ping_ms: vps.ping_ms
    });

  } catch (e) {
    return res.json({
      ok: false,
      message: e.message
    });
  }
});

router.get('/mt5/connect-status', async (req, res) => {
  try {
    const userId = req.user.id;

    const rows = await safeQuery(`
      SELECT id, mt5_login, port_slot, status, last_error, updated_at
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,''))) IN ('connecting', 'connected', 'failed')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `, [userId]);

    const account = rows[0] || null;
    const st = String(account?.status || '').toLowerCase();

    if (account && st === 'connecting') {
      return res.json({
        ok: true,
        connected: false,
        failed: false,
        pending: true,
        message: '',
        account
      });
    }

    if (account && st === 'failed') {
      await query(`
        UPDATE vps_system.mt5_accounts
        SET last_error=NULL
        WHERE id=$1 AND user_id=$2
      `, [account.id, userId]);

      return res.json({
        ok: true,
        connected: false,
        failed: true,
        message: account.last_error || 'MT5 login failed',
        account
      });
    }

    if (account && st === 'connected') {
      const STALE_THRESHOLD_SEC = 30;
      const uat = account.updated_at ? new Date(account.updated_at).getTime() : 0;
      if (uat && Date.now() - uat > STALE_THRESHOLD_SEC * 1000) {
        return res.json({
          ok: true,
          connected: false,
          failed: false,
          message: '',
          account: null
        });
      }
    }

    return res.json({
      ok: true,
      connected: !!account && st === 'connected',
      failed: false,
      message: '',
      account
    });
  } catch (e) {
    return res.json({ ok: false, connected: false, failed: false, message: e.message });
  }
});

router.get('/mt5/recovery-check', async (req, res) => {
  try {
    const cronKey = process.env.MT5_RECOVERY_CRON_KEY;
    const okCron = cronKey && String(req.query.key || '') === String(cronKey);
    if (!okCron && !req.user) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const stuck = await safeQuery(
      `
      SELECT id, user_id, vps_id, port_id, port_slot, assigned_port_no, windows_port_no,
             mt5_login, mt5_password, server_name, updated_at
      FROM vps_system.mt5_accounts
      WHERE LOWER(TRIM(COALESCE(status,''))) = 'connecting'
        AND updated_at < NOW() - INTERVAL '2 minutes'
    `,
      [],
      []
    );

    let requeued = 0;
    let failed = 0;

    for (const acc of stuck || []) {
      const accId = num(acc.id);
      const uid = num(acc.user_id);
      if (!accId || !uid) continue;

      if (acc.port_id) {
        await releasePortLock(num(acc.port_id)).catch(() => {});
        const adminNode = acc.vps_id
          ? (await require('../lib/adminVpsBridge').resolveSystemVpsId(acc.vps_id)).adminNodeId
          : null;
        const stopNo = num(acc.assigned_port_no) || num(acc.windows_port_no) || num(acc.port_slot);
        if (adminNode && stopNo) {
          await setAdminAllocationStatus(adminNode, stopNo, 'free').catch(() => {});
        }
      }

      const reserve = await reserveMt5Port(uid);
      if (!reserve.ok) {
        await query(
          `
          UPDATE vps_system.mt5_accounts
          SET status='failed', last_error=$2, updated_at=NOW()
          WHERE id=$1
        `,
          [accId, reserve.message || 'ไม่มี VPS ว่าง']
        ).catch(() => {});
        failed += 1;
        continue;
      }

      const p = reserve.port;
      const allocPortNo = num(p.port_number || parsePortNumber(p) || acc.port_slot);
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET vps_id=$2, port_id=$3, assigned_port_no=$4, windows_port_no=$4,
            status='connecting', last_error=NULL, updated_at=NOW()
        WHERE id=$1
      `,
        [accId, p.vps_id, p.port_id, allocPortNo]
      ).catch(() => {});

      if (p.admin_node_id && allocPortNo) {
        await setAdminAllocationStatus(p.admin_node_id, allocPortNo, 'locked', p.allocation_id);
      }

      const payloadJson = JSON.stringify(
        buildMt5LoginPayload({
          accountId: accId,
          userId: uid,
          reservedPort: p,
          portSlot: acc.port_slot,
          mt5Login: acc.mt5_login,
          mt5Password: acc.mt5_password,
          serverName: acc.server_name || FIXED_SERVER
        })
      );

      await query(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1,$1,$2,'login_mt5',$3::jsonb,'pending',NOW(),NOW())
      `,
        [p.vps_id, p.port_id, payloadJson]
      ).catch(() => {});

      requeued += 1;
    }

    return res.json({ ok: true, checked: (stuck || []).length, requeued, failed });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

function buildPortCardState(acc) {
  const accStatus = acc ? String(acc.status || '').toLowerCase() : '';
  const hasEquity =
    acc &&
    ((acc.last_equity != null && acc.last_equity !== '' && Number.isFinite(Number(acc.last_equity))) ||
      (acc.last_balance != null && acc.last_balance !== '' && Number.isFinite(Number(acc.last_balance))));
  const canUse = !!(acc && accStatus === 'connected' && hasEquity);
  let statusLabel = 'ว่าง';
  if (canUse) statusLabel = 'พร้อมรัน';
  else if (accStatus === 'connecting' || accStatus === 'starting') statusLabel = 'กำลังเปิด MT5...';
  else if (accStatus === 'checking') statusLabel = 'กำลังตรวจ Login';
  else if (accStatus === 'failed') statusLabel = 'Login ไม่ผ่าน';
  else if (accStatus === 'ready') statusLabel = 'ต้องเชื่อมต่อใหม่';
  else if (acc) statusLabel = 'ยกเลิกแล้ว';

  let cssClass = '';
  if (canUse) cssClass = 'connected';
  else if (accStatus === 'connecting' || accStatus === 'starting' || accStatus === 'checking') {
    cssClass = 'checking';
  } else if (acc) cssClass = 'cancelled';

  const slotBusy =
    !!acc &&
    ['connecting', 'checking', 'connected', 'ready', 'starting'].includes(accStatus);

  return { accStatus, canUse, statusLabel, cssClass, slotBusy, canPick: !slotBusy };
}

router.get('/mt5/ports-state', requireLogin, async (req, res) => {
  try {
    await ensureBotCatalog().catch((e) => console.error('[ensureBotCatalog]', e.message));
    const userId = req.user.id;
    const summary = await getPortSummaryReadOnly(userId);
    const accounts = await safeQuery(
      `
      SELECT a.id, a.port_slot, a.assigned_port_no, a.mt5_login, a.status, a.last_balance, a.last_equity
      FROM vps_system.mt5_accounts a
      WHERE a.user_id=$1
        AND a.port_slot IS NOT NULL
        AND LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('deleted', 'expired')
      ORDER BY a.port_slot ASC NULLS LAST, a.id ASC
    `,
      [userId]
    );

    const ports = [];
    for (let slot = 1; slot <= summary.totalPorts; slot++) {
      const acc = pickAccountForPortSlot(accounts, slot);
      const meta = buildPortCardState(acc);
      const equity = acc?.last_equity ?? acc?.last_balance;
      const equityPart =
        equity != null && equity !== '' ? ` / Equity: ${equity}` : '';
      ports.push({
        slot,
        accountId: acc ? Number(acc.id) : null,
        mt5_login: acc?.mt5_login || null,
        status: acc?.status || null,
        canUse: meta.canUse,
        cssClass: meta.cssClass,
        canPick: meta.canPick,
        statusLabel: meta.statusLabel,
        sublabel: acc
          ? `Login: ${acc.mt5_login}${equityPart}`
          : 'ยังไม่เชื่อมต่อ'
      });
    }

    const connectedAccounts = (accounts || [])
      .filter((a) => String(a.status || '').toLowerCase() === 'connected')
      .map((a) => ({
        id: Number(a.id),
        port_slot: Number(a.port_slot),
        assigned_port_no: Number(a.assigned_port_no || 0),
        mt5_login: a.mt5_login,
        last_balance: a.last_balance,
        last_equity: a.last_equity
      }));

    const activeRunInstances = await fetchActiveRunInstances(userId).catch(() => []);

    const bots = (await safeQuery(
      `SELECT id, bot_code, display_name, bot_name FROM vps_system.bot_catalog WHERE is_active=TRUE ORDER BY sort_order ASC, id ASC`,
      []
    )).filter((b) => isProductionBot(b));

    return res.json({
      ok: true,
      totalPorts: summary.totalPorts,
      includedPorts: summary.includedPorts,
      packageMaxPorts: summary.packageMaxPorts,
      maxExtraPurchases: summary.maxExtraPurchases,
      packagePortRange: summary.packagePortRange,
      temporaryExtra: summary.temporaryExtra,
      permanentExtra: summary.permanentExtra,
      availablePortCount: summary.availablePortCount,
      connectedCount: summary.availablePortCount,
      connectedOnlyCount: summary.connectedOnlyCount,
      createdPortCount: summary.createdPortCount,
      canAddTemporary: summary.canAddTemporary,
      canAddPermanent: summary.canAddPermanent,
      packageExpired: summary.packageExpired,
      ports,
      connectedAccounts,
      activeRunInstances,
      bots: (bots || []).map((b) => ({
        id: Number(b.id),
        code: String(b.bot_code || b.bot_name || '').trim(),
        label: b.display_name || b.bot_name || `BOT ${b.id}`
      }))
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5', async (req, res) => {
  const userId = req.user.id;
  const historyPageSize = 5;
  const historyPage = Math.max(1, parseInt(req.query.history_page, 10) || 1);

  await ensureBotCatalog().catch((e) => console.error('[ensureBotCatalog]', e.message));

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='deleted', updated_at=NOW()
    WHERE user_id=$1
      AND LOWER(TRIM(COALESCE(status,''))) = 'failed'
      AND updated_at < NOW() - INTERVAL '5 minutes'
  `, [userId]).catch(() => {});

  await repairUserMt5AccountStatuses(userId).catch(() => {});

  const summary = await getPortSummaryReadOnly(userId);

  const accounts = await safeQuery(`
    SELECT a.*, (
      SELECT COUNT(*)::int FROM vps_system.bot_instances bi
      WHERE bi.mt5_account_id=a.id AND bi.status IN ('running','pending')
    ) AS running_bots
    FROM vps_system.mt5_accounts a
    WHERE a.user_id=$1
      AND LOWER(TRIM(COALESCE(a.status,'ready'))) IN ('ready','connected','checking','connecting','starting')
    ORDER BY a.port_slot ASC, a.id ASC
  `, [userId]);

  const portSlotAccounts = await safeQuery(`
    SELECT a.*, (
      SELECT COUNT(*)::int FROM vps_system.bot_instances bi
      WHERE bi.mt5_account_id=a.id AND bi.status IN ('running','pending')
    ) AS running_bots
    FROM vps_system.mt5_accounts a
    WHERE a.user_id=$1
      AND a.port_slot IS NOT NULL
      AND LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('deleted', 'expired')
    ORDER BY a.port_slot ASC, a.id ASC
  `, [userId]);

  const pendingConnectAccount = (accounts || []).find((row) =>
    ['checking', 'connecting', 'starting'].includes(String(row.status || '').toLowerCase())
  );

  const connectedRunAccounts = (accounts || [])
    .filter((row) => String(row.status || '').toLowerCase() === 'connected')
    .map((row) => ({
      id: Number(row.id),
      port_slot: Number(row.port_slot || 0),
      assigned_port_no: Number(row.assigned_port_no || 0),
      mt5_login: row.mt5_login,
      last_balance: row.last_balance,
      last_equity: row.last_equity,
      running_bots: Number(row.running_bots || 0)
    }));

  const bots = (await safeQuery(`SELECT * FROM vps_system.bot_catalog WHERE is_active=TRUE ORDER BY sort_order ASC, id ASC`, []))
    .filter((row) => isProductionBot(row));
  const runLotMeta = packageLotLimits(summary);
  const runBotUi = Object.fromEntries(
    (bots || []).map((bot) => [String(bot.bot_code || '').trim(), botUiMeta(bot)])
  );
  const vpsProbe = await findAvailableVpsPort();

  const dashPage = await fetchHistoryInstances(userId, {
    limit: historyPageSize,
    offset: (Math.max(1, historyPage) - 1) * historyPageSize
  }).catch(() => ({ instances: [], total: 0, pageSize: historyPageSize, pageCount: 1 }));
  const instances = dashPage.instances || [];
  const historyTotal = dashPage.total || 0;
  const historyPageCount = dashPage.pageCount || 1;
  const historySafePage = Math.min(historyPage, historyPageCount);
  const activeRunInstances = await fetchActiveRunInstances(userId).catch(() => []);

  const flashData = pullFlash(req);

  const now = new Date();
  const endAt = summary.pkg.end_at ? new Date(summary.pkg.end_at) : null;
  const packageDaysLeft = endAt && !summary.packageExpired
    ? Math.max(0, Math.ceil((endAt - now) / (1000 * 60 * 60 * 24)))
    : 0;

  const latestCoupon = summary.couponDetails && summary.couponDetails[0] ? summary.couponDetails[0] : null;
  const couponDiscountPercent = latestCoupon ? num(latestCoupon.discount_percent) : 0;
  const couponDiscountAmount = latestCoupon ? num(latestCoupon.discount_amount) : 0;
  const couponFreeDays = latestCoupon ? num(latestCoupon.free_days) : 0;
  const isCouponFreePackage = !!latestCoupon && couponDiscountPercent <= 0 && couponDiscountAmount <= 0;
  const isCouponPackage = String(summary.paymentDetail?.payment_method || '').toLowerCase() === 'free_coupon'
    || !!summary.paymentDetail?.coupon_id
    || !!latestCoupon;

  const packageTypeText = isCouponPackage ? 'ใช้คูปอง' : 'ซื้อแพ็กเกจ';

  const displayPackageName = packageTierFromText(
    summary.pkg.package_name_snapshot
    || summary.paymentDetail?.package_name_snapshot
    || summary.pkg.package_name
    || summary.pkg.package_group
    || 'แพ็กเกจปัจจุบัน'
  ) || 'แพ็กเกจปัจจุบัน';
  const displayPackageDays = isCouponFreePackage && couponFreeDays > 0
    ? couponFreeDays
    : num(summary.pkg.duration_days || summary.pkg.days || summary.pkg.package_days, 0);
  const displayPackageDaysText = displayPackageDays > 0 ? `${displayPackageDays} วัน` : '-';

  return res.render('app/mt5', {
    pageTitle: 'เชื่อมต่อ MT5',
    pageCss: 'app-mt5-bot.css',
    currentPath: '/app/mt5',
    ...flashData,
    error: flashData.error || '',
    fixedServer: FIXED_SERVER,
    fixedBroker: FIXED_BROKER,
    ...summary,
    packageDaysLeft,
    packageTypeText,
    displayPackageName,
    displayPackageDays,
    displayPackageDaysText,
    accounts,
    portSlotAccounts,
    pickAccountForPortSlot,
    pendingConnectAccountId: pendingConnectAccount ? pendingConnectAccount.id : null,
    bots,
    connectedRunAccounts,
    activeRunInstances,
    runBotUi,
    runPackageGroup: runLotMeta.packageGroup,
    instances,
    historyPage: historySafePage,
    historyPageCount,
    historyPageSize,
    historyTotal,
    packageExpireText: summary.packageExpired ? 'แพ็คเกจหมดอายุ' : fmtDate(summary.pkg.end_at),
    fmtDateView: fmtDate,
    packageLotMin: runLotMeta.lotMin,
    packageLotMax: runLotMeta.lotMax,
    packageDefaultLot: runLotMeta.defaultLot,
    vpsProbe,
    vpsProbeText: vpsProbeText(vpsProbe)
  });
});

router.post('/mt5/connect', async (req, res) => {
  let lockKey = null;
  let vpsLoginGateKey = null;
  let reservedPort = null;
  let pendingAccountId = null;

  try {
    const userId = req.user.id;

console.log('[MT5 CONNECT START]', {
  userId,
  body: req.body
});

    const summary = await getPortSummary(userId);
    const mt5Login = clean(req.body.mt5_login);
    const mt5Password = clean(req.body.mt5_password);

    if (summary.packageExpired || summary.totalPorts <= 0) {
      throw new Error('แพ็คเกจหมดอายุ กรุณาต่ออายุแพ็กเกจก่อนเชื่อมต่อ MT5');
    }

    if (!mt5Login) throw new Error('กรุณากรอกเลข Login MT5');
    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');

    await expireStaleConnectingForLogin(userId, mt5Login, FIXED_SERVER);

    const usedSlots = await safeQuery(`
      SELECT port_slot, mt5_login, status
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,''))) IN ('connecting','checking')
    `, [userId]);

    const busySlots = await safeQuery(`
      SELECT port_slot, mt5_login
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,''))) IN ('connected','ready')
    `, [userId]);

    const usedSlotSet = new Set((usedSlots || []).map((r) => num(r.port_slot)));
    const busySlotSet = new Set();
    for (const row of busySlots || []) {
      const slot = num(row.port_slot);
      if (!slot) continue;
      if (clean(row.mt5_login) === mt5Login) continue;
      busySlotSet.add(slot);
    }
    const slotPick = resolveConnectPortSlot(summary, req.body.port_slot, usedSlotSet, busySlotSet);
    if (!slotPick.ok) throw new Error(slotPick.message || 'ไม่สามารถเลือก PORT ได้');
    const portSlot = slotPick.portSlot;

    const slotAccountRows = await safeQuery(
      `
      SELECT id, mt5_login, status, port_id, vps_id, assigned_port_no
      FROM vps_system.mt5_accounts
      WHERE user_id=$1 AND port_slot=$2
        AND LOWER(TRIM(COALESCE(status,''))) NOT IN ('deleted','expired')
      ORDER BY id DESC
      LIMIT 1
    `,
      [userId, portSlot]
    );
    const slotAccount = slotAccountRows?.[0] || null;
    const slotSt = String(slotAccount?.status || '').toLowerCase();
    if (slotAccount && ['connected', 'ready'].includes(slotSt) && clean(slotAccount.mt5_login) !== mt5Login) {
      throw new Error(
        `PORT ${portSlot} มีบัญชี ${slotAccount.mt5_login} อยู่แล้ว — ลบ PORT ก่อน หรือใช้เลข Login เดิม`
      );
    }

    const {
      findMt5LoginInUse,
      mt5LoginInUseMessage
    } = require('../lib/mt5LoginDuplicate');
    const dupLogin = await findMt5LoginInUse(
      mt5Login,
      FIXED_SERVER,
      userId,
      slotAccount?.id || null,
      portSlot
    );
    if (dupLogin) {
      throw new Error(mt5LoginInUseMessage(dupLogin));
    }

    lockKey = getConnectSlotLockKey(userId, portSlot);
    let locked = false;
    try {
      locked = await redis.set(lockKey, '1', 'NX', 'EX', 120);
    } catch (redisErr) {
      console.warn('[MT5 CONNECT] Redis lock unavailable:', redisErr.message || redisErr);
      locked = true;
    }
    if (!locked) {
      throw new Error(`⏳ PORT ${portSlot} กำลังเชื่อมต่ออยู่ — รอสักครู่ หรือเลือก PORT อื่น (login พร้อมกันได้คนละ PORT)`);
    }

    const {
      tryCachedEquityFastConnect,
      fastConnectErrorMessage
    } = require('../lib/mt5CachedEquityLogin');
    const fast = await tryCachedEquityFastConnect({
      userId,
      mt5Login,
      mt5Password,
      serverName: FIXED_SERVER,
      portSlot
    });
    if (fast.ok) {
      if (lockKey) await redis.del(lockKey).catch(() => {});
      lockKey = null;
      return res.json({
        ok: true,
        status: 'connected',
        connected: true,
        fastPath: true,
        metricsReady: true,
        accountId: fast.accountId,
        portSlot: fast.portSlot || portSlot,
        balance: fast.balance,
        equity: fast.equity,
        message: fast.message
      });
    }
    const fastErr = fastConnectErrorMessage(fast.reason, mt5Login);
    if (fastErr) throw new Error(fastErr);

    console.log('[STEP] BEFORE RESERVE', { portSlot, requestedSlot: req.body.port_slot });

    const reserve = await reserveVpsPortForConnect(userId, slotAccount?.port_id, portSlot);

    console.log('[STEP] AFTER RESERVE', reserve);

    if (!reserve.ok) {
      throw new Error(reserve.message || 'ไม่มี PORT ว่าง');
    }

    reservedPort = reserve.port;
    const allocPortNo = num(
      reservedPort.port_number || parsePortNumber(reservedPort) || portSlot
    );

    console.log('[STEP] RESERVED PORT', reservedPort);

    const existingCmd = await query(
      `
      SELECT id FROM vps_system.vps_agent_commands
      WHERE vps_id=$1
        AND status IN ('pending','processing')
        AND (payload->>'userId')::text = $2::text
        AND (payload->>'portSlot')::text = $3::text
        AND (payload->>'mt5Login')::text = $4::text
        AND command_type IN ('connect_mt5','login_mt5')
        AND created_at > NOW() - INTERVAL '3 minutes'
      LIMIT 1
    `,
      [reservedPort.vps_id, String(userId), String(portSlot), String(mt5Login)]
    ).catch(() => ({ rows: [] }));

    if (existingCmd.rows && existingCmd.rows[0]) {
      await releaseReservedPort(reservedPort);
      return res.json({
        ok: true,
        status: 'queued',
        message: 'ระบบกำลังเปิด MT5 อยู่ กรุณารอสักครู่...',
        commandId: existingCmd.rows[0].id
      });
    }

    await ensureMt5AccountRuntimeColumns().catch((e) => {
      console.log('[STEP] COLUMN ERROR', e.message);
    });

    console.log('[STEP] AFTER ensureMt5AccountRuntimeColumns');

    console.log('[STEP] BEFORE INSERT ACCOUNT');

    const accRes = await query(`
      INSERT INTO vps_system.mt5_accounts
      (
        user_id,
        vps_id,
        port_id,
        port_slot,
        mt5_login,
        mt5_password,
        broker,
        server_name,
        account_name,
        status,
        assigned_port_no,
        last_login_message,
        updated_at
      )
	VALUES
	($1,$2,$3,$4,$5,$6,'MH Markets',$7,$8,'connecting',$9,$10,NOW())
	ON CONFLICT (user_id, mt5_login, server_name)
	DO UPDATE SET
	  mt5_password=EXCLUDED.mt5_password,
	  vps_id=EXCLUDED.vps_id,
	  port_id=EXCLUDED.port_id,
	  port_slot=EXCLUDED.port_slot,
	  assigned_port_no=EXCLUDED.assigned_port_no,
	  windows_port_no=EXCLUDED.assigned_port_no,
	  status='connecting',
	  last_error=NULL,
	  last_login_message=EXCLUDED.last_login_message,
	  updated_at=NOW()
	RETURNING id
    `, [
      userId,
      reservedPort.vps_id,
      reservedPort.port_id,
      portSlot,
      mt5Login,
      mt5Password,
      FIXED_SERVER,
      `PORT ${portSlot}`,
      allocPortNo,
      queueHint
    ]);

    const accountId = accRes.rows[0].id;
    pendingAccountId = accountId;

    console.log('[STEP] BEFORE INSERT COMMAND');

    const loginGate = await acquireVpsLoginSlot(reservedPort.vps_id, allocPortNo);
    vpsLoginGateKey = loginGate.lockKey;

    if (reservedPort.admin_node_id && allocPortNo) {
      await setAdminAllocationStatus(reservedPort.admin_node_id, allocPortNo, 'locked', reservedPort.allocation_id);
    }

    const parallelOnVps = await safeQuery(
      `
      SELECT COUNT(*)::int AS n
      FROM vps_system.mt5_connect_attempts
      WHERE vps_id=$1
        AND account_id <> $2
        AND LOWER(TRIM(COALESCE(status,''))) IN ('connecting','checking','starting')
        AND created_at > NOW() - INTERVAL '3 minutes'
    `,
      [reservedPort.vps_id, accountId]
    );
    const staggerSec = num(parallelOnVps?.[0]?.n) > 0 ? 5 : 0;
    const queueHint =
      num(parallelOnVps?.[0]?.n) > 0
        ? 'มี PORT อื่นกำลัง Login บน VPS เดียวกัน — ระบบคิวให้อัตโนมัติ (ประมาณ 1–2 นาที)'
        : 'กำลังเปิด MT5 และตรวจสอบ Login (ประมาณ 15–45 วินาที)';

    const loginPayload = {
      ...buildMt5LoginPayload({
        accountId,
        userId,
        reservedPort,
        portSlot,
        mt5Login,
        mt5Password,
        serverName: FIXED_SERVER
      }),
      staggerSec
    };
    const payloadJson = JSON.stringify(loginPayload);

    async function insertConnectCommand() {
      return query(
        `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1,$1,$2,'login_mt5',$3::jsonb,'pending',NOW(),NOW())
      RETURNING id
    `,
        [reservedPort.vps_id, reservedPort.port_id, payloadJson]
      );
    }

    let cmdRes;
    try {
      cmdRes = await insertConnectCommand();
    } catch (insErr) {
      const isDup =
        insErr &&
        insErr.code === '23505' &&
        String(insErr.message || '').includes('vps_agent_commands');
      if (isDup) {
        console.warn('[MT5 CONNECT] Repair command id sequence after duplicate pkey, retry insert');
        await repairVpsAgentCommandSequences();
        cmdRes = await insertConnectCommand();
      } else {
        throw insErr;
      }
    }

console.log('[MT5 CONNECT COMMAND INSERTED]', {
  commandId: cmdRes.rows?.[0]?.id,
  accountId,
  reservedPort
});

    const pickLabel = reservedPort.node_name
      ? `${reservedPort.node_name} / ${reservedPort.port_name || 'PORT ' + allocPortNo}`
      : `PORT ${portSlot}`;

    const folderLabel = String(reservedPort.folder_path || '').trim();
    return res.json({
      ok: true,
      status: 'queued',
      message: `ส่งคำสั่งเปิด MT5 แล้ว — PORT แพ็กเกจ ${portSlot}${folderLabel ? ' → ' + folderLabel : ''} (${FIXED_SERVER})`,
      accountId,
      commandId: cmdRes.rows?.[0]?.id || null,
      vpsName: reservedPort.node_name || '',
      folderPath: folderLabel,
      portSlot,
      portNumber: allocPortNo
    });

  } catch (e) {
    console.error('[MT5 CONNECT ERROR]', e);

    const uid = req.user?.id;
    if (pendingAccountId && uid) {
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET status='failed',
            last_error=$3,
            updated_at=NOW()
        WHERE id=$1 AND user_id=$2
          AND LOWER(TRIM(COALESCE(status,'')))='connecting'
      `,
        [
          pendingAccountId,
          uid,
          String(e.message || 'เชื่อมต่อไม่สำเร็จ').slice(0, 900)
        ]
      ).catch(() => {});
    }

    await releaseReservedPort(reservedPort);

    return res.json({
      ok: false,
      status: 'failed',
      message: e.message
    });

  } finally {
    if (vpsLoginGateKey) await releaseVpsLoginSlot(vpsLoginGateKey).catch(() => {});
    if (lockKey) await redis.del(lockKey).catch(() => {});
  }
});

router.post('/mt5/account/:id/edit', async (req, res) => {
  try {
    const userId = req.user.id;
    const id = num(req.params.id);
    const summary = await getPortSummary(userId);
    const portSlot = Math.max(1, num(req.body.port_slot, 1));
    const mt5Login = clean(req.body.mt5_login);
    const mt5Password = clean(req.body.mt5_password);
    if (!id) throw new Error('ไม่พบ PORT ที่ต้องการแก้ไข');
    if (portSlot > summary.totalPorts) throw new Error('แพ็กเกจนี้ใช้ได้ ' + summary.totalPorts + ' PORT');
    if (!mt5Login) throw new Error('กรุณากรอกเลข Login MT5');
    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');
    const running = await query("SELECT id FROM vps_system.bot_instances WHERE mt5_account_id=$1 AND user_id=$2 AND status IN ('running','pending') LIMIT 1", [id, userId]);
    if (running.rows[0]) throw new Error('PORT นี้กำลังรัน BOT อยู่ กรุณาหยุด BOT ก่อนแก้ไข');
    const updated = await query("UPDATE vps_system.mt5_accounts SET mt5_login=$3, mt5_password=$4, broker='MH Markets', server_name=$5, account_name=$6, port_slot=$7, status='ready', updated_at=NOW() WHERE id=$1 AND user_id=$2 AND COALESCE(status,'ready') <> 'deleted' RETURNING id", [id, userId, mt5Login, mt5Password, FIXED_SERVER, 'PORT ' + portSlot, portSlot]);
    if (!updated.rows[0]) throw new Error('ไม่พบ PORT ของคุณ หรือถูกลบไปแล้ว');
    flash(req, 'success', 'แก้ไข PORT ' + portSlot + ' สำเร็จ');
  } catch (e) {
    flash(req, 'error', e.message);
  }
  return res.redirect('/app/mt5');
});

/** หยุด BOT + ปิด MT5 ทันทีเมื่อผู้ใช้ลบ/ยกเลิก PORT (ไม่ต้องกด Stop ก่อน) */
async function queueStopBotsAndMt5ForAccount(userId, accountId, reason = 'user_delete_port') {
  const accStop = await query(
    `
    SELECT ma.vps_id, ma.port_id, ma.port_slot, ma.assigned_port_no, ma.windows_port_no, ma.mt5_login,
           NULLIF(TRIM(COALESCE(vp.folder_path, '')), '') AS folder_path
    FROM vps_system.mt5_accounts ma
    LEFT JOIN vps_system.vps_ports vp ON vp.id = ma.port_id
    WHERE ma.id = $1 AND ma.user_id = $2
    LIMIT 1
  `,
    [accountId, userId]
  ).catch(() => ({ rows: [] }));
  const accRow = accStop.rows?.[0];
  if (accRow) {
    const stopNodeId = num(accRow.vps_id);
    const stopPortNo =
      num(accRow.assigned_port_no) || num(accRow.windows_port_no) || num(accRow.port_slot);
    const folderPath = accRow.folder_path || null;
    if (stopNodeId && stopPortNo) {
      await query(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW(), NOW())
      `,
        [
          stopNodeId,
          accRow.port_id || null,
          JSON.stringify(
            buildStopMt5ReleasePayload({
              portNo: stopPortNo,
              portSlot: accRow.port_slot,
              assignedPortNo: accRow.assigned_port_no,
              windowsPortNo: accRow.windows_port_no,
              folderPath,
              accountId,
              mt5Login: accRow.mt5_login,
              reason
            })
          )
        ]
      ).catch((e) => console.error('[PORT] stop_mt5 on delete/cancel:', e.message || e));
    }
  }

  const bots = await query(
    `
    SELECT bi.id, bi.vps_id, bi.port_id, bi.assigned_port_no, bi.port_used, bi.lot_used,
           bi.run_payload, bi.mt5_login,
           COALESCE(vp.folder_path, '') AS folder_path
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.vps_ports vp ON vp.id = bi.port_id
    WHERE bi.mt5_account_id = $1
      AND bi.user_id = $2
      AND bi.status IN ('running', 'pending', 'restarting')
    ORDER BY bi.id DESC
  `,
    [accountId, userId]
  ).catch(() => ({ rows: [] }));

  for (const bi of bots.rows || []) {
    const runPayload = bi.run_payload && typeof bi.run_payload === 'object' ? bi.run_payload : {};
    const portNo = num(bi.assigned_port_no || bi.port_used || runPayload.portNumber || runPayload.port);
    const folderPath = String(
      bi.folder_path || runPayload.vpsFolderPath || runPayload.folder_path || runPayload.folderPath || ''
    ).trim();
    const stopNodeId = num(bi.vps_id);
    if (!stopNodeId || !portNo) continue;

    await query(
      `
      UPDATE vps_system.bot_instances
      SET status = 'stopped',
          stopped_at = COALESCE(stopped_at, NOW()),
          updated_at = NOW(),
          ea_status = 'stopped',
          last_error = $3
      WHERE id = $1 AND user_id = $2
    `,
      [bi.id, userId, reason]
    ).catch(() => {});

    await query(
      `
      UPDATE vps_system.vps_nodes
      SET used_ports = GREATEST(0, COALESCE(used_ports, 0) - 1),
          used_lot = GREATEST(0, COALESCE(used_lot, 0) - $2),
          status = CASE WHEN status = 'busy' THEN 'online' ELSE status END,
          updated_at = NOW()
      WHERE id = $1
    `,
      [stopNodeId, num(bi.lot_used)]
    ).catch(() => {});

    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1, $1, $2, 'stop_mt5_bot', $3::jsonb, 'pending', NOW(), NOW())
    `,
      [
        stopNodeId,
        bi.port_id || null,
        JSON.stringify({
          action: 'stop_bot_trading',
          commandType: 'stop_mt5_bot',
          instanceId: bi.id,
          accountId,
          port: portNo,
          portNumber: portNo,
          portSlot: num(bi.port_used || runPayload.portSlot || portNo),
          folder_path: folderPath || null,
          vpsFolderPath: folderPath || null,
          stopTradingOnly: false,
          forceKill: true,
          closeMt5: true,
          closeAllPositions: true,
          botCode: runPayload.botCode || runPayload.eaName || null,
          mt5Login: runPayload.mt5Login || bi.mt5_login || null,
          expectedMt5Login: runPayload.mt5Login || bi.mt5_login || null,
          reason
        })
      ]
    ).catch((e) => console.error('[PORT] stop_mt5_bot error:', e.message || e));
  }
}

router.post('/mt5/account/:id/cancel', async (req, res) => {
  try {
    const userId = req.user.id;
    const id = num(req.params.id);

    if (!id) throw new Error('ไม่พบ PORT ที่ต้องการยกเลิก');

    await queueStopBotsAndMt5ForAccount(userId, id, 'user_cancel_port');

    // STEP 1: ดึงค่า PORT/VPS เดิมก่อนล้างค่า
    const old = await query(`
      SELECT ma.port_slot, ma.vps_id, ma.port_id, ma.assigned_port_no, ma.windows_port_no,
             NULLIF(TRIM(COALESCE(vp.folder_path, '')), '') AS folder_path
      FROM vps_system.mt5_accounts
      LEFT JOIN vps_system.vps_ports vp ON vp.id = ma.port_id
      WHERE ma.id=$1
        AND ma.user_id=$2
        AND LOWER(TRIM(COALESCE(ma.status,'ready'))) <> 'deleted'
      LIMIT 1
    `, [id, userId]);

    if (!old.rows[0]) {
      throw new Error('ไม่พบ PORT ของคุณ หรือถูกลบไปแล้ว');
    }

    const oldPort = old.rows[0];
    const stopNodeId = num(oldPort.vps_id);
    const stopPortNo =
      num(oldPort.assigned_port_no) ||
      num(oldPort.windows_port_no) ||
      num(oldPort.port_slot);
    const folderPath = oldPort.folder_path || null;

    await abortConnectForRemovedAccount(id, {
      vpsId: stopNodeId || null,
      portId: oldPort.port_id || null,
      message: 'ยกเลิกเพราะผู้ใช้ยกเลิก PORT'
    }).catch((e) => console.error('[CANCEL] abort connect error:', e.message || e));

    // STEP 2: ส่งคำสั่งให้ Agent ปิด terminal64 ก่อน
    if (stopNodeId && stopPortNo) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at)
        VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW())
      `, [
        stopNodeId,
        oldPort.port_id || null,
        JSON.stringify(
          buildStopMt5ReleasePayload({
            portNo: stopPortNo,
            portSlot: oldPort.port_slot,
            assignedPortNo: oldPort.assigned_port_no,
            windowsPortNo: oldPort.windows_port_no,
            folderPath,
            accountId: id,
            reason: 'user_cancel_port_before_clear'
          })
        )
      ]);
      if (oldPort.port_id) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
          WHERE id=$1
        `, [oldPort.port_id]).catch(() => {});
      }
      const { adminNodeId } = await resolveSystemVpsId(stopNodeId).catch(() => ({}));
      await reconcilePortIdleWhenAgentFree(adminNodeId || stopNodeId, stopPortNo, folderPath).catch(() => {});
    }

    // STEP 3: ค่อยล้างค่าใน DB
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='cancelled',
          assigned_port_no=NULL,
          windows_port_no=NULL,
          vps_id=NULL,
          port_id=NULL,
          updated_at=NOW()
      WHERE id=$1
        AND user_id=$2
        AND LOWER(TRIM(COALESCE(status,'ready'))) <> 'deleted'
    `, [id, userId]);

    flash(req, 'success', 'ยกเลิก PORT ' + (oldPort.port_slot || '') + ' แล้ว');
  } catch (e) {
    flash(req, 'error', e.message);
  }

  return res.redirect('/app/mt5');
});

router.post('/mt5/account/:id/delete', async (req, res) => {
  try {
    const userId = req.user.id;
    const id = num(req.params.id);

    if (!id) throw new Error('ไม่พบ PORT ที่ต้องการลบ');

    await queueStopBotsAndMt5ForAccount(userId, id, 'user_delete_port');

    // STEP 1: ดึง PORT/VPS + folder_path จาก vps_ports (strict mode บน agent)
    const old = await query(`
      SELECT
        ma.port_slot,
        ma.vps_id,
        ma.port_id,
        ma.assigned_port_no,
        ma.windows_port_no,
        NULLIF(TRIM(COALESCE(vp.folder_path, '')), '') AS folder_path
      FROM vps_system.mt5_accounts ma
      LEFT JOIN vps_system.vps_ports vp ON vp.id = ma.port_id
      WHERE ma.id=$1
        AND ma.user_id=$2
        AND LOWER(TRIM(COALESCE(ma.status,'ready'))) <> 'deleted'
      LIMIT 1
    `, [id, userId]);

    if (!old.rows[0]) {
      throw new Error('ไม่พบ PORT ของคุณ หรือถูกลบไปแล้ว');
    }

    const oldPort = old.rows[0];
    const stopNodeId = num(oldPort.vps_id);
    const stopPortNo =
      num(oldPort.assigned_port_no) ||
      num(oldPort.windows_port_no) ||
      num(oldPort.port_slot);
    const folderPath = oldPort.folder_path || null;

    await abortConnectForRemovedAccount(id, {
      vpsId: stopNodeId || null,
      portId: oldPort.port_id || null,
      message: 'ยกเลิกเพราะผู้ใช้ลบ PORT'
    }).catch((e) => console.error('[DELETE] abort connect error:', e.message || e));

    // STEP 2: ส่งคำสั่งให้ Agent ปิด terminal64 ก่อน + release pool
    if (stopNodeId && stopPortNo) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at)
        VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW())
      `, [
        stopNodeId,
        oldPort.port_id || null,
        JSON.stringify(
          buildStopMt5ReleasePayload({
            portNo: stopPortNo,
            portSlot: oldPort.port_slot,
            assignedPortNo: oldPort.assigned_port_no,
            windowsPortNo: oldPort.windows_port_no,
            folderPath,
            accountId: id,
            reason: 'user_delete_port'
          })
        )
      ]).catch((e) => console.error('[DELETE] cmd insert error:', e.message || e));
      if (oldPort.port_id) {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
          WHERE id=$1
        `, [oldPort.port_id]).catch((err) =>
          console.error('[DELETE] release vps_ports by id error:', err.message || err)
        );
      } else {
        await query(`
          UPDATE vps_system.vps_ports
          SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
          WHERE vps_id=$1 AND port_no=$2
        `, [stopNodeId, stopPortNo]).catch((err) =>
          console.error('[DELETE] release vps_ports error:', err.message || err)
        );
      }
      const { adminNodeId } = await resolveSystemVpsId(stopNodeId).catch(() => ({}));
      await reconcilePortIdleWhenAgentFree(adminNodeId || stopNodeId, stopPortNo, folderPath).catch(() => {});
    }

    // STEP 3: ค่อยล้างค่าใน DB
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='deleted',
          assigned_port_no=NULL,
          windows_port_no=NULL,
          vps_id=NULL,
          port_id=NULL,
          updated_at=NOW()
      WHERE id=$1
        AND user_id=$2
        AND LOWER(TRIM(COALESCE(status,'ready'))) <> 'deleted'
    `, [id, userId]);

    flash(req, 'success', 'ลบ PORT ' + (oldPort.port_slot || '') + ' แล้ว — สั่งปิด MT5 แล้ว');
  } catch (e) {
    flash(req, 'error', e.message);
  }

  return res.redirect('/app/mt5');
});

router.post('/mt5/ports/add', async (req, res) => {
  const client = await getClient();

  try {
    const userId = req.user.id;
    const portType = req.body.port_type === 'permanent' ? 'permanent' : 'temporary';
    const price = portType === 'permanent' ? 10 : 1;

    await ensureExtraPortsTable().catch(() => {});

    // CLEAN นอก transaction เท่านั้น
    await query(`
      UPDATE user_subscriptions
      SET status='expired', updated_at=NOW()
      WHERE user_id=$1
        AND COALESCE(status,'active')='active'
        AND end_at IS NOT NULL
        AND end_at <= NOW()
    `, [userId]).catch(() => {});

    await query(`
      UPDATE vps_system.mt5_extra_ports
      SET is_active=FALSE
      WHERE user_id=$1
        AND port_type='temporary'
        AND is_active=TRUE
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
    `, [userId]).catch(() => {});

    const summary = await getPortSummary(userId);
    if (summary.packageExpired || summary.totalPorts <= 0) {
      throw new Error('แพ็คเกจหมดอายุ กรุณาต่ออายุแพ็กเกจก่อนซื้อ PORT เพิ่ม');
    }

    await client.query('BEGIN');

    const pkgRows = await client.query(`
      SELECT us.id AS subscription_id,
             us.package_id,
             UPPER(COALESCE(to_jsonb(p)->>'group_name', to_jsonb(p)->>'package_group', to_jsonb(p)->>'package_code', '')) AS package_group,
             COALESCE(
               NULLIF(us.ports_max, 0),
               NULLIF(us.ports_min, 0),
               NULLIF(to_jsonb(p)->>'ports_max','')::int,
               NULLIF(to_jsonb(p)->>'max_ports','')::int,
               NULLIF(to_jsonb(p)->>'port_limit','')::int,
               1
             ) AS max_ports,
             us.end_at
      FROM user_subscriptions us
      LEFT JOIN packages p ON p.id=us.package_id
      WHERE us.user_id=$1
        AND COALESCE(us.status,'')='active'
        AND (us.end_at IS NULL OR us.end_at > NOW())
      ORDER BY us.end_at DESC NULLS LAST, us.id DESC
      LIMIT 1
    `, [userId]);

    const pkg = pkgRows.rows[0];
    if (!pkg) throw new Error('ไม่พบแพ็กเกจที่ใช้งานอยู่');

    const group = String(pkg.package_group || '').toUpperCase();
    const packageMaxPorts = packagePortCapForGroup(group, pkg.max_ports);

    const extraRows = await getExtraPortRows(
      userId,
      pkg.subscription_id,
      pkg.package_id,
      group
    );
    const entitlement = computePortEntitlement(packageMaxPorts, extraRows, group);

    if (portType === 'temporary' && !entitlement.canAddTemporary) {
      throw new Error(
        `พอร์ตชั่วคราวเพิ่มได้ไม่เกิน ${packageMaxPorts} ช่อง และรวมใช้ได้ไม่เกิน ${packageMaxPorts} PORT (แพ็กเกจ ${group})`
      );
    }
    if (portType === 'permanent' && !entitlement.canAddPermanent) {
      throw new Error(
        `พอร์ตถาวรเพิ่มไม่ได้ สิทธิ์รวมสูงสุด ${packageMaxPorts} PORT (ผูกระดับ ${group})`
      );
    }

    const u = await client.query(`SELECT scoin_balance FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    const balance = num(u.rows[0]?.scoin_balance);

    if (balance < price) {
      throw new Error(`Scoin ไม่พอ ต้องใช้ ${price} Scoin`);
    }

    await client.query(`UPDATE users SET scoin_balance=$2 WHERE id=$1`, [userId, balance - price]);

    const expiresAt = portType === 'temporary' && pkg.end_at ? new Date(pkg.end_at) : null;

    await client.query(`
      INSERT INTO vps_system.mt5_extra_ports
      (user_id, qty, port_type, subscription_id, package_id, package_group, price_scoin, expires_at, is_active, created_at)
      VALUES ($1,1,$2,$3,$4,$5,$6,$7,TRUE,NOW())
    `, [
      userId,
      portType,
      pkg.subscription_id,
      pkg.package_id,
      group,
      price,
      expiresAt
    ]);

    await client.query('COMMIT');

    flash(req, 'success', portType === 'permanent' ? 'ซื้อพอร์ตถาวรสำเร็จ' : 'ซื้อพอร์ตสำเร็จ');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('MT5 PORT ADD ERROR:', e);
    flash(req, 'error', e.message || 'เกิดข้อผิดพลาดระบบ');
  } finally {
    client.release();
  }

  return res.redirect('/app/mt5');
});

router.get('/mt5/run-preset', requireLogin, async (req, res) => {
  try {
    await ensureBotCatalog();
    const botCode = clean(req.query.bot_code || req.query.botCode).toUpperCase();
    const tradeLevel = normalizeTradeLevel(req.query.trade_level);
    const runTimeMode = String(req.query.run_time_mode || 'auto').toLowerCase() === '24h' ? '24h' : 'auto';
    const capital = num(req.query.capital_manual || req.query.capital);
    const manualLot = num(req.query.manual_lot);
    const botRows = await query(
      `SELECT * FROM vps_system.bot_catalog WHERE UPPER(bot_code)=UPPER($1) AND is_active=TRUE LIMIT 1`,
      [botCode]
    );
    const bot = botRows.rows[0];
    if (!bot) return res.json({ ok: false, message: 'ไม่พบ BOT' });
    const summary = await getPortSummary(req.user.id);
    const lotMeta = packageLotLimits(summary);
    const calc = computePresetForBot(
      bot,
      capital,
      tradeLevel,
      manualLot,
      lotMeta.lotMin,
      lotMeta.lotMax,
      lotMeta.defaultLot
    );
    return res.json({
      ok: true,
      preview: {
        ...presetSummary(calc, tradeLevel),
        capital: calc.capital,
        capitalUsed: calc.capitalUsed,
        lot: calc.lot,
        lotPlus: calc.lotPlus,
        lotReadonly: calc.lotReadonly,
        showTradeLevel: calc.showTradeLevel,
        showRunTimeMode: calc.showRunTimeMode,
        showLotField: calc.showLotField,
        minCapital: calc.minCapital,
        packageCapped: calc.packageCapped,
        runTimeMode,
        timeLabel: runTimeMode === '24h' ? 'Open 24H.' : 'Auto trading'
      },
      ui: botUiMeta(bot)
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.post('/mt5/run', async (req, res) => {
  let client = null;
  let accountLockKey = null;
  let vpsRunLockKey = null;
  let vpsLoginGateKey = null;
  let loginGateWaitedMs = 0;
  let runGateWaitedMs = 0;
  let reservedPortForRun = null;
  const wantJson = String(req.body?.run_fetch || req.get('X-MT5-Run-Fetch') || '').trim() === '1';
  let runOkMessage = '';
  let runErrorMessage = '';
  try {
    await ensureBotCatalog();
    const userId = req.user.id;
    const mt5AccountId = num(req.body.mt5_account_id);
    accountLockKey = getUserRunAccountLockKey(userId, mt5AccountId);
    const accountLocked = await redis.set(accountLockKey, '1', 'NX', 'EX', 45);
    if (!accountLocked) {
      throw new Error('⏳ PORT นี้กำลังส่งคำสั่ง Run อยู่ — รอสักครู่');
    }
    const botCode = clean(req.body.bot_code).toUpperCase();
    const capitalManual = num(req.body.capital_manual);
    const manualLot = num(req.body.manual_lot);
    const lotPlusInput = num(req.body.lot_plus);
    const tStartInput = req.body.t_start === '' || req.body.t_start == null ? null : num(req.body.t_start);
    const tStopInput = req.body.t_stop === '' || req.body.t_stop == null ? null : num(req.body.t_stop);
    const tradeLevel = normalizeTradeLevel(req.body.trade_level);
    const runTimeMode = String(req.body.run_time_mode || 'auto').toLowerCase() === '24h' ? '24h' : 'auto';
    const syncField = String(req.body.sync_field || 'capital').toLowerCase() === 'lot' ? 'lot' : 'capital';

    if (!mt5AccountId) throw new Error('กรุณาเลือก PORT/บัญชี MT5');
    if (!botCode) throw new Error('กรุณาเลือก BOT');

    const summary = await getPortSummaryReadOnly(userId);
    const lotMeta = packageLotLimits(summary);
    const running = await query(
      `SELECT COUNT(*)::int c FROM vps_system.bot_instances WHERE user_id=$1 AND status IN ('running','pending')`,
      [userId]
    );
    if (num(running.rows[0]?.c) >= summary.totalPorts) {
      throw new Error(`จำนวน BOT ที่รันเต็มแล้ว ตามสิทธิ์ ${summary.totalPorts} PORT`);
    }

    let account = (
      await query(`SELECT * FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 LIMIT 1`, [mt5AccountId, userId])
    ).rows[0];
    if (!account) throw new Error('ไม่พบบัญชี MT5 ของคุณ');
    if (String(account.status || '').toLowerCase() !== 'connected') {
      throw new Error('PORT นี้ยังไม่พร้อมใช้งาน กรุณาเชื่อมต่อ MT5 ให้สำเร็จก่อน');
    }

    if (!num(account.vps_id) || !num(account.assigned_port_no)) {
      const reserve = await reserveVpsPortForConnect(userId, account.port_id, num(account.port_slot));
      if (!reserve.ok) {
        throw new Error(reserve.message || 'ไม่มี VPS/PORT ว่างสำหรับ Run BOT — ลองใหม่อีกครั้ง');
      }
      reservedPortForRun = reserve.port;
      const allocPortNo = num(
        reservedPortForRun.port_number || reservedPortForRun.port_no || account.port_slot
      );
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET vps_id=$2,
            port_id=$3,
            assigned_port_no=$4,
            windows_port_no=$4,
            updated_at=NOW()
        WHERE id=$1
      `,
        [mt5AccountId, reservedPortForRun.vps_id, reservedPortForRun.port_id, allocPortNo]
      );
      account = (
        await query(`SELECT * FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 LIMIT 1`, [mt5AccountId, userId])
      ).rows[0];
    }

    const preVpsId = num(account?.vps_id, 0);
    const assignedPortNo = num(account?.assigned_port_no, 0);
    if (!preVpsId || !assignedPortNo) {
      throw new Error('PORT นี้ยังไม่มีข้อมูล VPS/PORT ที่พร้อมรัน');
    }

    const botRows = await query(
      `SELECT * FROM vps_system.bot_catalog WHERE UPPER(bot_code)=UPPER($1) AND is_active=TRUE LIMIT 1`,
      [botCode]
    );
    const bot = botRows.rows[0];
    if (!bot) throw new Error('ไม่พบ BOT ที่เลือก');
    if (!isProductionBot(bot)) throw new Error('BOT นี้ไม่ได้เปิดให้ใช้งานบนหน้าเว็บนี้');

    const capital = capitalManual > 0 ? capitalManual : num(account.last_equity || account.last_balance || account.capital_override, 0);
    const capitalCheck = validateRunCapital(capital, bot);
    if (!capitalCheck.ok) throw new Error(capitalCheck.message);

    const calc = computePresetForBot(
      bot,
      capitalCheck.capital,
      tradeLevel,
      manualLot,
      lotMeta.lotMin,
      lotMeta.lotMax,
      lotMeta.defaultLot,
      syncField
    );
    if (botKind(bot) === 'queen' && num(calc.lot) <= 0) {
      throw new Error('เงินทุนไม่พอใช้บอทตัวนี้ (ขั้นต่ำ 10,000 USD)');
    }
    let lot = num(calc.lot);
    if (lot <= 0 && botKind(bot) === 'quantum') lot = 0.01;
    const trade = calc.trade;
    const capitalUsed = num(calc.capitalUsed || calc.capital || capitalCheck.capital);
    const runSummary = buildRunSummary(calc, tradeLevel, runTimeMode);
    const lotPlus = clampLot(lotPlusInput > 0 ? lotPlusInput : calc.lotPlus, lotMeta.lotMin, lotMeta.lotMax);
    const tStart = tStartInput == null ? num(trade.t_start) : tStartInput;
    const tStop = tStopInput == null ? num(trade.t_stop) : tStopInput;
    const pipStep = num(calc.pipStep, 345);
    const takeProfitAverage = num(calc.takeProfitAverage, 100);
    const eaTimeProfile = buildEaTimeProfile(runTimeMode);
    const eaSetPreview = presetSummary(
      { ...calc, trade: { ...trade, t_start: tStart, t_stop: tStop } },
      tradeLevel
    );
    const eaSetFields = buildEaSetPayloadFields({
      bot,
      botKind: calc.botKind,
      lot,
      lotPlus,
      capital: capitalUsed,
      trade: { ...trade, t_start: tStart, t_stop: tStop },
      preset: calc.preset,
      presetSlug: calc.presetSlug,
      eaTimeProfile,
      runTimeMode
    });

    const nodePreview = (
      await query(`SELECT * FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`, [preVpsId])
    ).rows[0];
    if (!nodePreview) throw new Error('ไม่พบ Windows VPS ของ PORT ที่เลือก');

    const runBotQueueDelaySec = await computeRunBotQueueDelaySec(
      nodePreview.id,
      mt5AccountId,
      assignedPortNo
    ).catch(() => 0);
    const portCtxRows = await query(
      `
      SELECT
        vp.id,
        vp.port_no,
        NULLIF(TRIM(COALESCE(vp.folder_path, '')), '') AS folder_path
      FROM vps_system.vps_ports vp
      WHERE (vp.id = $1)
         OR (vp.vps_id = $2 AND vp.port_no = $3)
      ORDER BY CASE WHEN vp.id = $1 THEN 0 ELSE 1 END
      LIMIT 1
    `,
      [account.port_id || null, nodePreview.id, assignedPortNo]
    );
    const portCtx = portCtxRows.rows[0] || {};
    const folderPath = String(
      portCtx.folder_path
      || `C:\\MT5_PORTS\\${String(nodePreview.node_code || 'VPS-WIN-01').trim() || 'VPS-WIN-01'}-PORT-${String(assignedPortNo).padStart(2, '0')}`
    ).trim();
    const vpsPortName = String(
      nodePreview.node_code && assignedPortNo
        ? `${String(nodePreview.node_code).trim()}-PORT-${String(assignedPortNo).padStart(2, '0')}`
        : ''
    ).trim();

    const usePhase2BotRun = String(process.env.MT5_PHASE2_BOT_RUN || '1').trim() !== '0';
    if (usePhase2BotRun) await assertNoRecentBotRunAttempt(mt5AccountId);

    const runGate = await acquireVpsRunBotSlot(preVpsId);
    vpsRunLockKey = runGate.lockKey;
    runGateWaitedMs = runGate.waitedMs || 0;

    let loginQueueDelaySec = 0;
    let journalTimeoutSec = 0;
    if (usePhase2BotRun) {
      loginQueueDelaySec = await computeLoginQueueDelaySec(
        nodePreview.id,
        mt5AccountId,
        assignedPortNo
      ).catch(() => 0);
      journalTimeoutSec = computeJournalTimeoutSec({
        activeLoginCount: await countActiveLoginsOnVps(nodePreview.id).catch(() => 0)
      });
      const prevLoginGateMax = process.env.MT5_LOGIN_GATE_MAX_WAIT_MS;
      if (!prevLoginGateMax || num(prevLoginGateMax) > 30000) {
        process.env.MT5_LOGIN_GATE_MAX_WAIT_MS = '30000';
      }
      try {
        const loginGate = await acquireVpsLoginSlot(nodePreview.id, assignedPortNo);
        vpsLoginGateKey = loginGate.lockKey;
        loginGateWaitedMs = loginGate.waitedMs || 0;
      } finally {
        if (prevLoginGateMax === undefined) delete process.env.MT5_LOGIN_GATE_MAX_WAIT_MS;
        else process.env.MT5_LOGIN_GATE_MAX_WAIT_MS = prevLoginGateMax;
      }
    }

    const payload = {
      action: 'run_mt5_bot',
      commandType: 'run_mt5_bot',
      userId,
      accountId: mt5AccountId,
      broker: 'MH Markets',
      serverName: FIXED_SERVER,
      mt5Login: account.mt5_login,
      mt5Password: account.mt5_password,
      password: account.mt5_password,
      botCode: bot.bot_code,
      botName: bot.display_name || bot.bot_name,
      eaName: bot.bot_code,
      symbol: 'XAUUSD',
      period: calc.chartPeriod || 'H1',
      chartPeriod: calc.chartPeriod || 'H1',
      lot,
      lotPlus,
      capital: capitalUsed,
      capitalUsed,
      packageLotCapped: !!calc.packageCapped,
      tradeLevel: trade.trade_level,
      riskLabel: tradeLevelLabel(trade.trade_level),
      tStart,
      tStop,
      pipStep,
      takeProfitAverage,
      presetId: calc.preset?.id || null,
      presetSlug: calc.presetSlug || null,
      presetRow: calc.preset || null,
      presetMatchBy: calc.presetMatchBy || 'capital',
      lotOverride: !!calc.lotOverride,
      runTimeMode,
      eaTimeProfile,
      eaSetPreview,
      runSummary,
      botKind: calc.botKind,
      ...eaSetFields,
      allowOpen24Hours: runTimeMode === '24h',
      useBotSchedule: runTimeMode === 'auto',
      portId: portCtx.id || account.port_id || null,
      vpsId: nodePreview.id,
      nodeId: nodePreview.id,
      nodeCode: nodePreview.node_code || '',
      folderPath,
      folder_path: folderPath,
      vpsFolderPath: folderPath,
      vpsPortName,
      port_no: assignedPortNo,
      portNo: assignedPortNo,
      portNumber: assignedPortNo,
      folderPort: assignedPortNo,
      vpsPortNumber: assignedPortNo,
      expertsRelative: 'MQL5\\Experts\\Trading Bot',
      experts_relative: 'MQL5\\Experts\\Trading Bot',
      ...readBotMq5Source(bot.bot_code),
      port: assignedPortNo,
      portSlot: account.port_slot || 1,
      keepMt5Open: true,
      stopTradingOnly: false,
      queueDelaySec: Math.max(0, Number(runBotQueueDelaySec) || 0)
    };

    client = await getClient();
    if (usePhase2BotRun) await ensureMt5ConnectAttemptTables();
    await client.query('BEGIN');

    const accountRows = await client.query(
      `SELECT * FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [mt5AccountId, userId]
    );
    account = accountRows.rows[0];
    if (!account) throw new Error('ไม่พบบัญชี MT5 ของคุณ');
    if (String(account.status || '').toLowerCase() !== 'connected') {
      throw new Error('PORT นี้ยังไม่พร้อมใช้งาน กรุณาเชื่อมต่อ MT5 ให้สำเร็จก่อน');
    }

    await stopActiveInstancesForAccount(mt5AccountId, userId, client);

    const nodeRows = await client.query(`
      SELECT *
      FROM vps_system.vps_nodes
      WHERE id=$1
      FOR UPDATE
    `, [account.vps_id]);
    const node = nodeRows.rows[0];
    if (!node) throw new Error('ไม่พบ Windows VPS ของ PORT ที่เลือก');

    const inst = await client.query(`
      INSERT INTO vps_system.bot_instances
      (user_id, mt5_account_id, bot_id, vps_id, status, lot_used, port_used, assigned_port_no, preset_id, run_payload, started_at, trade_level, capital_used, updated_at)
      VALUES ($1,$2,$3,$4,'pending',$5,1,$6,$7,$8::jsonb,NOW(),$9,$10,NOW())
      RETURNING *
    `, [userId, mt5AccountId, bot.id, node.id, lot, assignedPortNo, calc.preset?.id || null, JSON.stringify(payload), trade.trade_level, capitalUsed]);

    let cmdId = 0;
    let loginCmdId = 0;
    let attemptId = null;

    if (usePhase2BotRun) {
      attemptId = await createConnectAttempt({
        accountId: mt5AccountId,
        userId,
        vpsId: node.id,
        portId: portCtx.id || account.port_id || null,
        portSlot: account.port_slot || assignedPortNo,
        assignedPortNo,
        folderPath,
        mt5Login: account.mt5_login,
        serverName: FIXED_SERVER,
        purposeType: 'bot_run',
        client
      });

      const runPayload = {
        ...payload,
        instanceId: inst.rows[0].id,
        attemptId,
        queueDelaySec: Math.max(0, Number(runBotQueueDelaySec) || 0)
      };
      const loginPayload = {
        ...runPayload,
        botCode: 'LOGIN_ONLY',
        action: 'login_mt5',
        commandType: 'login_mt5',
        queueDelaySec: Math.max(0, Number(loginQueueDelaySec) || 0),
        journalTimeoutSec
      };

      const queued = await queueBotRunCommands({
        attemptId,
        vpsId: node.id,
        portId: portCtx.id || account.port_id || null,
        loginPayload,
        runPayload,
        client
      });
      loginCmdId = queued.loginCommandId;
      cmdId = queued.runCommandId;

      if (attemptId && loginCmdId) {
        await client.query(
          `UPDATE vps_system.mt5_connect_attempts SET command_id=$2, updated_at=NOW() WHERE attempt_id=$1`,
          [attemptId, loginCmdId]
        );
      }

      await client.query(
        `
        UPDATE vps_system.mt5_accounts
        SET status='connecting',
            last_login_message='Phase 2: กำลังเปิด MT5 เพื่อรัน BOT...',
            current_attempt_id=$2,
            updated_at=NOW()
        WHERE id=$1
      `,
        [mt5AccountId, attemptId]
      );
    } else {
      const cmd = await client.query(`
      INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at)
      VALUES ($1,$1,'run_mt5_bot',$2::jsonb,'pending',NOW())
      RETURNING id
    `, [node.id, JSON.stringify({ ...payload, instanceId: inst.rows[0].id })]);
      cmdId = num(cmd.rows?.[0]?.id);
    }

    await client.query(`UPDATE vps_system.bot_instances SET run_payload=$2::jsonb, updated_at=NOW() WHERE id=$1`, [
      inst.rows[0].id,
      JSON.stringify({
        ...payload,
        instanceId: inst.rows[0].id,
        commandId: cmdId,
        loginCommandId: loginCmdId || undefined,
        attemptId: attemptId || undefined,
        purposeType: usePhase2BotRun ? 'bot_run' : 'legacy_run'
      })
    ]);
    await client.query(`
      UPDATE vps_system.vps_nodes
      SET used_ports=COALESCE(used_ports,0)+1,
          used_lot=COALESCE(used_lot,0)+$2,
          status=CASE WHEN COALESCE(used_ports,0)+1 >= COALESCE(max_ports,20) THEN 'busy' ELSE 'online' END,
          updated_at=NOW()
      WHERE id=$1
    `, [node.id, lot]);

    await client.query('COMMIT');

    const queueNote =
      runGateWaitedMs > 500
        ? ` (คิว VPS ~${Math.ceil(runGateWaitedMs / 1000)} วินาที)`
        : loginGateWaitedMs > 500
          ? ` (คิว Login VPS ~${Math.ceil(loginGateWaitedMs / 1000)} วินาที)`
          : '';
    runOkMessage =
      usePhase2BotRun
        ? `Phase 2: ส่งคำสั่ง Login + Run ${bot.display_name || bot.bot_name} ไปยัง PORT ${assignedPortNo} แล้ว${queueNote} — MT5 จะเปิดค้างไว้รัน BOT`
        : `ส่งคำสั่ง Run ${bot.display_name || bot.bot_name} ไปยัง ${node.node_name || node.node_code || 'Windows VPS'} PORT ${assignedPortNo} แล้ว${queueNote} — รอ VPS ส่ง Balance/Equity จริง`;
    flash(req, 'success', runOkMessage);
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (reservedPortForRun) await releaseReservedPort(reservedPortForRun).catch(() => {});
    runErrorMessage = e.message;
    flash(req, 'error', runErrorMessage);
  } finally {
    if (vpsLoginGateKey) await releaseVpsLoginSlot(vpsLoginGateKey).catch(() => {});
    if (vpsRunLockKey) await releaseVpsRunBotSlot(vpsRunLockKey).catch(() => {});
    if (accountLockKey) await redis.del(accountLockKey).catch(() => {});
    if (client) client.release();
  }
  if (wantJson) {
    if (runOkMessage) {
      return res.json({ ok: true, redirect: '/app/mt5', message: runOkMessage });
    }
    return res.json({ ok: false, message: runErrorMessage || 'ส่งคำสั่ง Run ไม่สำเร็จ' });
  }
  return res.redirect('/app/mt5');
});

router.post('/mt5/stop/:id', async (req, res) => {
  const client = await getClient();
  try {
    const userId = req.user.id;
    const id = num(req.params.id);
    const closeMt5Raw = req.body?.close_mt5 ?? req.body?.closeMt5;
    const closeMt5 = closeMt5Raw == null || closeMt5Raw === ''
      ? true
      : String(closeMt5Raw).toLowerCase() === '1' || String(closeMt5Raw).toLowerCase() === 'true';
    await client.query('BEGIN');
    const rows = await client.query(`SELECT * FROM vps_system.bot_instances WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    const inst = rows.rows[0];
    if (!inst) throw new Error('ไม่พบรายการ BOT');

    const runPayload = (inst.run_payload && typeof inst.run_payload === 'object') ? inst.run_payload : {};
    const portNo = num(inst.assigned_port_no || inst.port_used || runPayload.portNumber || runPayload.port);
    const folderPath = String(
      inst.folder_path || runPayload.vpsFolderPath || runPayload.folder_path || runPayload.folderPath || ''
    ).trim();

    await finalizeBotInstanceRecord(id, { status: 'stopped', lastError: null, db: client });

    if (inst.vps_id) {
      await client.query(`
        UPDATE vps_system.vps_nodes
        SET used_ports=GREATEST(0,COALESCE(used_ports,0)-1),
            used_lot=GREATEST(0,COALESCE(used_lot,0)-$2),
            status=CASE WHEN status='busy' THEN 'online' ELSE status END,
            updated_at=NOW()
        WHERE id=$1
      `, [inst.vps_id, num(inst.lot_used)]);

      await client.query(`
        UPDATE vps_system.vps_agent_commands
        SET status='cancelled', updated_at=NOW(), finished_at=NOW(), result_message='cancelled_by_user_stop'
        WHERE (vps_id=$1 OR node_id=$1)
          AND status='pending'
          AND command_type IN ('run_mt5_bot', 'run_mt5', 'restart_mt5_bot')
          AND COALESCE(payload->>'instanceId', '') = $2
      `, [inst.vps_id, String(id)]).catch(() => {});

      const stopPayload = {
        action: 'stop_bot_trading',
        commandType: 'stop_mt5_bot',
        instanceId: id,
        accountId: inst.mt5_account_id,
        port: portNo,
        portNumber: portNo,
        portSlot: num(inst.port_used || runPayload.portSlot || portNo),
        vpsFolderPath: folderPath,
        folder_path: folderPath,
        stopTradingOnly: false,
        forceKill: true,
        closeMt5: true,
        botCode: runPayload.botCode || runPayload.eaName,
        mt5Login: runPayload.mt5Login || inst.mt5_login,
        expectedMt5Login: runPayload.mt5Login || inst.mt5_login,
        closeAllPositions: true
      };

      await client.query(`
        INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1,$1,$2,'stop_mt5_bot',$3::jsonb,'pending',NOW(),NOW())
      `, [inst.vps_id, inst.port_id || null, JSON.stringify(stopPayload)]);
    }
    await client.query('COMMIT');
    flash(
      req,
      'success',
      closeMt5 ? 'ส่งคำสั่งหยุด BOT และปิด MT5 แล้ว' : 'ส่งคำสั่งหยุดการเทรดแล้ว (MT5 ยังเปิดอยู่)'
    );
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    flash(req, 'error', e.message);
  } finally {
    client.release();
  }
  return res.redirect('/app/mt5');
});

router.post('/mt5/instance/:id/delete', async (req, res) => {
  const client = await getClient();
  try {
    const userId = req.user.id;
    const id = num(req.params.id);
    await client.query('BEGIN');
    const rows = await client.query(`SELECT * FROM vps_system.bot_instances WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, userId]);
    const inst = rows.rows[0];
    if (!inst) throw new Error('ไม่พบรายการ BOT');

    const active = ['running', 'pending', 'restarting'].includes(String(inst.status || '').toLowerCase());
    if (active && inst.vps_id) {
      await client.query(`
        UPDATE vps_system.vps_nodes
        SET used_ports=GREATEST(0,COALESCE(used_ports,0)-$2),
            used_lot=GREATEST(0,COALESCE(used_lot,0)-$3),
            status=CASE WHEN status='busy' THEN 'online' ELSE status END,
            updated_at=NOW()
        WHERE id=$1
      `, [inst.vps_id, num(inst.port_used, 1), num(inst.lot_used)]);
      await client.query(`
        INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at)
        VALUES ($1,$1,'STOP_MT5_BOT',$2::jsonb,'pending',NOW())
      `, [
        inst.vps_id,
        JSON.stringify({
          instanceId: id,
          port: inst.assigned_port_no,
          reason: 'user_delete_instance'
        })
      ]);
    }

    await client.query(`
      UPDATE vps_system.bot_instances
      SET status='deleted',
          stopped_at=COALESCE(stopped_at, NOW()),
          updated_at=NOW(),
          last_error='user_delete_instance'
      WHERE id=$1
    `, [id]);

    await client.query('COMMIT');
    flash(req, 'success', active ? 'ลบรายการ BOT และออก MT5 แล้ว' : 'ลบรายการ BOT แล้ว');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    flash(req, 'error', e.message);
  } finally {
    client.release();
  }
  return res.redirect('/app/mt5');
});

router.get('/mt5/dashboard', async (req, res) => {

  try {

    const vps = await query(`
      SELECT id, node_name, cpu_percent, ram_percent, ping_ms, used_ports, max_ports
      FROM vps_system.vps_nodes
      WHERE is_active=TRUE
      ORDER BY id ASC
    `);

    const bots = await query(`
      SELECT status, COUNT(*) as total
      FROM vps_system.bot_instances
      GROUP BY status
    `);

    res.json({
      ok: true,
      vps: vps.rows,
      bots: bots.rows
    });

  } catch (e) {
    res.json({ ok: false });
  }
});

router.post('/mt5/request-restart/:id', async (req, res) => {
  try {
    const userId = req.user.id;
    const id = num(req.params.id);

    const rows = await query(`
      SELECT * FROM vps_system.bot_instances
      WHERE id=$1 AND user_id=$2
      LIMIT 1
    `, [id, userId]);

    const inst = rows.rows[0];
    if (!inst) throw new Error('ไม่พบ BOT');

    await query(`
      INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at)
      VALUES ($1,$1,'RESTART_MT5_BOT',$2::jsonb,'pending',NOW())
    `, [
      inst.vps_id,
      JSON.stringify({
        instanceId: inst.id,
        port: inst.assigned_port_no
      })
    ]);

    await query(`
      UPDATE vps_system.bot_instances
      SET status='restarting',
          restart_count=COALESCE(restart_count,0)+1,
          updated_at=NOW()
      WHERE id=$1
    `, [id]);

    return res.redirect('/app/mt5');
  } catch (e) {
    flash(req, 'error', e.message);
    return res.redirect('/app/mt5');
  }
});

router.get('/mt5/history', async (req, res) => {
  try {
    const userId = req.user.id;
    const pageSize = 10;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * pageSize;
    const dash = await fetchHistoryInstances(userId, { limit: pageSize, offset });
    const safePage = Math.min(page, dash.pageCount || 1);

    return res.json({
      ok: true,
      instances: dash.instances,
      page: safePage,
      pageSize,
      total: dash.total,
      pageCount: dash.pageCount,
      hasPrev: safePage > 1,
      hasNext: safePage < dash.pageCount
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5/live-dashboard', async (req, res) => {
  try {
    const userId = req.user.id;
    const pageSize = 5;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * pageSize;
    const dash = await fetchLiveDashboardInstances(userId, { limit: pageSize, offset });
    const safePage = Math.min(page, dash.pageCount || 1);

    const hasConnecting = (dash.instances || []).some(
      (row) => String(row.display_status || row.status || '').toLowerCase() === 'connecting'
    );

    const metricsRefreshSec = dash.metricsRefreshSec || 90;
    const chartSec = dash.chartSnapshotSec || metricsRefreshSec;

    return res.json({
      ok: true,
      instances: dash.instances,
      page: safePage,
      pageSize,
      total: dash.total,
      pageCount: dash.pageCount,
      hasPrev: safePage > 1,
      hasNext: safePage < dash.pageCount,
      refreshSec: metricsRefreshSec,
      metricsRefreshSec,
      chartSnapshotSec: chartSec,
      chartSnapshotMinutes: chartSec / 60,
      metricsIntervalMinutes: chartSec / 60,
      hasConnecting,
      pollFastSec: hasConnecting ? 5 : metricsRefreshSec,
      connectingTypicalSec: 60,
      connectingMaxSec: 180
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

// ===== EQUITY CHART API (กำไร / ขาดทุน จาก Equity ตั้งต้น · ทุก 90 วินาที) =====
router.get('/mt5/equity-chart/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;
    const payload = await fetchEquityChartForInstance(id, userId);
    if (!payload.ok) return res.json({ ok: false });
    return res.json(payload);
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

// ===== EMA INDICATOR =====
function ema(arr, period=5) {
  if (!arr || arr.length === 0) return 0;

  let k = 2/(period+1);
  let emaVal = arr[0];

  for (let i=1;i<arr.length;i++){
    emaVal = arr[i]*k + emaVal*(1-k);
  }

  return emaVal;
}

async function aiTradingBrain(instance) {

  const equity = Number(instance.mt5_equity || 0);
  const balance = Number(instance.mt5_balance || 0);

  const profit = equity - balance;

  // ===== LOAD HISTORY =====
  const hist = await query(`
    SELECT equity
    FROM vps_system.mt5_equity_logs
    WHERE instance_id=$1
    ORDER BY id DESC
    LIMIT 30
  `, [instance.id]);

  const eq = hist.rows.map(r => Number(r.equity)).reverse();

  if (eq.length < 10) return;

  const max = Math.max(...eq);
  const min = Math.min(...eq);

  const drawdown = ((max - equity) / (max || 1)) * 100;

  // ===== TREND =====
  // ===== EMA TREND =====
const emaFast = ema(eq, 5);
const emaSlow = ema(eq, 10);

const trend = emaFast - emaSlow;

  // ===== VOLATILITY =====
  let vol = 0;
  for (let i=1;i<eq.length;i++){
    vol += Math.abs(eq[i]-eq[i-1]);
  }
  vol = vol / eq.length;

  // ================================
  // 🔴 1. CUT LOSS
  // ================================
  if (drawdown > 20 || profit < -100) {

    await query(`
      INSERT INTO vps_system.vps_agent_commands
      (vps_id,node_id,command_type,payload,status,created_at)
      VALUES ($1,$1,'STOP_MT5_BOT',$2::jsonb,'pending',NOW())
    `, [
      instance.vps_id,
      JSON.stringify({
        instanceId: instance.id,
        reason: 'AI_cut_loss'
      })
    ]);

    return;
  }

  // ================================
  // 🟡 2. REDUCE LOT (เสี่ยงสูง)
  // ================================
  if (drawdown > 10 || vol > 50) {

    await query(`
      UPDATE vps_system.bot_instances
      SET lot_used = GREATEST(lot_used * 0.7, 0.01),
          updated_at = NOW()
      WHERE id=$1
    `, [instance.id]);

    return;
  }

  // ================================
  // 🟢 3. INCREASE LOT (กำไรดี)
  // ================================
  if (trend > 10 && emaFast > emaSlow && drawdown < 5) {

    await query(`
      UPDATE vps_system.bot_instances
      SET lot_used = LEAST(lot_used * 1.2, 50),
          updated_at = NOW()
      WHERE id=$1
    `, [instance.id]);

  }

  // ================================
  // ⚡ 4. VPS PERFORMANCE AUTO MIGRATE
  // ================================
  const badVps =
    Number(instance.ping_ms || 0) > 200 ||
    Number(instance.cpu_percent || 0) > 85 ||
    Number(instance.ram_percent || 0) > 85;

  if (badVps) {
    const newVps = await findAvailableVpsPort();

    if (
      newVps &&
      Number(newVps.node_id) &&
      Number(newVps.port_number) &&
      Number(newVps.node_id) !== Number(instance.vps_id)
    ) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id,node_id,command_type,payload,status,created_at)
        VALUES ($1,$1,'stop_mt5',$2::jsonb,'pending',NOW())
      `, [
        instance.vps_id,
        JSON.stringify({
          instanceId: instance.id,
          port: instance.assigned_port_no,
          reason: 'AI_migrate_stop_old'
        })
      ]);

      const newPayload = {
        ...(instance.run_payload || {}),
        instanceId: instance.id,
        port: newVps.port_number,
        portNumber: newVps.port_number,
        folderPort: newVps.port_number,
        vpsPortNumber: newVps.port_number,
        vpsPortName: newVps.port_name,
        vpsFolderPath: newVps.folder_path,
        nodeId: newVps.node_id,
        reason: 'AI_migrate_start_new'
      };

      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id,node_id,command_type,payload,status,created_at)
        VALUES ($1,$1,'run_mt5_bot',$2::jsonb,'pending',NOW())
      `, [
        newVps.node_id,
        JSON.stringify(newPayload)
      ]);

      await query(`
        UPDATE vps_system.bot_instances
        SET vps_id=$2,
            assigned_port_no=$3,
            run_payload=$4::jsonb,
            status='restarting',
            last_error='AI_migrate_vps_performance',
            updated_at=NOW()
        WHERE id=$1
      `, [
        instance.id,
        newVps.node_id,
        newVps.port_number,
        JSON.stringify(newPayload)
      ]);
    }
  }
}

if (String(process.env.MT5_AI_BRAIN_ENABLED || 'true').toLowerCase() !== 'false') {
  setInterval(async () => {
    const rows = await query(`
      SELECT bi.*, n.ping_ms, n.cpu_percent, n.ram_percent
      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.vps_nodes n ON n.id=bi.vps_id
      WHERE bi.status IN ('running','pending')
    `);

    for (const inst of rows.rows) {
      await aiTradingBrain(inst);
    }
  }, 5000);
}

module.exports = router;
