const express = require('express');
// ===== REDIS QUEUE =====
const Redis = require('ioredis');
const redis = new Redis();

// lock key
function getUserLockKey(userId) {
  return `lock:user:${userId}`;
}

async function tryRedisLock(key, ttlSec = 15) {
  try {
    const locked = await redis.set(key, '1', 'NX', 'EX', ttlSec);
    return !!locked;
  } catch (e) {
    console.warn('[redis lock]', key, e.message || e);
    return true;
  }
}

async function releaseRedisLock(key) {
  try {
    await redis.del(key);
  } catch (_) {}
}

const { requireLogin, prefersJsonResponse } = require('../middleware/requireAuth');

function getUser(req) {
  return req.user || req.session?.user || null;
}
const { query, getClient, repairVpsAgentCommandSequences } = require('../config/database');
const {
  insertPendingAgentCommand,
  cancelAgentCommandsForAccount
} = require('../lib/vpsAgentCommandQueue');
const { cancelPendingEquitySnapshots } = require('../lib/mt5EquitySync');
const { parseMt5JournalOutcome } = require('../lib/mt5JournalVerify');
const { pickAccountForPortSlot } = require('../lib/mt5PortAccount');
const {
  PACKAGE_PORT_MAP,
  packagePortCapForGroup,
  packagePortRangeLabel,
  computePortEntitlement
} = require('../lib/mt5PortEntitlement');
const {
  stopPortsAboveEntitlement,
  pruneStaleTemporaryExtraPorts
} = require('../lib/mt5PackagePorts');
const { supersedeOtherSubscriptions } = require('../lib/subscriptionPackage');
const {
  computePresetForBot,
  isProductionBot,
  validateRunCapital,
  normalizeTradeLevel,
  tradeLevelLabel,
  presetSlugForBot,
  packageLotLimits: resolvePackageLotLimits
} = require('../lib/mt5BotPresets');
const { loadAccountPortContext, buildRunMt5BotPayload } = require('../lib/mt5AccountPort');
const { buildEaSetPayloadFields } = require('../lib/mt5EaSet');
const {
  validateEaAccountAccess,
  eaLicenseHintForDiagnostics,
  findLicensedBotForLogin
} = require('../lib/mt5EaLicense');
const { isDemoBotCode, buildDemoTradingPlan } = require('../lib/mt5AiConnectAdvisor');
const { toJsonbParam } = require('../lib/pgSanitize');
const { ensureBotInstanceRunColumns } = require('../lib/mt5RunBotResult');
const {
  fetchEquityFromVps,
  queueSyncMt5Account,
  queueAccountSnapshot,
  hasRecentMetricsSync,
  metricsFromSnapshotResult,
  applyEquityToAccount
} = require('../lib/mt5EquitySync');
const { folderPathForPortNo, vpsPortNameForNo } = require('../lib/mt5AccountPort');
const {
  ensureRunBotAgent,
  resolveLiveDashboardAgentNotice,
  ensureAgentMaintenance,
  hasRunBotMarker,
  hasAgentCapableMarker,
  REQUIRED_AGENT_VERSION,
  getAgentUpgradeState,
  messageForUpgradeState,
  pruneMetricsCommandBacklog
} = require('../lib/agentDeploy');
const { applyMt5LiveStatus, recordEquityLog } = require('../lib/mt5LiveStatus');
const { generateIntelReport } = require('../services/intelAi');

const router = express.Router();

async function cancelStaleRunBotCommands(vpsId, portId, instanceId) {
  const iid = instanceId != null && String(instanceId) !== '' ? String(instanceId) : null;
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'cancelled',
        error = COALESCE(NULLIF(error, ''), 'superseded'),
        finished_at = NOW(),
        updated_at = NOW()
    WHERE (vps_id = $1 OR node_id = $1)
      AND ($2::int IS NULL OR port_id = $2)
      AND (
        $3::text IS NULL
        OR COALESCE(payload->>'instanceId', payload->>'instance_id', '') = $3::text
      )
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing')
      AND command_type IN (
        'run_bot', 'restart_ea', 'run_mt5_bot', 'run_mt5', 'restart_mt5_bot', 'restart_mt5'
      )
  `,
    [vpsId, portId || null, iid]
  ).catch(() => {});
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
      positiveMoney(req.body.balance),
      positiveMoney(req.body.equity)
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

router.get('/mt5/agent-running-list', async (req, res) => {
  try {
    const rows = await query(`
      SELECT id AS "instanceId",
             assigned_port_no AS port
      FROM vps_system.bot_instances
      WHERE status IN ('running','pending','restarting')
        AND assigned_port_no IS NOT NULL
      ORDER BY id DESC
      LIMIT 100
    `);

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

/** Agent — อัปเดต balance/equity (รองรับ token ก่อน requireLogin) */
router.post('/mt5/account-metrics', async (req, res) => {
  try {
    const token =
      req.headers['x-agent-token'] ||
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
      '';
    if (token) {
      const nodeRes = await query(
        `SELECT id FROM vps_system.vps_nodes WHERE agent_token=$1 LIMIT 1`,
        [token]
      );
      if (!nodeRes.rows?.[0]) {
        return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });
      }
    } else if (!getUser(req)) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    const accountId = Number(req.body?.accountId || req.body?.account_id || 0);
    const userId = Number(req.body?.userId || req.body?.user_id || 0);
    const portNumber = Number(req.body?.portNumber || req.body?.port || 0);
    const balance = positiveMoney(req.body?.balance);
    const equity = positiveMoney(req.body?.equity);

    if (!accountId && !userId) {
      return res.json({ ok: false, message: 'accountId or userId required' });
    }

    const params = [];
    const where = [];
    if (accountId) {
      params.push(accountId);
      where.push(`id=$${params.length}`);
    }
    if (userId) {
      params.push(userId);
      where.push(`user_id=$${params.length}`);
    }
    if (portNumber) {
      params.push(portNumber);
      where.push(`(assigned_port_no=$${params.length} OR port_slot=$${params.length})`);
    }
    params.push(balance);
    params.push(equity);
    const balIdx = params.length - 1;
    const eqIdx = params.length;

    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET last_balance = COALESCE($${balIdx}::numeric, last_balance),
          last_equity = COALESCE($${eqIdx}::numeric, last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE ${where.join(' AND ')}
    `,
      params
    );

    return res.json({ ok: true, balance, equity });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

/** Agent callback — ต้องอยู่ก่อน requireLogin */
router.post('/mt5/live-status', async (req, res) => {
  try {
    const token =
      req.headers['x-agent-token'] ||
      String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
      '';
    if (token) {
      const nodeRes = await query(
        `SELECT id FROM vps_system.vps_nodes WHERE agent_token=$1 OR node_code=$1 LIMIT 1`,
        [token]
      );
      if (!nodeRes.rows?.[0]) {
        return res.status(401).json({ ok: false, message: 'INVALID_AGENT' });
      }
      const out = await applyMt5LiveStatus(req.body || {});
      return res.json(out);
    }
    return res.status(401).json({ ok: false, message: 'agent token required' });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

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

/** ค่าเงินที่ใช้บันทึก DB — ไม่รับ 0 (ถือว่ายังอ่านไม่ได้) */
function positiveMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
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
const {
  setAdminAllocationStatus,
  parsePortNumber,
  releaseUserPortCompletely,
  resolveSystemVpsId
} = require('../lib/adminVpsBridge');

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
      ORDER BY COALESCE(n.cpu_percent, 0) ASC, COALESCE(n.ping_ms, 0) ASC, p.port_no ASC
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
           COALESCE(to_jsonb(p)->>'name_th', to_jsonb(p)->>'name', to_jsonb(p)->>'name_en', to_jsonb(us)->>'package_name_snapshot', 'แพ็กเกจปัจจุบัน') AS package_name,
           UPPER(COALESCE(to_jsonb(p)->>'group_name', to_jsonb(p)->>'package_group', to_jsonb(p)->>'package_code', to_jsonb(us)->>'package_group_snapshot', '')) AS package_group,
           COALESCE(NULLIF(to_jsonb(p)->>'duration_days','')::int, NULLIF(to_jsonb(p)->>'days','')::int, NULLIF(to_jsonb(p)->>'package_days','')::int, 0) AS duration_days,
           COALESCE(NULLIF(to_jsonb(p)->>'lot_min','')::numeric, NULLIF(to_jsonb(p)->>'min_lot','')::numeric, NULLIF(to_jsonb(p)->>'lot_from','')::numeric, 0.01) AS lot_min,
           COALESCE(NULLIF(to_jsonb(p)->>'lot_max','')::numeric, NULLIF(to_jsonb(p)->>'max_lot','')::numeric, NULLIF(to_jsonb(p)->>'lot_to','')::numeric, 0.01) AS lot_max,
           us.status,
           us.start_at,
           us.end_at,
           CASE WHEN us.end_at IS NOT NULL AND us.end_at <= NOW() THEN TRUE ELSE FALSE END AS is_expired,
           COALESCE(us.source_channel, '') AS source_channel,
           COALESCE(to_jsonb(us)->>'source', to_jsonb(us)->>'payment_method', '') AS subscription_source,
           COALESCE(to_jsonb(us)->>'coupon_code', to_jsonb(us)->>'coupon_code_snapshot', '') AS coupon_code
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id=$1
      AND (us.end_at IS NULL OR us.end_at > NOW())
      AND LOWER(TRIM(COALESCE(us.status, ''))) NOT IN ('cancelled', 'deleted')
    ORDER BY
      CASE WHEN LOWER(TRIM(COALESCE(us.status, ''))) = 'active' THEN 0 ELSE 1 END,
      us.updated_at DESC NULLS LAST,
      us.id DESC
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

  pkg.is_expired = !pkg.subscription_id || (!!pkg.end_at && new Date(pkg.end_at).getTime() <= Date.now());

  if (pkg.subscription_id && !pkg.is_expired && String(pkg.status || '').toLowerCase() !== 'active') {
    await safeQuery(
      `UPDATE user_subscriptions SET status='active', updated_at=NOW() WHERE id=$1`,
      [pkg.subscription_id]
    ).catch(() => {});
    pkg.status = 'active';
  }

  if (pkg.subscription_id && !pkg.is_expired) {
    await supersedeOtherSubscriptions(userId, pkg.subscription_id).catch(() => {});
  }

  return pkg;
}

async function getPackagePaymentDetail(userId, subscriptionId) {
  const rows = await safeQuery(`
    SELECT id, payment_method, payment_status, package_name_snapshot,
           amount, discount_amount, final_amount, currency_code,
           coupon_id, coupon_code_snapshot, coupon_code, created_at, updated_at
    FROM payments
    WHERE user_id=$1
      AND payment_status IN ('paid','pending')
    ORDER BY CASE WHEN payment_status='paid' THEN 0 ELSE 1 END, updated_at DESC, id DESC
    LIMIT 1
  `, [userId], []);
  return rows[0] || null;
}

async function getCouponDetails(userId, subscriptionId) {
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
    ORDER BY cu.used_at DESC NULLS LAST, cu.id DESC
    LIMIT 5
  `, [userId], []);
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
await runner.query(`ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`).catch(() => {});  await runner.query(`CREATE INDEX IF NOT EXISTS idx_mt5_extra_ports_user ON vps_system.mt5_extra_ports(user_id, is_active, port_type)`).catch(() => {});
}

async function getExtraPortRows(userId, subscriptionId, packageId, packageGroup = '', subscriptionStartAt = null) {
  await ensureExtraPortsTable().catch(() => {});
  const groupUpper = String(packageGroup || '').toUpperCase().trim();
  const subId = Number(subscriptionId || 0) || null;
  const periodStart = subscriptionStartAt ? new Date(subscriptionStartAt) : null;
  const periodStartIso =
    periodStart && !Number.isNaN(periodStart.getTime()) ? periodStart.toISOString() : null;

  return await safeQuery(`
    SELECT id, qty, port_type, subscription_id, package_id, package_group, price_scoin, expires_at, is_active, created_at,
           CASE WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN TRUE ELSE FALSE END AS is_expired
    FROM vps_system.mt5_extra_ports
    WHERE user_id=$1
      AND is_active=TRUE
      AND (
        (
          LOWER(TRIM(COALESCE(port_type, ''))) = 'temporary'
          AND (expires_at IS NULL OR expires_at > NOW())
          AND $3::bigint IS NOT NULL
          AND subscription_id = $3
          AND ($4::timestamptz IS NULL OR created_at >= $4::timestamptz)
        )
        OR
        (
          LOWER(TRIM(COALESCE(port_type, ''))) = 'permanent'
          AND $2 <> ''
          AND UPPER(TRIM(COALESCE(package_group, ''))) = $2
        )
      )
    ORDER BY created_at DESC, id DESC
  `, [userId, groupUpper, subId, periodStartIso], []);
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
  const { cleanupUserOnPackageExpired } = require('../lib/mt5PackageExpire');
  await cleanupUserOnPackageExpired(userId, reason).catch(() => {});
}


async function getPortSummary(userId) {
  const pkg = await getPackage(userId);
  const packageExpired = !!pkg.is_expired || !pkg.subscription_id;

if (packageExpired) {
  await stopAndExpireMt5Accounts(userId, 'package_expired_auto_stop');
} else if (pkg.subscription_id && pkg.start_at) {
  await pruneStaleTemporaryExtraPorts(userId, pkg.subscription_id, pkg.start_at).catch(() => {});
}

  const extraPortRows = packageExpired ? [] : await getExtraPortRows(
  userId,
  pkg.subscription_id,
  pkg.package_id,
  pkg.package_group,
  pkg.start_at
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
  const paymentDetail = await getPackagePaymentDetail(userId, pkg.subscription_id);
  const couponDetails = await getCouponDetails(userId, pkg.subscription_id);

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

/** Same numbers as getPortSummary; runs package-expired cleanup when needed. */
async function getPortSummaryReadOnly(userId) {
  const { repairFailedAccountsHoldingSlots } = require('../lib/mt5LoginCommandVerify');
  await repairFailedAccountsHoldingSlots(userId).catch(() => {});

  const pkg = await getPackage(userId);
  const packageExpired = !!pkg.is_expired || !pkg.subscription_id;

  if (packageExpired) {
    await stopAndExpireMt5Accounts(userId, 'package_expired_readonly_cleanup');
  }

  if (!packageExpired && pkg.subscription_id && pkg.start_at) {
    await pruneStaleTemporaryExtraPorts(userId, pkg.subscription_id, pkg.start_at).catch(() => {});
  }

  const extraPortRows = packageExpired ? [] : await getExtraPortRows(
    userId,
    pkg.subscription_id,
    pkg.package_id,
    pkg.package_group,
    pkg.start_at
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
  const paymentDetail = await getPackagePaymentDetail(userId, pkg.subscription_id);
  const couponDetails = await getCouponDetails(userId, pkg.subscription_id);

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
    INSERT INTO vps_system.bot_catalog (bot_code, bot_name, display_name, symbol, required_ports, default_lot, max_lot, preset_json, is_demo, sort_order, is_active)
    VALUES
    ('AK-SNIPER-VIP-VER4.0','AK-SNIPER-VIP-VER4.0','AK-SNIPER VIP VER4.0','XAUUSD',1,0.01,0.05,'{"preset_slug":"ak-sniper"}'::jsonb,FALSE,10,TRUE),
    ('PA-SNIPER-VER2.0','PA-SNIPER-VER2.0','PA-SNIPER VER2.0','XAUUSD',1,0.01,0.05,'{"preset_slug":"pa-sniper"}'::jsonb,FALSE,20,TRUE),
    ('5PA-SNIPER','5PA-SNIPER','5PA-SNIPER','XAUUSD',1,0.01,0.05,'{"preset_slug":"5pa-sniper"}'::jsonb,FALSE,30,TRUE),
    ('sniper-demo','sniper-demo','sniper-demo','XAUUSD',1,0.01,0.5,'{"preset_slug":"sniper-demo"}'::jsonb,FALSE,35,TRUE),
    ('SNIPER-DEMO','SNIPER-DEMO','SNIPER-DEMO ทดสอบบอท','XAUUSD',1,0.01,50,'{"preset_slug":"sniper-demo"}'::jsonb,TRUE,40,TRUE)
    ON CONFLICT (bot_code) DO UPDATE SET
      bot_name=EXCLUDED.bot_name,
      display_name=EXCLUDED.display_name,
      symbol=EXCLUDED.symbol,
      required_ports=EXCLUDED.required_ports,
      default_lot=EXCLUDED.default_lot,
      max_lot=EXCLUDED.max_lot,
      preset_json=EXCLUDED.preset_json,
      is_demo=EXCLUDED.is_demo,
      sort_order=EXCLUDED.sort_order,
      is_active=TRUE,
      updated_at=NOW()
  `).catch(() => {});
  await query(`
    UPDATE vps_system.bot_catalog
    SET is_active=FALSE, updated_at=NOW()
    WHERE UPPER(bot_code) IN ('BOT_TEST', 'BOT_Test')
  `).catch(() => {});
}

const { PRODUCTION_BOT_CODE_LIST } = require('../lib/mt5BotPresets');

const PRODUCTION_BOT_CODES_SQL = `(${PRODUCTION_BOT_CODE_LIST.map((c) => `'${String(c).replace(/'/g, "''").toUpperCase()}'`).join(',')})`;

function accountsForRunForm(portSlotAccounts, accounts) {
  const byId = new Map();
  for (const a of [...(portSlotAccounts || []), ...(accounts || [])]) {
    if (!a?.id) continue;
    if (String(a.status || '').toLowerCase() !== 'connected') continue;
    byId.set(Number(a.id), a);
  }
  return [...byId.values()].sort(
    (a, b) => Number(a.port_slot || 0) - Number(b.port_slot || 0) || Number(a.id) - Number(b.id)
  );
}

const BOT_ACTIVE_STATUSES = ['running', 'pending', 'starting', 'restarting'];

function resolveActivePortContext(portSlotAccounts, accounts, instances, preferredSlot) {
  const list = portSlotAccounts || accounts || [];
  const pref = Number(preferredSlot) || 0;
  let slot = pref;
  let account = pref > 0 ? pickAccountForPortSlot(list, pref) : null;

  if (!pref) {
    const connected = list.filter((a) => String(a.status || '').toLowerCase() === 'connected');
    account = connected.sort(
      (a, b) => Number(a.port_slot || 0) - Number(b.port_slot || 0) || Number(a.id) - Number(b.id)
    )[0] || null;
    slot = account ? Number(account.port_slot || 0) : 0;
  }

  const isActiveBot = (i) =>
    BOT_ACTIVE_STATUSES.includes(String(i?.status || '').toLowerCase());

  let instance =
    (instances || []).find(
      (i) => Number(i.mt5_account_id) === Number(account?.id) && isActiveBot(i)
    ) || null;

  if (!instance && slot > 0) {
    instance =
      (instances || []).find(
        (i) => Number(i.assigned_port_no) === slot && isActiveBot(i)
      ) || null;
  }

  return {
    portSlot: slot,
    account,
    instance,
    botRunning: !!instance,
    loginConnected: !!account && String(account.status || '').toLowerCase() === 'connected'
  };
}

async function buildBotControlPayload(userId, preferredSlot, instancesOverride) {
  const portSlotAccounts = await safeQuery(
    `
    SELECT a.*, (
      SELECT COUNT(*)::int FROM vps_system.bot_instances bi
      WHERE bi.mt5_account_id=a.id AND bi.status IN ('running','pending','starting','restarting')
    ) AS running_bots
    FROM vps_system.mt5_accounts a
    WHERE a.user_id=$1
      AND a.port_slot IS NOT NULL
      AND LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('deleted', 'expired')
    ORDER BY a.port_slot ASC, a.id ASC
  `,
    [userId]
  );

  let instances = instancesOverride;
  if (!instances) {
    instances = await safeQuery(
      `
      SELECT bi.*, bc.display_name, bc.bot_name, bc.bot_code
      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.bot_catalog bc ON bc.id=bi.bot_id
      WHERE bi.user_id=$1
      ORDER BY bi.id DESC
      LIMIT 30
    `,
      [userId]
    );
  }

  const ctx = resolveActivePortContext(portSlotAccounts, [], instances, preferredSlot);
  const bots = await loadProductionBots();

  return {
    portSlot: ctx.portSlot,
    account: ctx.account
      ? {
          id: Number(ctx.account.id),
          port_slot: Number(ctx.account.port_slot),
          mt5_login: ctx.account.mt5_login,
          last_balance: ctx.account.last_balance,
          last_equity: ctx.account.last_equity,
          status: ctx.account.status
        }
      : null,
    instance: ctx.instance
      ? {
          id: Number(ctx.instance.id),
          status: ctx.instance.status,
          bot_code: ctx.instance.bot_code,
          bot_name: ctx.instance.display_name || ctx.instance.bot_name,
          lot_used: ctx.instance.lot_used,
          assigned_port_no: ctx.instance.assigned_port_no,
          trade_level: ctx.instance.trade_level
        }
      : null,
    botRunning: ctx.botRunning,
    loginConnected: ctx.loginConnected,
    bots: (bots || []).map((b) => ({
      id: Number(b.id),
      bot_code: b.bot_code,
      label: b.display_name || b.bot_name || `BOT ${b.id}`
    }))
  };
}

async function loadProductionBots() {
  await ensureBotCatalog();
  return safeQuery(
    `SELECT * FROM vps_system.bot_catalog
     WHERE is_active=TRUE AND is_demo=FALSE
       AND UPPER(bot_code) IN ${PRODUCTION_BOT_CODES_SQL}
     ORDER BY
       CASE WHEN LOWER(bot_code) LIKE '%demo%' THEN 0 ELSE 1 END,
       sort_order ASC,
       id ASC`,
    []
  );
}

function packageLotLimits(summary) {
  return resolvePackageLotLimits(summary);
}

async function nearestPreset(client, capital) {
  const rows = await client.query(`
    SELECT * FROM vps_system.lot_presets
    ORDER BY ABS(capital_recommend - $1::numeric) ASC, capital_recommend ASC
    LIMIT 1
  `, [num(capital)]);
  return rows.rows[0] || null;
}

function settingFromPreset(preset, level) {
  if (!preset) return { trade_level: level || 'safe', t_start: 0, t_stop: 0 };
  const l = clean(level) || 'safe';
  if (l === 'fast') return { trade_level: 'fast', t_start: num(preset.fast_t_start || preset.medium_t_start || preset.t_start), t_stop: num(preset.fast_t_stop || preset.medium_t_stop || preset.t_stop) };
  if (l === 'medium') return { trade_level: 'medium', t_start: num(preset.medium_t_start || preset.t_start), t_stop: num(preset.medium_t_stop || preset.t_stop) };
  return { trade_level: 'safe', t_start: num(preset.t_start), t_stop: num(preset.t_stop) };
}

async function findFreePortNo(client, nodeId, maxPorts) {
  const used = await client.query(`
    SELECT assigned_port_no
    FROM vps_system.bot_instances
    WHERE vps_id=$1 AND status IN ('running','pending') AND assigned_port_no IS NOT NULL
  `, [nodeId]);
  const set = new Set(used.rows.map(r => num(r.assigned_port_no)));
  for (let i = 1; i <= Math.max(1, num(maxPorts, 20)); i += 1) {
    if (!set.has(i)) return i;
  }
  return null;
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

      await insertPendingAgentCommand({
        vpsId: p.vps_id,
        portId: p.port_id,
        commandType: 'login_mt5',
        payload: JSON.parse(payloadJson)
      }).catch(() => {});

      requeued += 1;
    }

    return res.json({ ok: true, checked: (stuck || []).length, requeued, failed });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

function isBotInstanceActive(status) {
  return BOT_ACTIVE_STATUSES.includes(String(status || '').toLowerCase());
}

function buildPortCardState(acc, botRunning) {
  const accStatus = acc ? String(acc.status || '').toLowerCase() : '';
  const canUse = !!(acc && accStatus === 'connected');
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

  return {
    accStatus,
    canUse,
    statusLabel,
    cssClass,
    slotBusy,
    canPick: true,
    botRunning: !!botRunning,
    canDelete: !!acc && !botRunning
  };
}

router.get('/mt5/bot-control-state', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const portSlot = num(req.query.port_slot || req.query.portSlot);
    const payload = await buildBotControlPayload(userId, portSlot);
    return res.json({ ok: true, ...payload });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

/** ตรวจสุขภาพหน้า /app/mt5 — Agent, คำสั่งค้าง, Equity sync */
router.get('/mt5/diagnostics', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const portSlot = num(req.query.port_slot || req.query.portSlot);
    const ctx = await buildBotControlPayload(userId, portSlot);

    let vpsAgent = null;
    let upgradeState = 'unknown';
    let upgradeMessage = '';
    let pendingCommands = [];
    let lastSnapshotCmd = null;

    if (ctx.account?.id) {
      const accCtx = await loadAccountPortContext(ctx.account.id, userId).catch(() => null);
      if (accCtx?.vpsId) {
        const nodeRow = await query(
          `SELECT id, node_name, agent_version, status, last_heartbeat
           FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
          [accCtx.vpsId]
        ).catch(() => ({ rows: [] }));
        const node = nodeRow.rows?.[0];
        vpsAgent = {
          vpsId: accCtx.vpsId,
          nodeName: node?.node_name || null,
          agentVersion: node?.agent_version || null,
          nodeStatus: node?.status || null,
          lastHeartbeat: node?.last_heartbeat || null,
          requiredVersion: REQUIRED_AGENT_VERSION,
          capable: hasAgentCapableMarker(node?.agent_version),
          runBotReady: hasRunBotMarker(node?.agent_version)
        };
        const maint = await ensureAgentMaintenance(accCtx.vpsId).catch(() => ({
          state: 'unknown',
          maintenancePending: false
        }));
        upgradeState = maint.state || (await getAgentUpgradeState(accCtx.vpsId).catch(() => 'unknown'));
        upgradeMessage = maint.notice || messageForUpgradeState(upgradeState);
        if (maint.maintenancePending || maint.state === 'stuck' || maint.recovering) {
          if (upgradeState !== 'ready') {
            upgradeState = 'deploying';
            upgradeMessage = '';
          }
        }

        const pend = await query(
          `
          SELECT id, command_type, status, created_at, error
          FROM vps_system.vps_agent_commands
          WHERE vps_id=$1
            AND LOWER(COALESCE(status,'')) IN ('pending','queued','picked','processing')
          ORDER BY id DESC
          LIMIT 8
        `,
          [accCtx.vpsId]
        ).catch(() => ({ rows: [] }));
        pendingCommands = pend.rows || [];

        if (ctx.instance?.id) {
          const snap = await query(
            `
            SELECT id, command_type, status, finished_at, error
            FROM vps_system.vps_agent_commands
            WHERE vps_id=$1
              AND command_type IN ('account_snapshot','sync_mt5_account','read_account_metrics','restart_ea','run_mt5_bot')
              AND COALESCE(payload->>'instanceId','')=$2
            ORDER BY id DESC
            LIMIT 1
          `,
            [accCtx.vpsId, String(ctx.instance.id)]
          ).catch(() => ({ rows: [] }));
          lastSnapshotCmd = snap.rows?.[0] || null;
        }
      }
    }

    let redisOk = true;
    try {
      await redis.ping();
    } catch (_) {
      redisOk = false;
    }

    const blockers = [];
    const maintPending =
      upgradeState === 'deploying' &&
      pendingCommands.some((c) =>
        ['deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent'].includes(
          String(c.command_type || '').toLowerCase()
        )
      );

    if (!redisOk) blockers.push('Redis ไม่พร้อม — อาจกระทบปุ่มเปิด BOT (ล็อกชั่วคราว)');
    if (ctx.account && String(ctx.account.status).toLowerCase() !== 'connected') {
      blockers.push('PORT ยังไม่ connected — ต้อง Login MT5 ขั้นตอน 2 ก่อน');
    }
    if ((upgradeState === 'stuck' || upgradeState === 'needs_restart') && ctx.botRunning) {
      blockers.push('ระบบกำลังอัปเดต Agent บน VPS อัตโนมัติ — รอประมาณ 1–3 นาที');
    } else if (maintPending && ctx.botRunning) {
      blockers.push('ระบบกำลังอัปเดต Agent บน VPS อัตโนมัติ — รอประมาณ 1–2 นาที');
    } else if (vpsAgent && !vpsAgent.runBotReady && ctx.botRunning && upgradeState === 'legacy') {
      blockers.push(
        `Agent VPS ยังเป็นเวอร์ชันเก่า (${vpsAgent.agentVersion || 'ไม่ทราบ'}) — ระบบกำลังอัปเดตให้อัตโนมัติ`
      );
    }
    if (ctx.botRunning && String(ctx.instance?.ea_status || '').toLowerCase() === 'attach_required') {
      blockers.push(
        'แนบ EA บนกราฟ XAUUSD + เปิด Algo Trading (สีเขียว) ใน MT5 — ถ้า Algo แดง BOT จะไม่เทรด'
      );
    }
    const licenseHint = eaLicenseHintForDiagnostics(
      ctx.instance?.bot_code,
      ctx.account?.mt5_login,
      presetSlugForBot({ bot_code: ctx.instance?.bot_code }) || 'ak-sniper'
    );
    if (licenseHint) {
      blockers.push(licenseHint);
    }

    return res.json({
      ok: true,
      requiredAgentVersion: REQUIRED_AGENT_VERSION,
      redisOk,
      upgradeState,
      upgradeMessage,
      blockers,
      port: ctx,
      vpsAgent,
      pendingCommands,
      lastSnapshotCmd
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5/ports-state', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      reconcileConnectedAccountLive,
      tryRecoverReadyAccount
    } = require('../lib/mt5LoginCommandVerify');
    const summary = await getPortSummaryReadOnly(userId);
    let accounts = await safeQuery(
      `
      SELECT a.id, a.port_slot, a.mt5_login, a.status, a.last_balance, a.last_equity, (
        SELECT COUNT(*)::int FROM vps_system.bot_instances bi
        WHERE bi.mt5_account_id=a.id
          AND bi.user_id=$1
          AND bi.status IN ('running','pending','starting','restarting')
      ) AS running_bots
      FROM vps_system.mt5_accounts a
      WHERE a.user_id=$1
        AND a.port_slot IS NOT NULL
        AND LOWER(TRIM(COALESCE(a.status,''))) NOT IN ('deleted', 'expired')
      ORDER BY a.port_slot ASC NULLS LAST, a.id ASC
    `,
      [userId]
    );

    for (const acc of accounts || []) {
      const stAcc = String(acc?.status || '').toLowerCase();
      if (stAcc === 'connected') {
        const row = await reconcileConnectedAccountLive(acc, { allowDemote: false }).catch(() => null);
        if (row?.changed && row.account) {
          acc.status = row.account.status;
          acc.last_error = row.account.last_error;
          acc.last_login_message = row.account.last_login_message;
        }
        continue;
      }
      if (['ready', 'failed'].includes(stAcc)) {
        const rec = await tryRecoverReadyAccount(acc).catch(() => null);
        if (rec?.recovered && rec.account) {
          acc.status = rec.account.status;
          acc.last_error = rec.account.last_error;
          acc.last_login_message = rec.account.last_login_message;
        }
      }
    }

    const healthByPort = new Map();
    const vpsIds = [...new Set((accounts || []).map((a) => Number(a.vps_id || 0)).filter(Boolean))];
    if (vpsIds.length) {
      const hRows = await safeQuery(
        `
        SELECT node_id, port_number, running, mt5_login
        FROM vps_system.vps_port_health
        WHERE node_id = ANY($1::bigint[])
          AND updated_at > NOW() - INTERVAL '10 minutes'
        `,
        [vpsIds]
      );
      for (const row of hRows || []) {
        healthByPort.set(`${row.node_id}:${row.port_number}`, row);
      }
    }

    const ports = [];
    for (let slot = 1; slot <= summary.totalPorts; slot++) {
      const acc = pickAccountForPortSlot(accounts, slot);
      const botRunning = acc ? Number(acc.running_bots || 0) > 0 : false;
      const meta = buildPortCardState(acc, botRunning);
      const equity = acc?.last_equity ?? acc?.last_balance;
      const equityPart =
        equity != null && equity !== '' ? ` / Equity: ${equity}` : '';
      const vpsId = acc ? Number(acc.vps_id || 0) : 0;
      const health =
        vpsId > 0
          ? healthByPort.get(`${vpsId}:${slot}`) ||
            healthByPort.get(`${vpsId}:${100 + slot}`)
          : null;
      const mt5Running = health ? !!health.running : false;
      const mt5NeedReopen =
        !!acc && String(acc.status || '').toLowerCase() === 'connected' && !mt5Running;
      ports.push({
        slot,
        accountId: acc ? Number(acc.id) : null,
        mt5_login: acc?.mt5_login || null,
        status: acc?.status || null,
        canUse: meta.canUse,
        cssClass: meta.cssClass,
        canPick: meta.canPick,
        botRunning: meta.botRunning,
        canDelete: meta.canDelete,
        statusLabel: meta.statusLabel,
        mt5Running,
        mt5NeedReopen,
        sublabel: acc
          ? `Login: ${acc.mt5_login}${equityPart}`
          : 'ยังไม่เชื่อมต่อ'
      });
    }

    const firstEmptySlot =
      ports.find((p) => !p.accountId && p.cssClass !== 'connected' && p.cssClass !== 'checking')
        ?.slot || null;

    const connectedAccounts = accountsForRunForm(accounts, []).map((a) => ({
      id: Number(a.id),
      port_slot: Number(a.port_slot),
      mt5_login: a.mt5_login,
      last_balance: a.last_balance,
      last_equity: a.last_equity
    }));

    const bots = await loadProductionBots();

    const { enrichPackagePortsForUi } = require('../lib/mt5VpsFolderPorts');
    const enriched = await enrichPackagePortsForUi(ports, accounts).catch(() => ({
      ports,
      vpsNodes: [],
      vpsOnlineCount: 0,
      vpsTotalCount: 0,
      folderPorts: []
    }));

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
      ports: enriched.ports,
      vpsNodes: enriched.vpsNodes,
      vpsOnlineCount: enriched.vpsOnlineCount,
      vpsTotalCount: enriched.vpsTotalCount,
      folderPorts: enriched.folderPorts,
      firstEmptySlot:
        enriched.ports.find(
          (p) => p.canPick && !p.accountId && p.cssClass !== 'connected' && p.cssClass !== 'checking'
        )?.slot || firstEmptySlot,
      connectedAccounts,
      bots: (bots || []).map((b) => ({
        id: Number(b.id),
        bot_code: b.bot_code,
        label: b.display_name || b.bot_name || `BOT ${b.id}`
      }))
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5', async (req, res) => {
  const userId = req.user.id;

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='deleted', updated_at=NOW()
    WHERE user_id=$1
      AND LOWER(TRIM(COALESCE(status,''))) = 'failed'
      AND updated_at < NOW() - INTERVAL '5 minutes'
  `, [userId]).catch(() => {});

  await query(
    `
    UPDATE vps_system.bot_instances bi
    SET status='stopped', ea_status='stopped', stopped_at=NOW(), updated_at=NOW()
    FROM vps_system.mt5_accounts ma
    WHERE bi.mt5_account_id = ma.id
      AND bi.user_id = $1
      AND ma.user_id = $1
      AND bi.status IN ('running','pending','starting','restarting')
      AND LOWER(TRIM(COALESCE(ma.status, ''))) IN ('deleted', 'expired')
  `,
    [userId]
  ).catch(() => {});

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

  const {
    reconcileConnectedAccountLive,
    tryRecoverReadyAccount
  } = require('../lib/mt5LoginCommandVerify');
  for (const acc of accounts || []) {
    const stAcc = String(acc?.status || '').toLowerCase();
    if (stAcc === 'connected') {
      const row = await reconcileConnectedAccountLive(acc, { allowDemote: false }).catch(() => null);
      if (row?.changed && row.account) {
        acc.status = row.account.status;
        acc.last_error = row.account.last_error;
        acc.last_login_message = row.account.last_login_message;
      }
      continue;
    }
    if (['ready', 'failed'].includes(stAcc)) {
      const rec = await tryRecoverReadyAccount(acc).catch(() => null);
      if (rec?.recovered && rec.account) {
        acc.status = rec.account.status;
        acc.last_error = rec.account.last_error;
        acc.last_login_message = rec.account.last_login_message;
      }
    }
  }

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

  for (const acc of portSlotAccounts || []) {
    const stAcc = String(acc?.status || '').toLowerCase();
    if (stAcc === 'connected') {
      const row = await reconcileConnectedAccountLive(acc, { allowDemote: false }).catch(() => null);
      if (row?.changed && row.account) {
        acc.status = row.account.status;
        acc.last_error = row.account.last_error;
        acc.last_login_message = row.account.last_login_message;
      }
      continue;
    }
    if (['ready', 'failed'].includes(stAcc)) {
      const rec = await tryRecoverReadyAccount(acc).catch(() => null);
      if (rec?.recovered && rec.account) {
        acc.status = rec.account.status;
        acc.last_error = rec.account.last_error;
        acc.last_login_message = rec.account.last_login_message;
      }
    }
  }

  const pendingConnectAccount = (accounts || []).find((row) =>
    ['checking', 'connecting', 'starting'].includes(String(row.status || '').toLowerCase())
  );

  const bots = await loadProductionBots();
  const vpsProbe = await findAvailableVpsPort();

  const instances = await safeQuery(`
    SELECT bi.*, bc.display_name, bc.bot_name, bc.bot_code, n.node_name, n.node_code,
           a.last_equity AS account_equity, a.last_balance AS account_balance
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.bot_catalog bc ON bc.id=bi.bot_id
    LEFT JOIN vps_system.vps_nodes n ON n.id=bi.vps_id
    LEFT JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
    WHERE bi.user_id=$1
      AND LOWER(COALESCE(bi.status, '')) NOT IN ('removed', 'deleted')
    ORDER BY COALESCE(bi.started_at, bi.created_at) DESC NULLS LAST, bi.id DESC
    LIMIT 50
  `, [userId]);

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
  const subChannel = String(summary.pkg.source_channel || summary.pkg.subscription_source || '').toLowerCase();
  const isCouponFreePackage =
    subChannel.includes('free_coupon') &&
    !!latestCoupon &&
    couponDiscountPercent <= 0 &&
    couponDiscountAmount <= 0;

  const pkgGroupLabel = String(summary.pkg.package_group || '').toUpperCase();
  const pkgName = String(summary.pkg.package_name || '').trim();

  let packageTypeText = 'ชำระเงินซื้อแพ็กเกจ';
  if (isCouponFreePackage) {
    packageTypeText = 'ใช้คูปอง ฟรี';
  } else if (latestCoupon && couponDiscountPercent > 0) {
    packageTypeText = `ใช้คูปอง ส่วนลด ${couponDiscountPercent}%`;
  } else if (latestCoupon && couponDiscountAmount > 0) {
    packageTypeText = `ใช้คูปอง ส่วนลด ${couponDiscountAmount} บาท`;
  }

  const displayPackageName = isCouponFreePackage
    ? (latestCoupon.free_package_group || latestCoupon.coupon_name || pkgName || 'แพ็กเกจคูปองฟรี')
    : (pkgName || (pkgGroupLabel ? `แพ็กเกจ ${pkgGroupLabel}` : 'แพ็กเกจปัจจุบัน'));
  const displayPackageDays = isCouponFreePackage && couponFreeDays > 0
    ? couponFreeDays
    : num(summary.pkg.duration_days || summary.pkg.days || summary.pkg.package_days, 0);
  const displayPackageDaysText = displayPackageDays > 0 ? `${displayPackageDays} วัน` : '-';

  function mt5EquitySuffix(acc) {
    if (!acc) return '';
    const e = positiveMoney(acc.last_equity);
    const b = positiveMoney(acc.last_balance);
    const v = e || b;
    if (!v) return '';
    return ` / Equity: ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function mt5EquityData(acc) {
    if (!acc) return { balance: '', equity: '' };
    const e = positiveMoney(acc.last_equity);
    const b = positiveMoney(acc.last_balance);
    return {
      balance: b ? String(b) : '',
      equity: e ? String(e) : ''
    };
  }

  const runAccounts = accountsForRunForm(portSlotAccounts, accounts);
  const preferredPortSlot = num(req.query.port_slot || req.query.portSlot);
  const botControl = resolveActivePortContext(
    portSlotAccounts,
    accounts,
    instances,
    preferredPortSlot
  );

  for (const acc of runAccounts) {
    if (positiveMoney(acc.last_equity) && positiveMoney(acc.last_balance)) continue;
    try {
      const ctx = await loadAccountPortContext(Number(acc.id), userId);
      if (!ctx?.vpsId) continue;
      fetchEquityFromVps(ctx, Number(acc.id), userId, {
        waitMs: 0,
        skipJournal: true,
        light: true,
        purpose: 'equity_page_load'
      }).catch(() => {});
    } catch (_) {}
  }

  const lotPolicy = packageLotLimits(summary);

  let preferredBotId = null;
  if (botControl.account?.mt5_login) {
    const licensed = findLicensedBotForLogin(botControl.account.mt5_login, bots);
    if (licensed) preferredBotId = Number(licensed.id);
  }

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
    runAccounts,
    botControl,
    activePortSlot: botControl.portSlot,
    activeAccount: botControl.account,
    activeBotInstance: botControl.instance,
    portSlotAccounts,
    pickAccountForPortSlot,
    pendingConnectAccountId: pendingConnectAccount ? pendingConnectAccount.id : null,
    bots,
    preferredBotId,
    instances,
    packageExpireText: summary.packageExpired ? 'แพ็คเกจหมดอายุ' : fmtDate(summary.pkg.end_at),
    fmtDateView: fmtDate,
    packageLotMin: lotPolicy.lotMin,
    packageLotMax: lotPolicy.lotMax,
    packageDefaultLot: lotPolicy.defaultLot,
    packageGroup: lotPolicy.packageGroup,
    vpsProbe,
    vpsProbeText: vpsProbeText(vpsProbe),
    mt5EquitySuffix,
    mt5EquityData,
    tradeLevelLabel,
    preferredTradeLevel: botControl.instance
      ? normalizeTradeLevel(botControl.instance.trade_level)
      : ''
  });
});

router.post('/mt5/connect', async (req, res) => {
  let lockKey = null;
  let reservedPort = null;
  let pendingAccountId = null;

  try {
    const userId = req.user.id;

console.log('[MT5 CONNECT START]', {
  userId,
  body: req.body
});

    lockKey = getUserLockKey(userId);
    let locked = false;
    try {
      locked = await redis.set(lockKey, '1', 'NX', 'EX', 30);
    } catch (redisErr) {
      console.warn('[MT5 CONNECT] Redis lock unavailable:', redisErr.message || redisErr);
      locked = true;
    }
    if (!locked) {
      throw new Error('⏳ ระบบกำลังเชื่อมต่ออยู่ กรุณารอสักครู่...');
    }

    const summary = await getPortSummary(userId);
    const mt5Login = clean(req.body.mt5_login);
    const mt5Password = clean(req.body.mt5_password);

    if (summary.packageExpired || summary.totalPorts <= 0) {
      throw new Error('แพ็คเกจหมดอายุ กรุณาต่ออายุแพ็กเกจก่อนเชื่อมต่อ MT5');
    }

    if (!mt5Login) throw new Error('กรุณากรอกเลข Login MT5');
    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');

    await expireStaleConnectingForLogin(userId, mt5Login, FIXED_SERVER);

    const { findMt5LoginInUse, mt5LoginInUseMessage } = require('../lib/mt5LoginDuplicate');
    const dupLogin = await findMt5LoginInUse(mt5Login, FIXED_SERVER, userId);
    if (dupLogin) {
      throw new Error(mt5LoginInUseMessage(dupLogin));
    }

    const usedSlots = await safeQuery(`
      SELECT port_slot
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,''))) IN ('connecting','checking','connected','ready')
    `, [userId]);

    const usedSlotSet = new Set((usedSlots || []).map(r => num(r.port_slot)));
    const usedPorts = (usedSlots || []).length;
    const maxPorts = Math.max(
      1,
      num(
        summary.packageMaxPorts,
        num(summary.pkg && summary.pkg.max_ports, num(summary.totalPorts, 1))
      )
    );
    let portSlot = 0;

    for (let i = 1; i <= summary.totalPorts; i++) {
      if (!usedSlotSet.has(i)) {
        portSlot = i;
        break;
      }
    }

    if (!portSlot) {
      throw new Error(`PORT ตามแพ็กเกจเต็มแล้ว (${usedPorts}/${maxPorts})`);
    }

    console.log('[STEP] BEFORE RESERVE');

    const reserve = await reserveMt5Port(userId);

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
        AND command_type IN ('connect_mt5','login_mt5','run_mt5_bot','run_mt5')
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
        updated_at
      )
	VALUES
	($1,$2,$3,$4,$5,$6,'MH Markets',$7,$8,'connecting',$9,NOW())
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
	  last_login_message='กำลังเปิด MT5 และตรวจสอบ Login (ประมาณ 15–45 วินาที)',
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
      allocPortNo
    ]);

    const accountId = accRes.rows[0].id;
    pendingAccountId = accountId;

    console.log('[STEP] BEFORE INSERT COMMAND');

    if (reservedPort.admin_node_id && allocPortNo) {
      await setAdminAllocationStatus(reservedPort.admin_node_id, allocPortNo, 'locked', reservedPort.allocation_id);
    }

    const loginPayload = buildMt5LoginPayload({
      accountId,
      userId,
      reservedPort,
      portSlot,
      mt5Login,
      mt5Password,
      serverName: FIXED_SERVER
    });
    const payloadJson = JSON.stringify(loginPayload);

    let cmdId = 0;
    try {
      const queued = await insertPendingAgentCommand({
        vpsId: reservedPort.vps_id,
        portId: reservedPort.port_id,
        commandType: 'login_mt5',
        payload: loginPayload
      });
      cmdId = queued.id;
    } catch (insErr) {
      const isSeqDup =
        insErr &&
        insErr.code === '23505' &&
        String(insErr.message || '').includes('vps_agent_commands_pkey');
      if (isSeqDup) {
        console.warn('[MT5 CONNECT] Repair command id sequence after duplicate pkey, retry insert');
        await repairVpsAgentCommandSequences();
        const queued = await insertPendingAgentCommand({
          vpsId: reservedPort.vps_id,
          portId: reservedPort.port_id,
          commandType: 'login_mt5',
          payload: loginPayload
        });
        cmdId = queued.id;
      } else {
        throw insErr;
      }
    }

console.log('[MT5 CONNECT COMMAND INSERTED]', {
  commandId: cmdId,
  accountId,
  reservedPort
});

    const pickLabel = reservedPort.node_name
      ? `${reservedPort.node_name} / ${reservedPort.port_name || 'PORT ' + allocPortNo}`
      : `PORT ${portSlot}`;

    return res.json({
      ok: true,
      status: 'queued',
      message: `ส่งคำสั่งเปิด MT5 แล้ว — ${pickLabel} (${FIXED_SERVER}) กำลังล็อกอิน...`,
      accountId,
      commandId: cmdId || null,
      vpsName: reservedPort.node_name || '',
      folderPath: reservedPort.folder_path || '',
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
    const running = await query(
      `SELECT id FROM vps_system.bot_instances WHERE mt5_account_id=$1 AND user_id=$2 AND status IN ('running','pending','starting','restarting') LIMIT 1`,
      [id, userId]
    );
    if (running.rows[0]) throw new Error('PORT นี้กำลังรัน BOT อยู่ กรุณาหยุด BOT ในขั้นตอน 3 ก่อนแก้ไข');
    const updated = await query("UPDATE vps_system.mt5_accounts SET mt5_login=$3, mt5_password=$4, broker='MH Markets', server_name=$5, account_name=$6, port_slot=$7, status='ready', updated_at=NOW() WHERE id=$1 AND user_id=$2 AND COALESCE(status,'ready') <> 'deleted' RETURNING id", [id, userId, mt5Login, mt5Password, FIXED_SERVER, 'PORT ' + portSlot, portSlot]);
    if (!updated.rows[0]) throw new Error('ไม่พบ PORT ของคุณ หรือถูกลบไปแล้ว');
    flash(req, 'success', 'แก้ไข PORT ' + portSlot + ' สำเร็จ');
  } catch (e) {
    flash(req, 'error', e.message);
  }
  return res.redirect('/app/mt5');
});

router.post('/mt5/account/:id/cancel', async (req, res) => {
  try {
    const userId = req.user.id;
    const id = num(req.params.id);

    if (!id) throw new Error('ไม่พบ PORT ที่ต้องการยกเลิก');

    const running = await query(
      `SELECT id FROM vps_system.bot_instances WHERE mt5_account_id=$1 AND user_id=$2 AND status IN ('running','pending','starting','restarting') LIMIT 1`,
      [id, userId]
    );

    if (running.rows[0]) {
      throw new Error('PORT นี้กำลังรัน BOT อยู่ กรุณาหยุด BOT ในขั้นตอน 3 ก่อนยกเลิก');
    }

    // STEP 1: ดึงค่า PORT/VPS เดิมก่อนล้างค่า
    const old = await query(`
      SELECT port_slot, vps_id, assigned_port_no, windows_port_no
      FROM vps_system.mt5_accounts
      WHERE id=$1
        AND user_id=$2
        AND LOWER(TRIM(COALESCE(status,'ready'))) <> 'deleted'
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

    // STEP 2: ส่งคำสั่งให้ Agent ปิด terminal64 ก่อน
    if (stopNodeId && stopPortNo) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, command_type, payload, status, created_at)
        VALUES ($1, $1, 'stop_mt5', $2::jsonb, 'pending', NOW())
      `, [
        stopNodeId,
        JSON.stringify({
          port: stopPortNo,
          portSlot: oldPort.port_slot,
          assignedPortNo: oldPort.assigned_port_no,
          windowsPortNo: oldPort.windows_port_no,
          reason: 'user_cancel_port_before_clear'
        })
      ]);
    }

    // STEP 3: ค่อยล้างค่าใน DB
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='cancelled',
          assigned_port_no=NULL,
          windows_port_no=NULL,
          vps_id=NULL,
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

    const running = await query(
      `SELECT id FROM vps_system.bot_instances WHERE mt5_account_id=$1 AND user_id=$2 AND status IN ('running','pending','starting','restarting') LIMIT 1`,
      [id, userId]
    );

    if (running.rows[0]) {
      throw new Error('PORT นี้กำลังรัน BOT อยู่ กรุณากด 「หยุด BOT」 ในขั้นตอน 3 ก่อนลบ');
    }

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

    await query(
      `
      UPDATE vps_system.bot_instances
      SET status='stopped', ea_status='stopped', stopped_at=NOW(), updated_at=NOW()
      WHERE mt5_account_id=$1
        AND user_id=$2
        AND status IN ('running','pending','starting','restarting')
    `,
      [id, userId]
    ).catch(() => {});

    await cancelAgentCommandsForAccount(id, stopNodeId).catch(() => 0);
    if (stopNodeId) {
      await cancelPendingEquitySnapshots(stopNodeId, { accountId: id }).catch(() => 0);
    }

    // STEP 2: ส่งคำสั่งให้ Agent ปิด terminal64 ก่อน + release pool
    if (stopNodeId && stopPortNo) {
      await insertPendingAgentCommand({
        vpsId: stopNodeId,
        portId: oldPort.port_id || null,
        commandType: 'stop_mt5',
        payload: {
          port: stopPortNo,
          portSlot: oldPort.port_slot,
          assignedPortNo: oldPort.assigned_port_no,
          windowsPortNo: oldPort.windows_port_no,
          folder_path: folderPath,
          vpsFolderPath: folderPath,
          reason: 'user_delete_port'
        }
      }).catch((e) => console.error('[DELETE] cmd insert error:', e.message || e));
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
    }

    // STEP 3: ค่อยล้างค่าใน DB (ปล่อย port_slot ให้ว่างบนแพ็กเกจ)
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='deleted',
          port_slot=NULL,
          assigned_port_no=NULL,
          windows_port_no=NULL,
          vps_id=NULL,
          port_id=NULL,
          last_login_message='ว่าง',
          updated_at=NOW()
      WHERE id=$1
        AND user_id=$2
        AND LOWER(TRIM(COALESCE(status,'ready'))) <> 'deleted'
    `, [id, userId]);

    const { adminNodeId } = await resolveSystemVpsId(stopNodeId).catch(() => ({ adminNodeId: 0 }));
    await releaseUserPortCompletely({
      systemVpsId: stopNodeId,
      adminNodeId: adminNodeId || stopNodeId,
      portNo: stopPortNo,
      folderPath,
      portId: oldPort.port_id || null
    }).catch(() => {});

    flash(req, 'success', 'ลบ PORT ' + (oldPort.port_slot || '') + ' แล้ว — ช่องว่างพร้อมใช้ใหม่');
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
             us.end_at,
             us.start_at
      FROM user_subscriptions us
      LEFT JOIN packages p ON p.id=us.package_id
      WHERE us.user_id=$1
        AND (us.end_at IS NULL OR us.end_at > NOW())
        AND LOWER(TRIM(COALESCE(us.status, ''))) NOT IN ('cancelled', 'deleted')
      ORDER BY
        CASE WHEN LOWER(TRIM(COALESCE(us.status, ''))) = 'active' THEN 0 ELSE 1 END,
        us.updated_at DESC NULLS LAST,
        us.id DESC
      LIMIT 1
    `, [userId]);

    const pkg = pkgRows.rows[0];
    if (!pkg) throw new Error('ไม่พบแพ็กเกจที่ใช้งานอยู่');

    const group = String(pkg.package_group || '').toUpperCase();
    const packageMaxPorts = packagePortCapForGroup(group, pkg.max_ports);

    await pruneStaleTemporaryExtraPorts(userId, pkg.subscription_id, pkg.start_at).catch(() => {});

    const extraRows = await getExtraPortRows(
      userId,
      pkg.subscription_id,
      pkg.package_id,
      group,
      pkg.start_at
    );
    const entitlement = computePortEntitlement(packageMaxPorts, extraRows, group);

    if (portType === 'temporary' && !entitlement.canAddTemporary) {
      throw new Error(
        `ใช้ PORT ครบ ${packageMaxPorts} ช่องแล้ว (แพ็กเกจ ${group} รวมได้สูงสุด ${packageMaxPorts} PORT)`
      );
    }
    if (portType === 'permanent' && !entitlement.canAddPermanent) {
      throw new Error(
        `ใช้ PORT ครบ ${packageMaxPorts} ช่องแล้ว (ถาวรผูกระดับ ${group})`
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

/** Agent / delayed retry — อัปเดต Balance & Equity ลงบัญชี (ไม่ต้องมี BOT รัน) */
router.post('/mt5/account-metrics', async (req, res) => {
  try {
    const accountId = num(req.body?.accountId || req.body?.account_id);
    const userId = num(req.body?.userId || req.body?.user_id);
    const portNumber = num(req.body?.portNumber || req.body?.port);
    const balance = positiveMoney(req.body?.balance);
    const equity = positiveMoney(req.body?.equity);

    if (!accountId && !userId) {
      return res.json({ ok: false, message: 'accountId or userId required' });
    }

    const params = [];
    const where = [];
    if (accountId) {
      params.push(accountId);
      where.push(`id=$${params.length}`);
    }
    if (userId) {
      params.push(userId);
      where.push(`user_id=$${params.length}`);
    }
    if (portNumber) {
      params.push(portNumber);
      where.push(`(assigned_port_no=$${params.length} OR port_slot=$${params.length})`);
    }

    params.push(balance);
    params.push(equity);

    const balIdx = params.length - 1;
    const eqIdx = params.length;

    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET last_balance = COALESCE($${balIdx}::numeric, last_balance),
          last_equity = COALESCE($${eqIdx}::numeric, last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE ${where.join(' AND ')}
    `,
      params
    );

    return res.json({ ok: true, balance, equity });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

/** บันทึก Equity/Balance ที่ผู้ใช้ใส่เอง (จากหน้าจอ MT5) */
router.post('/mt5/save-equity', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = num(req.body.mt5_account_id);
    const equity = positiveMoney(req.body.equity ?? req.body.capital_manual);
    const balance = positiveMoney(req.body.balance);

    if (!accountId) return res.json({ ok: false, message: 'กรุณาเลือกบัญชี' });
    if (!equity && !balance) {
      return res.json({ ok: false, message: 'กรุณาใส่ Equity หรือ Balance จาก MT5' });
    }

    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET last_equity = COALESCE($3::numeric, last_equity),
          last_balance = COALESCE($4::numeric, last_balance),
          updated_at = NOW()
      WHERE id = $1 AND user_id = $2
    `,
      [accountId, userId, equity, balance]
    );

    return res.json({
      ok: true,
      equity,
      balance,
      capital: equity || balance
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

/** อ่าน Balance/Equity — ค่าเริ่มต้นจาก DB; ?live=1 ดึงจาก VPS/MT5 ล่าสุด */
router.get('/mt5/account-equity', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = num(req.query.account_id || req.query.mt5_account_id);
    if (!accountId) return res.json({ ok: false, message: 'account_id required' });

    const row = await query(
      `
      SELECT
        ma.id,
        ma.vps_id,
        ma.assigned_port_no,
        ma.port_slot,
        ma.mt5_login,
        ma.last_balance,
        ma.last_equity,
        ma.status,
        GREATEST(ma.updated_at, bi.updated_at, ph.updated_at) AS updated_at,
        bi.mt5_balance AS bi_balance,
        bi.mt5_equity AS bi_equity,
        bi.profit AS bi_profit,
        ph.balance AS ph_balance,
        ph.equity AS ph_equity
      FROM vps_system.mt5_accounts ma
      LEFT JOIN LATERAL (
        SELECT mt5_balance, mt5_equity, profit, updated_at, last_agent_ping
        FROM vps_system.bot_instances
        WHERE mt5_account_id = ma.id
          AND user_id = $2
          AND LOWER(COALESCE(status, '')) IN ('running', 'starting', 'restarting', 'pending')
        ORDER BY last_agent_ping DESC NULLS LAST, id DESC
        LIMIT 1
      ) bi ON TRUE
      LEFT JOIN vps_system.vps_port_health ph
        ON ph.node_id = ma.vps_id
        AND ph.port_number = COALESCE(ma.assigned_port_no, ma.port_slot)
        AND ph.updated_at > NOW() - INTERVAL '3 minutes'
      WHERE ma.id = $1
        AND ma.user_id = $2
        AND LOWER(TRIM(COALESCE(ma.status, ''))) NOT IN ('deleted', 'expired')
      LIMIT 1
    `,
      [accountId, userId]
    );
    const acc = row.rows?.[0];
    if (!acc) return res.json({ ok: false, message: 'ไม่พบบัญชี' });

    const wantLive = String(req.query.live || req.query.refresh || '') === '1';
    if (wantLive && acc.vps_id) {
      const ctx = await loadAccountPortContext(accountId, userId);
      if (ctx?.vpsId) {
        const live = await fetchEquityFromVps(ctx, accountId, userId, {
          waitMs: 8000,
          skipJournal: true,
          light: true,
          forceFresh: true,
          purpose: 'equity_live_api'
        }).catch(() => ({ ok: false }));
        if (live?.ok) {
          const balL = positiveMoney(live.balance);
          const eqL = positiveMoney(live.equity);
          let profitL =
            live.profit != null && Number.isFinite(Number(live.profit))
              ? Number(live.profit)
              : null;
          if (profitL == null && balL != null && eqL != null) {
            profitL = Math.round((eqL - balL) * 100) / 100;
          }
          return res.json({
            ok: true,
            balance: balL || 0,
            equity: eqL,
            profit: profitL,
            hasEquity: eqL != null,
            hasBalance: balL != null,
            capital: eqL || balL || 0,
            updatedAt: new Date().toISOString(),
            source: live.source || 'vps_live'
          });
        }
      }
    }

    let balanceNum =
      positiveMoney(acc.bi_balance) ??
      positiveMoney(acc.last_balance) ??
      positiveMoney(acc.ph_balance);
    let equityNum =
      positiveMoney(acc.bi_equity) ??
      positiveMoney(acc.last_equity) ??
      positiveMoney(acc.ph_equity);

    if ((!equityNum || !balanceNum) && acc.vps_id && (acc.ph_equity || acc.ph_balance)) {
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET last_balance = COALESCE($3::numeric, last_balance),
            last_equity = COALESCE($4::numeric, last_equity),
            updated_at = NOW()
        WHERE id = $1 AND user_id = $2
      `,
        [accountId, userId, positiveMoney(acc.ph_balance), positiveMoney(acc.ph_equity)]
      ).catch(() => {});
    }
    let profitNum =
      acc.bi_profit != null && Number.isFinite(Number(acc.bi_profit))
        ? Number(acc.bi_profit)
        : null;
    if (profitNum == null && balanceNum != null && equityNum != null) {
      profitNum = Math.round((equityNum - balanceNum) * 100) / 100;
    }

    return res.json({
      ok: true,
      balance: balanceNum || 0,
      equity: equityNum,
      profit: profitNum,
      hasEquity: equityNum != null,
      hasBalance: balanceNum != null,
      capital: equityNum || balanceNum || 0,
      updatedAt: acc.updated_at || new Date().toISOString(),
      source:
        acc.bi_equity != null || acc.bi_balance != null
          ? 'bot_live'
          : acc.ph_equity != null || acc.ph_balance != null
            ? 'port_health'
            : 'db'
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

/** ดึง Balance/Equity ล่าสุด + ดึงจาก VPS ผ่าน port_read_file (รองรับ Agent เก่า) */
router.get('/mt5/account-snapshot', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = num(req.query.account_id || req.query.mt5_account_id);
    const waitSync = String(req.query.wait || '') === '1';
    const forceRefresh = String(req.query.refresh || '') === '1';
    if (!accountId) return res.json({ ok: false, message: 'account_id required' });

    let ctx = await loadAccountPortContext(accountId, userId);
    if (!ctx) return res.json({ ok: false, message: 'ไม่พบบัญชี' });

    let balanceNum = positiveMoney(ctx.account.last_balance);
    let equityNum = positiveMoney(ctx.account.last_equity);
    const connected = String(ctx.account.status || '').toLowerCase() === 'connected';
    const needsSync = connected && !equityNum;

    let fetchMeta = null;
    const shouldVpsSync = connected && ctx.vpsId && (needsSync || forceRefresh);
    if (shouldVpsSync) {
      fetchMeta = await fetchEquityFromVps(ctx, accountId, userId, {
        waitMs: waitSync ? 12000 : forceRefresh ? 8000 : 0,
        skipJournal: true,
        light: true,
        forceFresh: !!forceRefresh,
        purpose: forceRefresh ? 'equity_live_poll' : 'equity_sync'
      });
      if (needsSync && !fetchMeta?.ok && waitSync) {
        fetchMeta = await fetchEquityFromVps(ctx, accountId, userId, {
          waitMs: 8000,
          skipJournal: false,
          light: true,
          purpose: 'equity_journal_retry'
        });
      }
      if (fetchMeta?.ok) {
        balanceNum = positiveMoney(fetchMeta.balance) ?? balanceNum;
        equityNum = positiveMoney(fetchMeta.equity) ?? equityNum;
      }
      ctx = await loadAccountPortContext(accountId, userId);
      if (!fetchMeta?.ok) {
        balanceNum = positiveMoney(ctx?.account?.last_balance) ?? balanceNum;
        equityNum = positiveMoney(ctx?.account?.last_equity) ?? equityNum;
      }
    }

    const profitNum =
      balanceNum != null && equityNum != null
        ? Math.round((equityNum - balanceNum) * 100) / 100
        : fetchMeta?.profit != null && Number.isFinite(Number(fetchMeta.profit))
          ? Number(fetchMeta.profit)
          : null;

    return res.json({
      ok: true,
      balance: balanceNum || 0,
      equity: equityNum,
      profit: profitNum,
      hasEquity: equityNum != null,
      hasBalance: balanceNum != null,
      capital: equityNum || balanceNum || 0,
      syncing: connected && !equityNum && forceRefresh,
      source: fetchMeta?.source || (forceRefresh ? 'vps_pending' : null),
      live: !!(fetchMeta?.ok && forceRefresh),
      updatedAt: new Date().toISOString(),
      hint: fetchMeta?.hint || (needsSync && !equityNum ? 'กำลังดึงจาก MT5...' : null),
      agentDeployQueued: !!fetchMeta?.agentDeployQueued
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5/preset-calc', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const mt5AccountId = num(req.query.mt5_account_id);
    const botId = num(req.query.bot_id);
    const capitalManual = num(req.query.capital_manual);
    const manualLot = num(req.query.manual_lot);
    const tradeLevel = normalizeTradeLevel(req.query.trade_level || 'medium');

    if (!mt5AccountId || !botId) {
      return res.json({ ok: false, message: 'กรุณาเลือก PORT และ BOT' });
    }

    const summary = await getPortSummaryReadOnly(userId);
    const { lotMin, lotMax, defaultLot, packageGroup } = packageLotLimits(summary);

    const accountRes = await safeQuery(
      `SELECT id, mt5_login, last_balance, last_equity, status FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [mt5AccountId, userId]
    );
    const account = accountRes[0];
    if (!account) return res.json({ ok: false, message: 'ไม่พบบัญชี MT5' });

    const botRes = await safeQuery(
      `SELECT * FROM vps_system.bot_catalog WHERE id=$1 AND is_active=TRUE LIMIT 1`,
      [botId]
    );
    const bot = botRes[0];
    if (!bot || !isProductionBot(bot)) {
      return res.json({ ok: false, message: 'ไม่พบ BOT ที่เลือก' });
    }

    const mt5Balance = positiveMoney(account.last_balance) || 0;
    const mt5Equity = positiveMoney(account.last_equity);
    const capital =
      capitalManual > 0
        ? capitalManual
        : mt5Equity != null && mt5Equity > 0
          ? mt5Equity
          : mt5Balance > 0
            ? mt5Balance
            : 0;

    const capCheck = validateRunCapital(capital);
    if (!capCheck.ok) {
      return res.json({ ok: false, message: capCheck.message, capital, mt5Balance, mt5Equity: mt5Equity ?? 0 });
    }

    const profit =
      mt5Equity != null && mt5Balance > 0 ? Math.round((mt5Equity - mt5Balance) * 100) / 100 : null;

    const calc = computePresetForBot(
      bot,
      capCheck.capital,
      tradeLevel,
      manualLot,
      lotMin,
      lotMax,
      defaultLot
    );

    const licenseCheck = validateEaAccountAccess(bot.bot_code, account.mt5_login, {
      presetSlug: calc.presetSlug
    });
    const licensedAlt = !licenseCheck.ok
      ? findLicensedBotForLogin(account.mt5_login, await loadProductionBots())
      : null;

    const eaSetPreview = buildEaSetPayloadFields({
      bot,
      lot: calc.lot,
      capital: capCheck.capital,
      trade: calc.trade,
      preset: { ...calc.preset, lot_plus: calc.lotPlus },
      presetSlug: calc.presetSlug
    });

    const riskLabel =
      calc.trade.trade_level === 'high'
        ? '🔴 เสี่ยงสูง'
        : calc.trade.trade_level === 'medium'
          ? '🟡 เสี่ยงกลาง'
          : '🟢 เสี่ยงต่ำ';

    return res.json({
      ok: licenseCheck.ok !== false,
      eaLicenseOk: licenseCheck.ok !== false,
      eaLicenseMessage: licenseCheck.ok === false ? licenseCheck.message : null,
      suggestedBotId: licensedAlt ? Number(licensedAlt.id) : null,
      suggestedBotCode: licensedAlt ? licensedAlt.bot_code : null,
      suggestedBotLabel: licensedAlt
        ? licensedAlt.display_name || licensedAlt.bot_name || licensedAlt.bot_code
        : null,
      capital: capCheck.capital,
      mt5Balance,
      mt5Equity: mt5Equity != null ? mt5Equity : 0,
      mt5Profit: profit,
      mt5EquityKnown: mt5Equity != null,
      suggestedLot: calc.suggestedLot,
      lot: calc.lot,
      lotPlus: calc.lotPlus,
      defaultLot: calc.packageDefaultLot || defaultLot,
      lotMin,
      lotMax,
      packageGroup,
      tradeLevel: calc.trade.trade_level,
      riskLabel,
      tStart: calc.trade.t_start,
      tStop: calc.trade.t_stop,
      presetSlug: calc.presetSlug,
      eaSetFileName: eaSetPreview.eaSetFileName,
      eaAttachHint: eaSetPreview.eaAttachHint,
      capitalRecommend: calc.capital_recommend,
      capitalSafe: calc.capital_safe,
      capitalMaxSafe: calc.capital_max_safe,
      capitalFromTable: calc.capitalFromTable,
      matchedByLot: calc.matchedByLot,
      minCapital: 100,
      packageLotRange: `${lotMin} - ${lotMax}`,
      packageLotHint: `แพ็กเกจ ${packageGroup} · Lot ${lotMin} - ${lotMax} · ค่าเริ่มต้น ${defaultLot} (สูงสุดแพ็กเกจ)`
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

router.get('/mt5/bot-analytics/:id', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const instanceId = num(req.params.id);

    const instRes = await query(
      `
      SELECT bi.*,
             bc.bot_code, bc.display_name, bc.bot_name,
             ma.port_slot, ma.mt5_login, ma.last_balance, ma.last_equity,
             n.agent_version AS vps_agent_version,
             EXTRACT(EPOCH FROM (NOW() - bi.last_agent_ping)) AS last_ping_sec
      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
      LEFT JOIN vps_system.mt5_accounts ma ON ma.id = bi.mt5_account_id
      LEFT JOIN vps_system.vps_nodes n ON n.id = bi.vps_id
      WHERE bi.id = $1 AND bi.user_id = $2
      LIMIT 1
    `,
      [instanceId, userId]
    );
    const inst = instRes.rows[0];
    if (!inst) return res.json({ ok: false, message: 'ไม่พบรายการ BOT' });

    const eqRes = await query(
      `
      SELECT equity, balance, created_at
      FROM vps_system.mt5_equity_logs
      WHERE instance_id = $1
      ORDER BY id ASC
      LIMIT 200
    `,
      [instanceId]
    );

    let equitySeries = (eqRes.rows || []).map((r) => ({
      equity: num(r.equity),
      balance: num(r.balance),
      at: r.created_at
    }));

    if (equitySeries.length < 2) {
      const eqNow =
        positiveMoney(inst.mt5_equity) ?? positiveMoney(inst.last_equity);
      const balNow =
        positiveMoney(inst.mt5_balance) ?? positiveMoney(inst.last_balance);
      if (eqNow != null) {
        const now = new Date();
        const ago = new Date(now.getTime() - 60000);
        equitySeries = [
          { equity: balNow ?? eqNow, balance: balNow, at: ago },
          { equity: eqNow, balance: balNow, at: now }
        ];
        await recordEquityLog(instanceId, eqNow).catch(() => {});
      }
    }

    const startEq = equitySeries.length ? equitySeries[0].equity : num(inst.mt5_equity);
    const lastEq = equitySeries.length
      ? equitySeries[equitySeries.length - 1].equity
      : num(inst.mt5_equity);
    const profit = Number((lastEq - startEq).toFixed(2));

    let intel = null;
    try {
      const trend =
        equitySeries.length >= 2
          ? `Equity 7d trend: start ${startEq}, now ${lastEq}, change ${profit}`
          : 'ยังไม่มีประวัติ equity เพียงพอ';
      intel = await generateIntelReport({
        symbol: 'XAUUSD',
        technical: `${trend}. BOT ${inst.bot_code || ''} level ${inst.trade_level || 'safe'} lot ${inst.lot_used || '-'}.`,
        news: 'Gold (XAUUSD) analysis for automated sniper bot — 7 day window.'
      });
    } catch (intelErr) {
      intel = {
        direction: 'WAIT',
        technical_summary: 'AI วิเคราะห์ชั่วคราวไม่พร้อม: ' + intelErr.message,
        risk_summary: 'ใช้เป็นข้อมูลประกอบเท่านั้น'
      };
    }

    const alerts = [];
    if (String(inst.last_error || '').trim()) {
      alerts.push({ level: 'warning', message: inst.last_error });
    }
    if (profit < 0 && Math.abs(profit) > num(inst.capital_used, 0) * 0.1) {
      alerts.push({ level: 'danger', message: `ขาดทุนสะสม ${profit} USD — ตรวจสอบ BOT` });
    }
    if (num(inst.last_ping_sec, 0) > 120) {
      alerts.push({ level: 'warning', message: 'Agent ไม่ตอบสนองนานเกิน 2 นาที' });
    }
    const eaSt = String(inst.ea_status || '').toLowerCase();
    if (eaSt === 'attach_required') {
      alerts.push({
        level: 'warning',
        message:
          'แนบ EA บนกราฟ XAUUSD แล้ว Load preset — จาก Navigator ลาก AK-SNIPER-VIP-VER4.0 ลงกราฟ'
      });
    }
    if (eaSt === 'algo_off') {
      alerts.push({
        level: 'danger',
        message:
          'ปุ่ม Algo Trading ใน MT5 ยังปิด (สีแดง) — กดให้เป็นสีเขียว BOT ถึงจะเทรดได้'
      });
    }
    if (eaSt === 'wrong_chart') {
      alerts.push({
        level: 'warning',
        message: 'เปิดกราฟ XAUUSD ใน MT5 (ไม่ใช่คู่เงินอื่น เช่น EURCHF)'
      });
    }
    const instActive = ['running', 'pending', 'restarting', 'starting'].includes(
      String(inst.status || '').toLowerCase()
    );
    if (instActive && !hasRunBotMarker(inst.vps_agent_version)) {
      alerts.push({
        level: 'danger',
        message: 'Agent บน VPS ยังเป็นเวอร์ชันเก่า — รออัปเดต v21 หรือกด Restart BOT'
      });
    }

    return res.json({
      ok: true,
      instance: {
        id: inst.id,
        status: inst.status,
        botCode: inst.bot_code,
        botName: inst.display_name || inst.bot_name,
        portSlot: inst.port_slot,
        mt5Login: inst.mt5_login,
        lot: inst.lot_used,
        tradeLevel: inst.trade_level,
        balance: inst.mt5_balance,
        equity: inst.mt5_equity
      },
      profit,
      equitySeries,
      intel,
      alerts,
      trades: []
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

/** รีเซ็ตการตั้งค่าเทรดบน PORT — หยุด BOT (ถ้ารันอยู่) แล้วปลดล็อกฟอร์ม (ไม่ลบ Login MT5) */
router.post('/mt5/trading-reset', requireLogin, async (req, res) => {
  const client = await getClient();
  try {
    const userId = req.user.id;
    const mt5AccountId = num(req.body.mt5_account_id || req.body.mt5AccountId);
    const portSlot = num(req.body.port_slot || req.body.portSlot);
    if (!mt5AccountId) {
      return res.status(400).json({ ok: false, message: 'ไม่พบบัญชี PORT' });
    }

    const accountCtx = await loadAccountPortContext(mt5AccountId, userId, client);
    if (!accountCtx) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ ok: false, message: 'ไม่พบบัญชี MT5' });
    }
    if (portSlot > 0 && Number(accountCtx.account.port_slot) !== portSlot) {
      return res.status(400).json({
        ok: false,
        message: `บัญชีไม่ตรง PORT ${portSlot}`
      });
    }

    await client.query('BEGIN');

    const active = await client.query(
      `
      SELECT id, status, vps_id, assigned_port_no, folder_path, lot_used, mt5_account_id
      FROM vps_system.bot_instances
      WHERE user_id=$1
        AND mt5_account_id=$2
        AND status IN ('running','pending','starting','restarting')
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `,
      [userId, mt5AccountId]
    );

    let stoppedId = null;
    const inst = active.rows?.[0];
    if (inst) {
      stoppedId = inst.id;
      await client.query(
        `UPDATE vps_system.bot_instances SET status='stopped', ea_status='stopped', stopped_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [inst.id]
      );
      if (inst.vps_id) {
        await pruneMetricsCommandBacklog(inst.vps_id, { keep: 0 }).catch(() => {});
        const portNo = Number(inst.assigned_port_no || accountCtx.portNo || 0);
        const folderPath = folderPathForPortNo(portNo, inst.folder_path || accountCtx.folderPath || '');
        await cancelStaleRunBotCommands(inst.vps_id, accountCtx.portId, inst.id);
        await client.query(
          `
          INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at)
          VALUES ($1,$1,'stop_mt5_bot',$2::jsonb,'pending',NOW())
        `,
          [
            inst.vps_id,
            JSON.stringify({
              instanceId: inst.id,
              accountId: inst.mt5_account_id,
              port: portNo,
              portNumber: portNo,
              portSlot: accountCtx.portSlot || portNo,
              vpsFolderPath: folderPath,
              folder_path: folderPath,
              stopTradingOnly: true,
              keepMt5Open: true,
              action: 'stop_bot_trading'
            })
          ]
        );
      }
    }

    await client.query('COMMIT');

    if (req.session) {
      delete req.session.mt5LastRunInstanceId;
      if (portSlot) delete req.session[`mt5TradeLevel_${portSlot}`];
    }

    return res.json({
      ok: true,
      stopped: !!stoppedId,
      instanceId: stoppedId,
      portSlot: accountCtx.portSlot,
      message: stoppedId
        ? 'รีเซ็ตแล้ว — หยุด BOT แล้ว เลือก BOT / ระดับความเสี่ยง / ทุน / LOT ใหม่ได้'
        : 'รีเซ็ตแล้ว — เลือก BOT / ระดับความเสี่ยง / ทุน / LOT ใหม่ได้ (MT5 ยังเชื่อมต่ออยู่)'
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(400).json({ ok: false, message: e.message });
  } finally {
    client.release();
  }
});

router.post('/mt5/run', requireLogin, async (req, res) => {
  const wantsJson = prefersJsonResponse(req);
  const client = await getClient();
  let lockKey = null;
  try {
    await ensureBotCatalog();
    await ensureBotInstanceRunColumns();
    const userId = req.user.id;
    lockKey = getUserLockKey(userId);
    const locked = await tryRedisLock(lockKey, 15);
    if (!locked) throw new Error('⏳ ระบบกำลัง Run BOT อยู่...');

    const mt5AccountId = num(req.body.mt5_account_id);
    const reqPortSlot = num(req.body.port_slot || req.body.portSlot);
    const botId = num(req.body.bot_id);
    const capitalManual = num(req.body.capital_manual);
    const manualLot = num(req.body.manual_lot);
    const tradeLevel = normalizeTradeLevel(req.body.trade_level || 'medium');

    if (!mt5AccountId) throw new Error('กรุณาเลือก PORT/บัญชี MT5');
    if (!botId) throw new Error('กรุณาเลือก BOT');

    await client.query('BEGIN');

    const summary = await getPortSummary(userId);
    const { lotMin, lotMax, defaultLot } = packageLotLimits(summary);

    const running = await client.query(
      `SELECT COUNT(*)::int c FROM vps_system.bot_instances WHERE user_id=$1 AND status IN ('running','pending','starting','restarting')`,
      [userId]
    );
    if (num(running.rows[0]?.c) >= summary.totalPorts) {
      throw new Error(`จำนวน BOT ที่รันเต็มแล้ว ตามสิทธิ์ ${summary.totalPorts} PORT`);
    }

    const accountCtx = await loadAccountPortContext(mt5AccountId, userId, client);
    if (!accountCtx) throw new Error('ไม่พบบัญชี MT5 ของคุณ');
    if (String(accountCtx.account.status || '').toLowerCase() !== 'connected') {
      throw new Error('PORT นี้ยังไม่เชื่อมต่อ MT5 สำเร็จ กรุณา Login ก่อน (ขั้นตอน 2)');
    }
    if (reqPortSlot > 0 && Number(accountCtx.account.port_slot) !== reqPortSlot) {
      throw new Error(`บัญชีนี้ไม่ตรง PORT ${reqPortSlot} — ใช้ PORT เดียวกับที่ Login`);
    }
    if (!accountCtx.vpsId || !accountCtx.portNo) {
      throw new Error('ไม่พบ VPS/PORT ของบัญชีนี้ กรุณาเชื่อมต่อ MT5 ใหม่');
    }

    ensureRunBotAgent(accountCtx.vpsId).catch(() => {});

    const dup = await client.query(
      `SELECT id FROM vps_system.bot_instances WHERE mt5_account_id=$1 AND status IN ('running','pending','starting','restarting') LIMIT 1`,
      [mt5AccountId]
    );
    if (dup.rows[0]) throw new Error('PORT นี้กำลังรัน BOT อยู่แล้ว กรุณาหยุดก่อน');

    const botRows = await client.query(
      `SELECT * FROM vps_system.bot_catalog WHERE id=$1 AND is_active=TRUE`,
      [botId]
    );
    const bot = botRows.rows[0];
    if (!bot || !isProductionBot(bot)) throw new Error('ไม่พบ BOT ที่เลือก');

    const licenseCheckEarly = validateEaAccountAccess(bot.bot_code, accountCtx.mt5Login, {
      presetSlug: presetSlugForBot(bot)
    });
    if (!licenseCheckEarly.ok) {
      const alt = findLicensedBotForLogin(accountCtx.mt5Login, await loadProductionBots());
      throw new Error(
        licenseCheckEarly.message +
          (alt
            ? ` — แนะนำเลือก "${alt.display_name || alt.bot_name}" แล้วกดรีเซ็ต/เปิด BOT ใหม่`
            : '')
      );
    }

    let mt5Balance = positiveMoney(accountCtx.account.last_balance);
    let mt5Equity = positiveMoney(accountCtx.account.last_equity);

    if (!capitalManual && mt5Equity == null && mt5Balance == null) {
      await fetchEquityFromVps(accountCtx, mt5AccountId, userId, {
        waitMs: 1200,
        skipJournal: true
      }).catch(() => {});
      const freshAcc = await query(
        `SELECT last_balance, last_equity FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
        [mt5AccountId]
      ).catch(() => ({ rows: [] }));
      mt5Balance = positiveMoney(freshAcc.rows?.[0]?.last_balance);
      mt5Equity = positiveMoney(freshAcc.rows?.[0]?.last_equity);
    }

    const capital =
      capitalManual > 0
        ? capitalManual
        : mt5Equity != null
          ? mt5Equity
          : mt5Balance != null
            ? mt5Balance
            : 0;

    const capCheck = validateRunCapital(capital);
    if (!capCheck.ok) {
      throw new Error(
        capital === 0
          ? 'ระบบยังไม่ได้รับค่า Equity จาก MT5 — กรุณากรอก "เงินทุน" ในช่องด้านบน (ขั้นต่ำ $100)'
          : capCheck.message
      );
    }

    const calc = computePresetForBot(
      bot,
      capCheck.capital,
      tradeLevel,
      manualLot,
      lotMin,
      lotMax,
      defaultLot
    );
    const trade = calc.trade;
    const lot = calc.lot;

    const assignedPortNo = accountCtx.portNo;
    const commandType = 'run_bot';

    const inst = await client.query(
      `
      INSERT INTO vps_system.bot_instances
      (user_id, mt5_account_id, bot_id, vps_id, status, lot_used, lot, port_used, assigned_port_no,
       port_id, folder_path, mt5_login, symbol, preset_id, run_payload, started_at, trade_level,
       capital_used, mt5_balance, mt5_equity, updated_at)
      VALUES ($1,$2,$3,$4,'starting',$5,$5,1,$6,$7,$8,$9,'XAUUSD',$10,'{}'::jsonb,NOW(),$11,$12,$13,$14,NOW())
      RETURNING *
    `,
      [
        userId,
        mt5AccountId,
        botId,
        accountCtx.vpsId,
        lot,
        assignedPortNo,
        accountCtx.portId,
        accountCtx.folderPath,
        accountCtx.mt5Login,
        calc.preset?.id || null,
        tradeLevel,
        capCheck.capital,
        mt5Balance ?? null,
        mt5Equity ?? null
      ]
    );

    const instanceId = inst.rows[0].id;
    const presetForEa = calc.preset
      ? { ...calc.preset, lot_plus: calc.lotPlus }
      : { lot_plus: calc.lotPlus };
    const eaSet = buildEaSetPayloadFields({
      bot,
      lot,
      capital: capCheck.capital,
      trade,
      preset: presetForEa,
      presetSlug: calc.presetSlug
    });
    const payload = buildRunMt5BotPayload({
      accountCtx,
      bot,
      lot,
      capital: capCheck.capital,
      trade,
      preset: calc.preset
        ? { ...calc.preset, id: calc.preset.id, presetSlug: calc.presetSlug, lot_plus: calc.lotPlus }
        : { id: null, presetSlug: calc.presetSlug, lot_plus: calc.lotPlus },
      eaSet,
      instanceId,
      commandType
    });

    const fullPayload = {
      ...payload,
      instanceId,
      commandId: null,
      tradeLevel,
      trade_level: tradeLevel,
      folder_path: accountCtx.folderPath || payload.folder_path,
      folderPath: accountCtx.folderPath || payload.folderPath,
      vpsFolderPath: accountCtx.folderPath || payload.vpsFolderPath
    };

    await cancelStaleRunBotCommands(accountCtx.vpsId, accountCtx.portId, instanceId);
    await pruneMetricsCommandBacklog(accountCtx.vpsId, { keep: 0 }).catch(() => {});

    const queued = await insertPendingAgentCommand({
      vpsId: accountCtx.vpsId,
      portId: accountCtx.portId,
      commandType,
      payload: fullPayload,
      client
    });

    const commandId = queued.id;
    const payloadWithCmd = { ...fullPayload, commandId };

    await client.query(
      `
      UPDATE vps_system.bot_instances
      SET run_payload=$2::jsonb,
          command_id=$3,
          updated_at=NOW()
      WHERE id=$1
    `,
      [instanceId, toJsonbParam(payloadWithCmd), commandId]
    );

    await client.query('COMMIT');
    req.session.mt5LastRunInstanceId = instanceId;
    if (accountCtx.portSlot) {
      req.session[`mt5TradeLevel_${accountCtx.portSlot}`] = tradeLevel;
    }
    const successMsg =
      `ส่งคำสั่งเปิด ${bot.display_name || bot.bot_name} ที่ PORT ${accountCtx.portSlot} แล้ว — ` +
      `รอ Agent ~30–60 วินาที · แนบ EA บน XAUUSD แล้ว Load preset ${eaSet.eaSetFileName || ''}`;
    if (wantsJson) {
      return res.json({
        ok: true,
        message: successMsg,
        instanceId,
        commandId,
        portSlot: accountCtx.portSlot,
        botCode: bot.bot_code,
        lot,
        tradeLevel,
        eaSetFileName: eaSet.eaSetFileName || null
      });
    }
    flash(req, 'success', successMsg);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (wantsJson) {
      return res.status(400).json({ ok: false, message: e.message });
    }
    flash(req, 'error', e.message);
  } finally {
    if (lockKey) await redis.del(lockKey).catch(() => {});
    client.release();
  }
  if (wantsJson) return;
  const slot = num(req.body.port_slot || req.body.portSlot) || 0;
  return res.redirect(
    slot ? `/app/mt5?port_slot=${slot}&run=${req.session.mt5LastRunInstanceId || ''}` : '/app/mt5'
  );
});

router.post('/mt5/instance/:id/remove', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = num(req.params.id);
    const rows = await query(
      `SELECT id, status, assigned_port_no FROM vps_system.bot_instances WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [id, userId]
    );
    const inst = rows.rows?.[0];
    if (!inst) throw new Error('ไม่พบรายการ BOT');
    const st = String(inst.status || '').toLowerCase();
    if (BOT_ACTIVE_STATUSES.includes(st)) {
      throw new Error('หยุด BOT ก่อน จึงจะเอาออกจากรายการได้');
    }
    await query(
      `UPDATE vps_system.bot_instances SET status='removed', ea_status='removed', updated_at=NOW() WHERE id=$1`,
      [id]
    );
    flash(req, 'success', 'เอารายการออกจากประวัติแล้ว');
  } catch (e) {
    flash(req, 'error', e.message || 'เอาออกไม่สำเร็จ');
  }
  const slot = num(req.query.port_slot || req.body?.port_slot || 0);
  return res.redirect(slot ? `/app/mt5?port_slot=${slot}` : '/app/mt5');
});

router.post('/mt5/stop/:id', requireLogin, async (req, res) => {
  const wantsJson = prefersJsonResponse(req);
  const client = await getClient();
  const portSlotQ = num(req.query.port_slot || req.body?.port_slot || 0);
  try {
    const userId = req.user.id;
    const id = num(req.params.id);
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT * FROM vps_system.bot_instances WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [id, userId]
    );
    const inst = rows.rows[0];
    if (!inst) throw new Error('ไม่พบรายการ BOT');

    const st = String(inst.status || '').toLowerCase();
    if (!BOT_ACTIVE_STATUSES.includes(st)) {
      throw new Error('BOT นี้หยุดอยู่แล้ว');
    }

    await client.query(
      `UPDATE vps_system.bot_instances SET status='stopped', ea_status='stopped', stopped_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (inst.vps_id) {
      await client.query(
        `
        UPDATE vps_system.vps_nodes
        SET used_ports=GREATEST(0,COALESCE(used_ports,0)-1),
            used_lot=GREATEST(0,COALESCE(used_lot,0)-$2),
            status=CASE WHEN status='busy' THEN 'online' ELSE status END,
            updated_at=NOW()
        WHERE id=$1
      `,
        [inst.vps_id, num(inst.lot_used)]
      );
      const portNo = Number(inst.assigned_port_no || 0);
      const folderPath = folderPathForPortNo(portNo, inst.folder_path || '');
      const portName = vpsPortNameForNo(portNo) || `VPS-WIN-01-PORT-${String(portNo).padStart(2, '0')}`;
      await cancelStaleRunBotCommands(inst.vps_id, null, id);
      await client.query(
        `
        INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at)
        VALUES ($1,$1,'stop_mt5_bot',$2::jsonb,'pending',NOW())
      `,
        [
          inst.vps_id,
          JSON.stringify({
            instanceId: id,
            accountId: inst.mt5_account_id,
            port: portNo,
            portNumber: portNo,
            portSlot: portNo,
            vpsFolderPath: folderPath,
            folder_path: folderPath,
            vpsPortName: portName,
            stopTradingOnly: true,
            keepMt5Open: true,
            action: 'stop_bot_trading'
          })
        ]
      );
    }
    await client.query('COMMIT');
    const msg = 'หยุด BOT แล้ว — หยุดการเทรด โปรแกรม MT5 ยังเปิดอยู่';
    if (wantsJson) {
      const slot = portSlotQ || num(inst.assigned_port_no) || 0;
      return res.json({
        ok: true,
        message: msg,
        instanceId: id,
        redirect: slot ? `/app/mt5?port_slot=${slot}` : '/app/mt5'
      });
    }
    flash(req, 'success', msg);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (wantsJson) {
      return res.status(400).json({ ok: false, message: e.message });
    }
    flash(req, 'error', e.message);
  } finally {
    client.release();
  }
  const slot = portSlotQ || num(req.body?.port_slot || 0);
  return res.redirect(slot ? `/app/mt5?port_slot=${slot}` : '/app/mt5');
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

router.post('/mt5/request-restart/:id', requireLogin, async (req, res) => {
  try {
    await ensureBotInstanceRunColumns();
    const userId = req.user.id;
    const id = num(req.params.id);

    const rows = await query(`
      SELECT bi.*, bc.bot_code, bc.display_name, bc.bot_name
      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
      WHERE bi.id=$1 AND bi.user_id=$2
      LIMIT 1
    `, [id, userId]);

    const inst = rows.rows[0];
    if (!inst) throw new Error('ไม่พบ BOT');

    const accountCtx = await loadAccountPortContext(inst.mt5_account_id, userId);
    if (!accountCtx) throw new Error('ไม่พบบัญชี MT5');
    if (String(accountCtx.account.status || '').toLowerCase() !== 'connected') {
      throw new Error('PORT นี้ยังไม่เชื่อมต่อ MT5');
    }

    await ensureRunBotAgent(inst.vps_id).catch(() => {});

    const bot = {
      bot_code: inst.bot_code,
      display_name: inst.display_name,
      bot_name: inst.bot_name
    };
    const rp = inst.run_payload && typeof inst.run_payload === 'object' ? inst.run_payload : {};
    const lotVal = num(inst.lot_used || inst.lot || rp.lot, 0.01);
    const capVal = num(inst.capital_used || rp.capital, 0);
    const trade = {
      trade_level: inst.trade_level || rp.tradeLevel || 'safe',
      t_start: num(rp.tStart, 0),
      t_stop: num(rp.tStop, 0)
    };
    const eaSet = buildEaSetPayloadFields({
      bot,
      lot: lotVal,
      capital: capVal,
      trade,
      preset: rp.presetRow || null,
      presetSlug: presetSlugForBot(bot) || 'ak-sniper'
    });
    const payload = {
      ...rp,
      ...buildRunMt5BotPayload({
        accountCtx,
        bot,
        lot: lotVal,
        capital: capVal,
        trade,
        preset: rp.presetRow || { id: inst.preset_id, presetSlug: rp.presetSlug || null },
        eaSet,
        instanceId: inst.id,
        commandType: 'restart_ea'
      }),
      instanceId: inst.id,
      action: 'restart_ea'
    };

    await cancelStaleRunBotCommands(inst.vps_id, accountCtx.portId, inst.id);

    const queued = await insertPendingAgentCommand({
      vpsId: inst.vps_id,
      portId: accountCtx.portId,
      commandType: 'restart_ea',
      payload: { ...payload, commandId: null }
    });

    await query(
      `
      UPDATE vps_system.bot_instances
      SET status='restarting',
          command_id=$2,
          run_payload=$3::jsonb,
          restart_count=COALESCE(restart_count,0)+1,
          last_error=NULL,
          ea_status='pending',
          updated_at=NOW()
      WHERE id=$1
    `,
      [id, queued.id, toJsonbParam({ ...payload, commandId: queued.id })]
    );

    return res.redirect('/app/mt5');
  } catch (e) {
    flash(req, 'error', e.message);
    return res.redirect('/app/mt5');
  }
});

router.get('/mt5/live-dashboard', async (req, res) => {
  try {
    const userId = req.user.id;
    const doSync = String(req.query.sync || '1') !== '0';

    const rows = await query(`
      SELECT 
        bi.id,
        bi.vps_id,
        bi.user_id,
        bi.status,
        bi.ea_status,
        bi.assigned_port_no,
        bi.lot_used,
        bi.lot,
        bi.trade_level,
        COALESCE(NULLIF(bi.mt5_balance, 0), ma.last_balance) AS mt5_balance,
        COALESCE(NULLIF(bi.mt5_equity, 0), ma.last_equity) AS mt5_equity,
        bi.profit,
        bi.symbol,
        bi.capital_used,
        bi.restart_count,
        bi.last_error,
        bi.command_id,
        (
          SELECT COALESCE(NULLIF(c.error, ''), NULLIF(c.result_message, ''))
          FROM vps_system.vps_agent_commands c
          WHERE c.id = bi.command_id
          LIMIT 1
        ) AS cmd_error,
        bi.last_agent_ping,
        bi.mt5_account_id,
        ma.last_balance AS account_balance,
        ma.last_equity AS account_equity,
        ma.mt5_login,
        EXTRACT(EPOCH FROM (NOW() - bi.last_agent_ping)) AS last_ping_sec,

        bc.display_name,
        bc.bot_name,
        bc.bot_code,

        COALESCE(n.node_code, n.node_name, 'VPS') AS node_label,
        n.agent_version AS vps_agent_version

      FROM vps_system.bot_instances bi
      LEFT JOIN vps_system.bot_catalog bc ON bc.id=bi.bot_id
      LEFT JOIN vps_system.vps_nodes n ON n.id=bi.vps_id
      LEFT JOIN vps_system.mt5_accounts ma ON ma.id=bi.mt5_account_id
      WHERE bi.user_id=$1
        AND LOWER(COALESCE(bi.status, '')) NOT IN ('removed', 'deleted')
      ORDER BY bi.id DESC
      LIMIT 20
    `, [userId]);

    const instances = (rows.rows || []).map((r) => {
      let bal = positiveMoney(r.mt5_balance) ?? positiveMoney(r.account_balance);
      let eq = positiveMoney(r.mt5_equity) ?? positiveMoney(r.account_equity);
      let profit = r.profit != null && Number.isFinite(Number(r.profit)) ? Number(r.profit) : null;
      if (profit == null && bal != null && eq != null) {
        profit = Math.round((eq - bal) * 100) / 100;
      }
      const st = String(r.status || '').toLowerCase();
      let eaStatus = String(r.ea_status || '').trim().toLowerCase();
      if (!eaStatus || eaStatus === 'unknown' || eaStatus === 'full' || eaStatus === 'free') {
        if (st === 'running') eaStatus = 'unknown';
        else if (st === 'starting' || st === 'restarting') eaStatus = 'pending';
        else if (st === 'failed' || st === 'error') eaStatus = 'error';
        else if (st === 'stopped') eaStatus = 'stopped';
        else eaStatus = '—';
      }
      const displayError = String(r.cmd_error || r.last_error || '').trim();
      return {
        ...r,
        mt5_balance: bal,
        mt5_equity: eq,
        display_profit: profit,
        ea_status: eaStatus,
        last_error: displayError || r.last_error,
        node_name: r.node_label,
        metrics_missing: bal == null && eq == null
      };
    });

    if (doSync) {
      const forceSync = String(req.query.force || '') === '1';
      for (const inst of instances) {
        const st = String(inst.status || '').toLowerCase();
        const isBotActive = ['running', 'pending', 'restarting', 'starting'].includes(st);
        // ไม่คิวคำสั่งถ้า BOT ไม่รัน — ยกเว้นกด sync บังคับ (force=1)
        if (!isBotActive) {
          if (!forceSync) continue;
        }
        const vpsId = Number(inst.vps_id || 0);
        const portNo = Number(inst.assigned_port_no || 0);
        if (!vpsId || !portNo) continue;
        const recent = await hasRecentMetricsSync(vpsId, inst.id, isBotActive ? 30 : 90);
        if (recent) continue;
        const folder = folderPathForPortNo(portNo, '');
        const syncPayload = {
          port: portNo,
          portNumber: portNo,
          portSlot: portNo,
          instanceId: inst.id,
          accountId: inst.mt5_account_id,
          userId: inst.user_id,
          vpsFolderPath: folder,
          folder_path: folder,
          mt5Login: inst.mt5_login || null
        };
        await queueAccountSnapshot(vpsId, syncPayload, {
          agentVersion: inst.vps_agent_version
        }).catch(() => queueSyncMt5Account(vpsId, syncPayload).catch(() => 0));
      }
    }

    for (const inst of instances) {
      const st = String(inst.status || '').toLowerCase();
      if (!['running', 'pending', 'restarting', 'starting'].includes(st)) continue;
      const fresh = await query(
        `
        SELECT result, finished_at
        FROM vps_system.vps_agent_commands
        WHERE vps_id = $1
          AND command_type IN ('account_snapshot', 'sync_mt5_account', 'read_account_metrics', 'dashboard', 'watchdog')
          AND LOWER(COALESCE(status, '')) IN ('success', 'done')
          AND COALESCE(payload->>'instanceId', '') = $2
          AND finished_at > NOW() - INTERVAL '3 minutes'
        ORDER BY id DESC
        LIMIT 1
      `,
        [inst.vps_id, String(inst.id)]
      ).catch(() => ({ rows: [] }));
      const row = fresh.rows?.[0];
      if (!row?.result) continue;
      const metrics = metricsFromSnapshotResult(row.result);
      if (!metrics || (!metrics.balance && !metrics.equity)) continue;
      inst.mt5_balance = metrics.balance ?? inst.mt5_balance;
      inst.mt5_equity = metrics.equity ?? inst.mt5_equity;
      inst.display_profit =
        metrics.profit != null && Number.isFinite(Number(metrics.profit))
          ? Number(metrics.profit)
          : inst.mt5_balance != null && inst.mt5_equity != null
            ? Math.round((inst.mt5_equity - inst.mt5_balance) * 100) / 100
            : inst.display_profit;
      inst.metrics_missing = false;
      inst.last_agent_ping = row.finished_at || inst.last_agent_ping;
      if (inst.mt5_account_id) {
        await applyEquityToAccount(inst.mt5_account_id, inst.mt5_balance, inst.mt5_equity).catch(
          () => {}
        );
      }
    }

    const instanceIds = instances.map((i) => Number(i.id)).filter(Boolean);
    const equitySeriesByInstance = {};
    if (instanceIds.length) {
      const eqRes = await query(
        `
        SELECT instance_id, equity, created_at
        FROM vps_system.mt5_equity_logs
        WHERE instance_id = ANY($1::bigint[])
        ORDER BY id ASC
      `,
        [instanceIds]
      );
      for (const row of eqRes.rows || []) {
        const iid = Number(row.instance_id);
        if (!equitySeriesByInstance[iid]) equitySeriesByInstance[iid] = [];
        const v = Number(row.equity);
        if (Number.isFinite(v) && v > 0) {
          equitySeriesByInstance[iid].push(v);
        }
      }
    }

    let chartInstanceId = null;
    let chartSeries = [];
    for (const inst of instances) {
      const st = String(inst.status || '').toLowerCase();
      if (!['running', 'pending', 'restarting'].includes(st)) continue;
      const series = equitySeriesByInstance[Number(inst.id)] || [];
      if (series.length >= 1) {
        chartInstanceId = inst.id;
        chartSeries = series.slice(-80);
        break;
      }
    }
    if (!chartInstanceId && instances[0]) {
      chartInstanceId = instances[0].id;
      chartSeries = (equitySeriesByInstance[Number(instances[0].id)] || []).slice(-80);
    }
    if (chartSeries.length < 2 && chartInstanceId) {
      const cur = instances.find((x) => Number(x.id) === Number(chartInstanceId));
      const eqNow = positiveMoney(cur?.mt5_equity);
      if (eqNow != null) {
        chartSeries = chartSeries.length ? chartSeries : [];
        if (!chartSeries.length || chartSeries[chartSeries.length - 1] !== eqNow) {
          chartSeries = [...chartSeries, eqNow].slice(-80);
        }
        if (chartSeries.length === 1) {
          chartSeries = [chartSeries[0], chartSeries[0]];
        }
      }
    }

    for (const inst of instances) {
      const st = String(inst.status || '').toLowerCase();
      if (!['running', 'starting', 'restarting', 'pending'].includes(st)) continue;
      const eq = positiveMoney(inst.mt5_equity);
      if (eq != null) {
        await recordEquityLog(inst.id, eq).catch(() => {});
      }
    }

    const agentBanner = await resolveLiveDashboardAgentNotice(instances);
    if (agentBanner.queueDeploy || agentBanner.maintenancePending) {
      const vpsIds = [
        ...new Set(
          instances
            .filter((i) =>
              ['running', 'pending', 'restarting', 'starting'].includes(
                String(i.status || '').toLowerCase()
              )
            )
            .map((i) => Number(i.vps_id || 0))
            .filter((id) => id > 0)
        )
      ];
      for (const vpsId of vpsIds.slice(0, 2)) {
        await ensureAgentMaintenance(vpsId).catch(() => {});
      }
    }

    let agentNotice = agentBanner.notice || null;
    if (!agentNotice && agentBanner.maintenancePending) {
      agentNotice = 'ระบบกำลังอัปเดต Agent บน VPS — รอ 2–3 นาที (ไม่ต้องรีเฟรชถี่)';
    }

    return res.json({
      ok: true,
      instances,
      equitySeriesByInstance,
      chartInstanceId,
      chartSeries,
      agentNotice
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

// ===== EQUITY CHART API =====
router.get('/mt5/equity-chart/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.user.id;

    // 🔒 กันดูของคนอื่น
    const check = await query(`
      SELECT id FROM vps_system.bot_instances
      WHERE id=$1 AND user_id=$2
    `, [id, userId]);

    if (!check.rows[0]) {
      return res.json({ ok:false });
    }

    const rows = await query(`
      SELECT equity
      FROM vps_system.mt5_equity_logs
      WHERE instance_id=$1
      ORDER BY id DESC
      LIMIT 20
    `, [id]);

    return res.json({
      ok: true,
      data: rows.rows.reverse().map(r => Number(r.equity || 0))
    });

  } catch {
    return res.json({ ok:false });
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
  const botCode = String(instance.bot_code || '').trim();
  if (!isDemoBotCode(botCode)) return;

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

    const portNo = Number(instance.assigned_port_no || 0);
    const folderPath = folderPathForPortNo(portNo, instance.folder_path || '');
    const portName = vpsPortNameForNo(portNo);
    if (!folderPath && !portNo) return;
    await query(`
      INSERT INTO vps_system.vps_agent_commands
      (vps_id,node_id,command_type,payload,status,created_at)
      VALUES ($1,$1,'stop_mt5_bot',$2::jsonb,'pending',NOW())
    `, [
      instance.vps_id,
      JSON.stringify({
        instanceId: instance.id,
        port: portNo,
        portNumber: portNo,
        portSlot: portNo,
        vpsFolderPath: folderPath,
        folder_path: folderPath,
        vpsPortName: portName,
        reason: 'AI_cut_loss',
        stopTradingOnly: true,
        keepMt5Open: true
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

  // ไม่ย้าย VPS อัตโนมัติสำหรับบอททดสอบ (SNIPER-DEMO)
  if (false) {
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

}, 60000);

module.exports = router;
