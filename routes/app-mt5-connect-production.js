'use strict';

/**
 * Avelqua MT5 Multi VPS / Multi Port Login Route
 * Mount path แนะนำ: app.use('/app', require('./routes/app-mt5-connect-production'))
 * Endpoint:
 *   POST /app/mt5/connect-production
 *   GET  /app/mt5/connect-status-production
 */

const express = require('express');
const Redis = require('ioredis');
const { requireLogin } = require('../middleware/requireAuth');
const { query, getClient } = require('../config/database');
const { insertPendingAgentCommand } = require('../lib/vpsAgentCommandQueue');
const {
  resolveStuckLoginAccount,
  syncJournalFromLatestCommand,
  failAccountFromJournal,
  promoteAccountConnected,
  isLegacyWindowVerifiedMessage
} = require('../lib/mt5LoginCommandVerify');
const { previewPublicPath, windowTitleFromMessage } = require('../lib/mt5Preview');
const {
  resolveServerForLogin,
  MT5_LOCKED_SERVER,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOGIN_TIMEOUT_MSG
} = require('../lib/mt5Server');
const {
  messageIndicatesLoginFailed,
  resolveLoginFailUserMessage
} = require('../lib/mt5JournalVerify');
const { expireStuckMaintenanceCommands, deferMaintenanceForLogin } = require('../lib/agentDeploy');
const {
  userPortLockKey,
  computeJournalTimeoutSec,
  countActiveLoginsOnVps,
  computeLoginQueueDelaySec,
  connectPollStaleLimitMs
} = require('../lib/mt5MultiPortLogin');
const { pickAccountForPortSlot } = require('../lib/mt5PortAccount');
const {
  reserveAdminPortForLogin,
  buildMt5LoginPayload
} = require('../lib/adminVpsPortPicker');
const { setAdminAllocationStatus, parsePortNumber } = require('../lib/adminVpsBridge');
const { clearOtherAccountsOnPortSlot } = require('../lib/mt5PortAccount');
const { validateMt5LoginFormat } = require('../lib/mt5LoginFormat');
const {
  findLoginCommandInProgress,
  findRecentLoginCommand,
  releaseUserPackagePortSlot,
  forceStopPackagePortSlot,
  tryFastConnectConfirm,
  extractJournalEvidence,
  hasLoginCommandInProgress
} = require('../lib/mt5LoginCommandVerify');
const { cancelAgentCommandsForAccount } = require('../lib/vpsAgentCommandQueue');
const {
  listAllFolderPortsForConnect,
  pickFolderPortForSlot
} = require('../lib/mt5VpsFolderPorts');

const PUBLIC_CALLBACK_BASE = (process.env.AVELQUA_PUBLIC_URL || 'https://trading.avelqua.com').replace(/\/$/, '');

/** ฟอร์ม HTML POST ต้อง redirect กลับ /app/mt5 — ไม่ส่ง JSON ตรงให้เบราว์เซอร์ */
function wantsJsonConnectResponse(req) {
  if (String(req.get('X-Requested-With') || '').toLowerCase() === 'xmlhttprequest') return true;
  const accept = String(req.get('Accept') || '').toLowerCase();
  if (accept.includes('application/json')) return true;
  if (req.is && req.is('application/json')) return true;
  return false;
}

function respondConnectQueued(res, req, data) {
  if (wantsJsonConnectResponse(req)) {
    return res.json(data);
  }
  const q = new URLSearchParams({
    connect_queued: '1',
    connect_account: String(data.accountId || ''),
    port_slot: String(data.portSlot || '')
  });
  if (data.commandId) q.set('command_id', String(data.commandId));
  return res.redirect(302, `/app/mt5?${q.toString()}`);
}

function respondConnectFailed(res, req, message) {
  if (wantsJsonConnectResponse(req)) {
    return res.json({ ok: false, status: 'failed', message });
  }
  const q = new URLSearchParams({
    connect_error: String(message || 'เชื่อมต่อไม่สำเร็จ').slice(0, 500)
  });
  return res.redirect(302, `/app/mt5?${q.toString()}`);
}

const router = express.Router();
const redis = new Redis(process.env.REDIS_URL || undefined);

const DEFAULT_SERVER = MT5_LOCKED_SERVER;
const USER_LOCK_TTL = Number(process.env.MT5_USER_LOCK_TTL || 45);
const PORT_LOCK_MINUTES = Number(process.env.MT5_PORT_LOCK_MINUTES || 3);
const MAX_CPU = Number(process.env.MT5_MAX_CPU || 85);
const MAX_RAM = Number(process.env.MT5_MAX_RAM || 85);
const MAX_PING = Number(process.env.MT5_MAX_PING || 350);
/** Agent heartbeat / port-health อาจห่างกว่า 1 นาที — อย่าใช้ 60 วินาทีเดิม */
const AGENT_LAST_SEEN_MAX_SEC = Number(process.env.MT5_AGENT_LAST_SEEN_MAX_SEC || 600);

function clean(v) {
  return String(v || '').trim();
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function userLockKey(userId, portSlot = 0) {
  return userPortLockKey(userId, portSlot);
}

function mt5LoginLockKey(mt5Login, serverName) {
  return `mt5:connect:login:${String(serverName || '').toLowerCase()}:${String(mt5Login || '').trim()}`;
}

async function ensureRuntimeColumns() {
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
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS vps_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS port_no INT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS folder_path TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available'`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS locked_by_user_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS process_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS mt5_login TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS vps_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_slot INT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS assigned_port_no INT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS windows_port_no INT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_password TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS server_name TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_server TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS broker TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS account_name TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_login_message TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS connect_started_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

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
}

const { packagePortCapForGroup, computePortEntitlement } = require('../lib/mt5PortEntitlement');

async function getUserPackagePortLimit(userId) {
  const r = await query(
    `
    SELECT
      us.id AS subscription_id,
      us.package_id,
      COALESCE(
        NULLIF(us.ports_max, 0),
        NULLIF(us.ports_min, 0),
        NULLIF(to_jsonb(p)->>'ports_max','')::int,
        NULLIF(to_jsonb(p)->>'max_ports','')::int,
        NULLIF(to_jsonb(p)->>'port_limit','')::int,
        1
      ) AS max_ports,
      UPPER(COALESCE(to_jsonb(p)->>'group_name', to_jsonb(p)->>'package_group', to_jsonb(p)->>'package_code', '')) AS package_group
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id = $1
      AND COALESCE(us.status, '') = 'active'
      AND (us.end_at IS NULL OR us.end_at > NOW())
    ORDER BY us.end_at DESC NULLS LAST, us.id DESC
    LIMIT 1
  `,
    [userId]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row) return 0;
  const group = String(row.package_group || '').toUpperCase();
  const cap = packagePortCapForGroup(group, row.max_ports);
  const groupUpper = group;
  const extras = await query(
    `
    SELECT qty, port_type, package_group,
           CASE WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN TRUE ELSE FALSE END AS is_expired
    FROM vps_system.mt5_extra_ports
    WHERE user_id=$1
      AND is_active=TRUE
      AND (
        (port_type='temporary' AND (expires_at IS NULL OR expires_at > NOW()))
        OR (port_type='permanent' AND (
          $2 = ''
          OR UPPER(COALESCE(package_group,'')) = $2
          OR TRIM(COALESCE(package_group,'')) = ''
        ))
      )
  `,
    [userId, groupUpper]
  ).catch(() => ({ rows: [] }));

  return computePortEntitlement(cap, extras.rows || [], group).totalPorts;
}

async function clearExpiredLocks() {
  await query(`
    UPDATE vps_system.vps_ports
    SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
    WHERE status='locked'
      AND locked_until IS NOT NULL
      AND locked_until < NOW()
  `).catch(() => {});
}

const { findMt5LoginInUse, mt5LoginInUseMessage } = require('../lib/mt5LoginDuplicate');

/** จอง Folder PORT ตามช่องแพ็กเกจ (PORT 1 → VPS-WIN-01-PORT-01) */
async function reservePortForPackageSlot(userId, portSlot) {
  const slot = num(portSlot);
  if (!slot || slot < 1 || slot > 20) return { ok: false };

  await clearExpiredLocks();

  const portNos = [...new Set([slot, 100 + slot].filter((x) => x > 0))];
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `
      SELECT
        p.id AS port_id,
        p.vps_id,
        p.port_no,
        p.folder_path,
        COALESCE(n.node_code, '') AS node_code,
        COALESCE(n.cpu_percent, 0) AS cpu_percent,
        COALESCE(n.ram_percent, 0) AS ram_percent,
        COALESCE(n.ping_ms, 0) AS ping_ms
      FROM vps_system.vps_ports p
      JOIN vps_system.vps_nodes n ON n.id = p.vps_id
      WHERE p.port_no = ANY($1::int[])
        AND LOWER(COALESCE(p.status, 'available')) IN ('available', 'free', 'idle', 'failed')
        AND LOWER(COALESCE(p.status, '')) NOT IN ('disabled', 'off', 'deleted')
        AND COALESCE(n.agent_enabled, TRUE) = TRUE
        AND LOWER(COALESCE(n.status, '')) IN ('online', 'active', 'available', 'connected')
        AND (
          COALESCE(n.last_seen_at, n.last_heartbeat, n.updated_at) >
            NOW() - ($3::text || ' seconds')::interval
          OR EXISTS (
            SELECT 1 FROM vps_system.vps_port_health h
            WHERE h.node_id = n.id
              AND h.updated_at > NOW() - ($3::text || ' seconds')::interval
          )
        )
        AND COALESCE(n.cpu_percent, 0) <= COALESCE(n.max_cpu_percent, $4)
        AND COALESCE(n.ram_percent, 0) <= COALESCE(n.max_ram_percent, $5)
        AND COALESCE(n.ping_ms, 0) <= COALESCE(n.max_ping_ms, $6)
        AND NOT EXISTS (
          SELECT 1
          FROM vps_system.mt5_accounts a
          WHERE a.vps_id = p.vps_id
            AND a.assigned_port_no = p.port_no
            AND a.user_id <> $2
            AND LOWER(COALESCE(a.status, '')) IN ('connecting', 'checking', 'connected', 'starting')
        )
      ORDER BY CASE WHEN p.port_no >= 100 THEN 0 ELSE 1 END, p.port_no ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `,
      [portNos, userId, String(AGENT_LAST_SEEN_MAX_SEC), MAX_CPU, MAX_RAM, MAX_PING]
    );

    const port = r.rows?.[0];
    if (!port) {
      await client.query('ROLLBACK');
      return { ok: false };
    }

    await client.query(
      `
      UPDATE vps_system.vps_ports
      SET status='locked',
          locked_by_user_id=$1,
          locked_until=NOW() + ($2::text || ' minutes')::interval,
          last_error=NULL,
          updated_at=NOW()
      WHERE id=$3
    `,
      [userId, PORT_LOCK_MINUTES, port.port_id]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      port: {
        ...port,
        port_number: slot,
        port_name: `PORT-${String(slot).padStart(2, '0')}`,
        source: 'package_slot'
      }
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function reserveBestPort(userId, preferredSlot = 0) {
  await clearExpiredLocks();

  const slotHint = num(preferredSlot);
  if (slotHint > 0) {
    const slotReserve = await reservePortForPackageSlot(userId, slotHint);
    if (slotReserve.ok) return slotReserve;
  }

  const adminReserve = await reserveAdminPortForLogin(userId);
  if (adminReserve.ok) return adminReserve;

  const client = await getClient();

  try {
    await client.query('BEGIN');

    const r = await client.query(
      `
      SELECT
        p.id AS port_id,
        p.vps_id,
        p.port_no,
        p.folder_path,
        COALESCE(n.node_code,'') AS node_code,
        COALESCE(n.cpu_percent,0) AS cpu_percent,
        COALESCE(n.ram_percent,0) AS ram_percent,
        COALESCE(n.ping_ms,0) AS ping_ms
      FROM vps_system.vps_ports p
      JOIN vps_system.vps_nodes n ON n.id=p.vps_id
      WHERE LOWER(COALESCE(p.status,'available')) IN ('available','free','idle')
        AND LOWER(COALESCE(p.status,'')) NOT IN ('disabled','off','deleted')
        AND COALESCE(n.agent_enabled, TRUE)=TRUE
        AND LOWER(COALESCE(n.status,'')) IN ('online','active','available','connected')
        AND (
          COALESCE(n.last_seen_at, n.last_heartbeat, n.updated_at, NOW() - INTERVAL '10 minutes') >
            NOW() - ($4::text || ' seconds')::interval
          OR EXISTS (
            SELECT 1 FROM vps_system.vps_port_health h
            WHERE h.node_id = n.id
              AND h.updated_at > NOW() - ($4::text || ' seconds')::interval
          )
        )
        AND COALESCE(n.cpu_percent,0) <= COALESCE(n.max_cpu_percent, $1)
        AND COALESCE(n.ram_percent,0) <= COALESCE(n.max_ram_percent, $2)
        AND COALESCE(n.ping_ms,0) <= COALESCE(n.max_ping_ms, $3)
        AND NOT EXISTS (
          SELECT 1
          FROM vps_system.mt5_accounts a
          WHERE a.vps_id=p.vps_id
            AND a.assigned_port_no=p.port_no
            AND LOWER(COALESCE(a.status,'')) IN ('connecting','checking','connected','ready')
        )
      ORDER BY
        COALESCE(n.cpu_percent,0) ASC,
        COALESCE(n.ram_percent,0) ASC,
        COALESCE(n.ping_ms,0) ASC,
        p.vps_id ASC,
        p.port_no ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `,
      [MAX_CPU, MAX_RAM, MAX_PING, String(AGENT_LAST_SEEN_MAX_SEC)]
    );

    const port = r.rows?.[0];
    if (!port) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        message:
          adminReserve.message ||
          'ไม่มี VPS/PORT ว่าง — ตรวจสอบ /admin/vps/ports (ข้าม PORT ใช้งาน/ปิด) และ /admin/vps/edit (CPU/RAM/PING)'
      };
    }

    await client.query(`
      UPDATE vps_system.vps_ports
      SET status='locked',
          locked_by_user_id=$1,
          locked_until=NOW() + ($2::text || ' minutes')::interval,
          last_error=NULL,
          updated_at=NOW()
      WHERE id=$3
    `, [userId, PORT_LOCK_MINUTES, port.port_id]);

    await client.query('COMMIT');
    return { ok: true, port };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function cancelPendingLoginCommands({ portId, accountId, mt5Login } = {}) {
  if (!mt5Login && !accountId && !portId) return;
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET
      status = 'cancelled',
      result_message = 'ยกเลิกเพราะมีคำสั่ง login ใหม่ (รหัสผ่านล่าสุด)',
      updated_at = NOW(),
      finished_at = COALESCE(finished_at, NOW())
    WHERE command_type IN ('login_mt5', 'connect_mt5', 'run_mt5_bot', 'run_mt5')
      AND status IN ('pending', 'processing', 'picked')
      AND (
        ($1::bigint IS NOT NULL AND port_id = $1)
        OR ($2::bigint IS NOT NULL AND (payload->>'accountId')::bigint = $2)
        OR ($3::text IS NOT NULL AND TRIM(payload->>'mt5Login') = $3)
      )
  `,
    [portId || null, accountId || null, mt5Login || null]
  ).catch(() => {});
}

async function findRetryPortForLogin(userId, mt5Login, serverName) {
  const r = await query(
    `
    SELECT
      a.id AS account_id,
      a.port_id,
      a.vps_id,
      a.assigned_port_no AS port_no,
      a.port_slot,
      p.folder_path
    FROM vps_system.mt5_accounts a
    JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id = $1
      AND a.mt5_login = $2
      AND COALESCE(a.server_name, a.mt5_server, '') = $3
      AND LOWER(COALESCE(a.status, '')) IN ('failed', 'deleted', 'connecting', 'starting', 'checking')
    ORDER BY a.updated_at DESC
    LIMIT 1
  `,
    [userId, mt5Login, serverName]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row?.port_id || !row.folder_path) return null;

  await clearExpiredLocks();
  await query(
    `
    UPDATE vps_system.vps_ports
    SET
      status = 'locked',
      locked_by_user_id = $1,
      locked_until = NOW() + ($2::text || ' minutes')::interval,
      last_error = NULL,
      updated_at = NOW()
    WHERE id = $3
      AND LOWER(COALESCE(status, '')) IN ('available', 'free', 'idle', 'failed')
  `,
    [userId, PORT_LOCK_MINUTES, row.port_id]
  ).catch(() => {});

  return {
    port_id: row.port_id,
    vps_id: row.vps_id,
    port_no: row.port_no,
    port_slot: row.port_slot,
    folder_path: row.folder_path,
    account_id: row.account_id
  };
}

/** ปล่อยแถว mt5_accounts ที่ค้างบน vps+port เดียวกัน (กัน uq_mt5_running_vps_port ตอน INSERT) */
async function releaseStaleVpsPortAccounts(vpsId, portNo, keepAccountId = null) {
  if (!vpsId || !portNo) return;
  const params = [vpsId, portNo];
  let sql = `
    UPDATE vps_system.mt5_accounts
    SET status='expired',
        assigned_port_no=NULL,
        windows_port_no=NULL,
        vps_id=NULL,
        port_id=NULL,
        last_login_message='ถูกแทนที่ด้วยการเชื่อมต่อใหม่',
        updated_at=NOW()
    WHERE vps_id=$1
      AND assigned_port_no=$2
      AND LOWER(COALESCE(status, '')) IN ('connecting', 'checking', 'starting')
  `;
  if (keepAccountId) {
    params.push(keepAccountId);
    sql += ` AND id <> $3`;
  }
  await query(sql, params).catch(() => {});
}

async function releasePort(portId, message = '') {
  if (!portId) return;
  await query(`
    UPDATE vps_system.vps_ports
    SET status='available',
        locked_by_user_id=NULL,
        locked_until=NULL,
        process_id=NULL,
        mt5_login=NULL,
        last_error=$2,
        updated_at=NOW()
    WHERE id=$1
  `, [portId, message || null]).catch(() => {});
}

const USER_PORT_SLOT_BUSY_STATUSES = [
  'connecting',
  'checking',
  'connected',
  'ready',
  'starting'
];

async function isUserPortSlotAvailable(userId, slot, totalPorts) {
  const s = num(slot);
  const max = num(totalPorts);
  if (s < 1 || s > max) return false;
  const r = await query(
    `
    SELECT 1
    FROM vps_system.mt5_accounts
    WHERE user_id=$1
      AND port_slot=$2
      AND LOWER(COALESCE(status, '')) = ANY($3::text[])
    LIMIT 1
  `,
    [userId, s, USER_PORT_SLOT_BUSY_STATUSES]
  ).catch(() => ({ rows: [] }));
  return !(r.rows || []).length;
}

/** เลือก PORT แพ็กเกจว่าง + โฟลเดอร์ VPS ตรง slot (เหมือน /admin/vps/ports) */
async function pickBestPackageSlotForConnect(userId, totalPorts, preferredSlot = 0) {
  const pref = num(preferredSlot);
  const { nodes, folderPorts } = await listAllFolderPortsForConnect().catch(() => ({
    nodes: [],
    folderPorts: []
  }));

  async function slotOk(slot) {
    if (slot < 1 || slot > totalPorts) return false;
    if (!(await isUserPortSlotAvailable(userId, slot, totalPorts))) return false;
    const folder = pickFolderPortForSlot(folderPorts, slot, nodes);
    if (folder && folder.available === false && folder.running) return false;
    return true;
  }

  if (pref > 0 && (await slotOk(pref))) return pref;
  for (let i = 1; i <= totalPorts; i++) {
    if (await slotOk(i)) return i;
  }
  return getNextUserSlot(userId, totalPorts);
}

async function getNextUserSlot(userId, totalPorts) {
  const used = await query(
    `
    SELECT port_slot
    FROM vps_system.mt5_accounts
    WHERE user_id=$1
      AND port_slot IS NOT NULL
      AND LOWER(COALESCE(status, '')) = ANY($2::text[])
  `,
    [userId, USER_PORT_SLOT_BUSY_STATUSES]
  );

  const set = new Set((used.rows || []).map((r) => num(r.port_slot)));
  for (let i = 1; i <= totalPorts; i++) {
    if (!set.has(i)) return i;
  }
  return 0;
}

async function resolveVpsAgentOnline(vpsId) {
  const vid = num(vpsId);
  if (!vid) return { agentOnline: null, agentMessage: '' };
  const r = await query(
    `
    SELECT
      COALESCE(agent_enabled, TRUE) AS agent_enabled,
      GREATEST(
        COALESCE(last_seen_at, 'epoch'::timestamptz),
        COALESCE(last_heartbeat, 'epoch'::timestamptz),
        COALESCE(updated_at, 'epoch'::timestamptz)
      ) AS last_seen
    FROM vps_system.vps_nodes
    WHERE id = $1
    LIMIT 1
  `,
    [vid]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return { agentOnline: false, agentMessage: 'ไม่พบ VPS — ตรวจ /admin/vps' };
  if (row.agent_enabled === false) {
    return { agentOnline: false, agentMessage: 'Agent ปิดอยู่บน VPS นี้' };
  }
  const lastMs = row.last_seen ? new Date(row.last_seen).getTime() : 0;
  const ageSec = lastMs ? Math.floor((Date.now() - lastMs) / 1000) : null;
  const online = ageSec != null && ageSec <= AGENT_LAST_SEEN_MAX_SEC;
  return {
    agentOnline: online,
    agentMessage: online
      ? 'Agent ทำงาน'
      : `Agent ไม่ตอบสนอง${ageSec != null ? ' (' + ageSec + ' วิ)' : ''} — ตรวจ /admin/vps`
  };
}

async function resolveLoginCommandMeta(accountId, vpsId) {
  const aid = num(accountId);
  const vid = num(vpsId);
  if (!aid || !vid) return {};
  const inProg = await findLoginCommandInProgress(aid, vid);
  const recent = inProg ? null : await findRecentLoginCommand(aid, vid);
  const cmd = inProg || recent;
  if (!cmd) return {};
  const st = String(cmd.status || '').toLowerCase();
  const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
  let commandMessage = String(cmd.error || res.message || res.error || '').trim();
  if (!commandMessage && st === 'failed') commandMessage = 'คำสั่ง login_mt5 ล้มเหลว';
  const loginHint = String(
    cmd.payload?.mt5Login || cmd.payload?.login || res.login || ''
  ).trim();
  const resolvedCmd = resolveLoginFailUserMessage({
    login: loginHint,
    evidence: extractJournalEvidence(res.journalEvidence, res.journal_evidence, res.message, commandMessage),
    rawMessage: commandMessage,
    cmdError: commandMessage
  });
  if (['failed', 'error', 'cancelled'].includes(st)) {
    commandMessage = resolvedCmd.message || commandMessage;
  }
  return {
    commandId: cmd.id,
    commandStatus: st,
    commandMessage
  };
}

function deriveConnectProgress(statusFinal, cmdSt, previewUrl, connected) {
  const progressTotal = 4;
  if (connected || statusFinal === 'connected') {
    return {
      progressStep: progressTotal,
      progressTotal,
      progressStepLabel: 'เชื่อมต่อสำเร็จ',
      connectStep: '④ Login สำเร็จ — พร้อมขั้นตอน 3 เปิด BOT'
    };
  }
  if (statusFinal === 'failed') {
    return {
      progressStep: 3,
      progressTotal,
      progressStepLabel: 'Login ไม่สำเร็จ',
      connectStep: '④ Login ไม่สำเร็จ'
    };
  }
  if (statusFinal === 'checking') {
    return {
      progressStep: 3,
      progressTotal,
      progressStepLabel: 'ตรวจ Journal',
      connectStep: '④ กำลังตรวจ Login จาก Journal MT5...'
    };
  }
  if (statusFinal === 'starting' || previewUrl) {
    return {
      progressStep: 2,
      progressTotal,
      progressStepLabel: 'เปิด MT5',
      connectStep: '③ เปิด MT5 บน VPS...'
    };
  }
  if (cmdSt === 'running') {
    return {
      progressStep: 2,
      progressTotal,
      progressStepLabel: 'Login MT5',
      connectStep: '③ Agent กำลัง Login MT5...'
    };
  }
  if (['processing', 'picked'].includes(cmdSt)) {
    return {
      progressStep: 1,
      progressTotal,
      progressStepLabel: 'Agent รับงาน',
      connectStep: '② Agent รับคำสั่งแล้ว'
    };
  }
  if (cmdSt === 'pending') {
    return {
      progressStep: 1,
      progressTotal,
      progressStepLabel: 'รอ Agent',
      connectStep: '② รอ Agent รับคำสั่ง login_mt5...'
    };
  }
  if (['failed', 'error', 'cancelled'].includes(cmdSt)) {
    return {
      progressStep: 3,
      progressTotal,
      progressStepLabel: 'คำสั่งล้มเหลว',
      connectStep: 'Login ไม่สำเร็จ (คำสั่ง VPS)'
    };
  }
  if (statusFinal === 'connecting') {
    return {
      progressStep: 0,
      progressTotal,
      progressStepLabel: 'ส่งคำสั่ง',
      connectStep: '① ส่งคำสั่ง login_mt5 แล้ว — รอ VPS'
    };
  }
  return {
    progressStep: 0,
    progressTotal,
    progressStepLabel: 'ส่งคำสั่ง',
    connectStep: '① กำลังเชื่อมต่อ...'
  };
}

async function handleMt5ConnectProduction(req, res) {
  let lockKey = null;
  let loginLockKey = null;
  let reservedPort = null;

  try {
    await ensureRuntimeColumns();

    const userId = req.user.id;
    const loginRaw = clean(req.body.mt5_login || req.body.mt5Login);
    const fmt = validateMt5LoginFormat(loginRaw);
    if (!fmt.ok) {
      return respondConnectFailed(res, req, fmt.message || 'User ผิด');
    }
    const mt5Login = fmt.normalized;
    const mt5Password = clean(req.body.mt5_password || req.body.mt5Password);
    const serverName = resolveServerForLogin(mt5Login);

    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');

    const uiPreferredSlotEarly = num(
      req.body.port_slot || req.body.portSlot || req.body.ui_port_hint || req.body.uiPortHint
    );
    lockKey = userLockKey(userId, uiPreferredSlotEarly);
    const locked = await redis.set(lockKey, '1', 'NX', 'EX', USER_LOCK_TTL);
    if (!locked) {
      const slotHint = uiPreferredSlotEarly > 0 ? ` PORT ${uiPreferredSlotEarly}` : '';
      throw new Error(`ระบบกำลังเชื่อมต่อ${slotHint} อยู่ กรุณารอสักครู่ หรือกดยกเลิกแล้วลองใหม่`);
    }

    loginLockKey = mt5LoginLockKey(mt5Login, serverName);
    const loginLocked = await redis.set(loginLockKey, '1', 'NX', 'EX', USER_LOCK_TTL);
    if (!loginLocked) throw new Error('บัญชี MT5 นี้กำลังถูกเชื่อมต่ออยู่ กรุณารอสักครู่');

    const totalPorts = await getUserPackagePortLimit(userId);
    if (totalPorts <= 0) {
      const { cleanupUserOnPackageExpired } = require('../lib/mt5PackageExpire');
      await cleanupUserOnPackageExpired(userId, 'package_expired_connect_blocked').catch(() => {});
      throw new Error('แพ็คเกจหมดอายุ กรุณาต่ออายุแพ็กเกจก่อนเชื่อมต่อ MT5');
    }

    const usedCountRes = await query(
      `
      SELECT COUNT(*)::int AS c
      FROM vps_system.mt5_accounts
      WHERE user_id = $1
        AND port_slot IS NOT NULL
        AND LOWER(COALESCE(status, '')) = ANY($2::text[])
    `,
      [userId, USER_PORT_SLOT_BUSY_STATUSES]
    ).catch(() => ({ rows: [{ c: 0 }] }));
    const usedPorts = Number(usedCountRes.rows?.[0]?.c || 0);

    const duplicate = await findMt5LoginInUse(mt5Login, serverName, userId);
    if (duplicate) {
      throw new Error(mt5LoginInUseMessage(duplicate));
    }

    await cancelPendingLoginCommands({ mt5Login });

    const uiPreferredSlot = num(
      req.body.port_slot || req.body.portSlot || req.body.ui_port_hint || req.body.uiPortHint
    );
    const retryPort = await findRetryPortForLogin(userId, mt5Login, serverName);
    let portSlot = 0;

    if (retryPort) {
      portSlot = Number(retryPort.port_slot) || 0;
      if (!portSlot || !(await isUserPortSlotAvailable(userId, portSlot, totalPorts))) {
        portSlot = await getNextUserSlot(userId, totalPorts);
      }
      if (!portSlot) {
        throw new Error(`PORT ตามแพ็กเกจเต็มแล้ว (${usedPorts}/${totalPorts})`);
      }
      reservedPort = {
        port_id: retryPort.port_id,
        vps_id: retryPort.vps_id,
        port_no: retryPort.port_no,
        folder_path: retryPort.folder_path,
        port_slot: portSlot
      };
      await cancelPendingLoginCommands({
        portId: retryPort.port_id,
        accountId: retryPort.account_id,
        mt5Login
      });
    } else {
      const existRes = await query(
        `
        SELECT a.id, a.port_slot, a.port_id, a.vps_id, a.assigned_port_no, p.folder_path, p.port_no
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.user_id = $1
          AND a.mt5_login = $2
          AND COALESCE(a.server_name, a.mt5_server, '') = $3
          AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired')
        ORDER BY a.id DESC
        LIMIT 1
      `,
        [userId, mt5Login, serverName]
      ).catch(() => ({ rows: [] }));

      const exist = existRes.rows?.[0];
      if (exist?.port_slot) {
        portSlot = Number(exist.port_slot);
      } else {
        portSlot = await pickBestPackageSlotForConnect(
          userId,
          totalPorts,
          uiPreferredSlot > 0 ? uiPreferredSlot : 0
        );
      }

      if (!portSlot) {
        throw new Error(`PORT ตามแพ็กเกจเต็มแล้ว (${usedPorts}/${totalPorts})`);
      }

      if (exist?.port_id && exist?.vps_id && exist?.folder_path) {
        reservedPort = {
          port_id: exist.port_id,
          vps_id: exist.vps_id,
          port_no: exist.assigned_port_no || exist.port_no,
          folder_path: exist.folder_path
        };
        await query(
          `
          UPDATE vps_system.vps_ports
          SET status='locked',
              locked_by_user_id=$1,
              locked_until=NOW() + ($2::text || ' minutes')::interval,
              last_error=NULL,
              updated_at=NOW()
          WHERE id=$3
        `,
          [userId, PORT_LOCK_MINUTES, exist.port_id]
        ).catch(() => {});
      } else {
        const reserve = await reserveBestPort(userId, uiPreferredSlot || portSlot);
        if (!reserve.ok) throw new Error(reserve.message);
        reservedPort = reserve.port;
      }
    }

    const allocPortNo = num(
      reservedPort.port_number || parsePortNumber(reservedPort) || portSlot
    );

    // ไม่พึ่ง ON CONFLICT เพราะฐานข้อมูลเดิมบางชุดอาจยังไม่มี unique constraint ครบ
    // ใช้วิธี UPDATE ก่อน ถ้าไม่มีค่อย INSERT เพื่อไม่ให้ deploy แล้วล้ม
    let acc = await query(`
      UPDATE vps_system.mt5_accounts
      SET
        vps_id=$2,
        port_id=$3,
        port_slot=$4,
        assigned_port_no=$5,
        windows_port_no=$5,
        mt5_password=$7,
        broker='MH Markets',
        server_name=$8,
        account_name=$9,
        status='connecting',
        last_error=NULL,
        last_login_message='กำลังเปิด MT5 และ Login...',
        updated_at=NOW()
      WHERE user_id=$1
        AND mt5_login=$6
        AND COALESCE(server_name, mt5_server, '')=$8
        AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
      RETURNING id
    `, [
      userId,
      reservedPort.vps_id,
      reservedPort.port_id,
      portSlot,
      allocPortNo,
      mt5Login,
      mt5Password,
      serverName,
      `PORT ${portSlot}`
    ]);

    const keepId = acc.rows?.[0]?.id || null;
    await releaseStaleVpsPortAccounts(reservedPort.vps_id, allocPortNo, keepId);

    if (!acc.rows?.[0]) {
      acc = await query(`
        INSERT INTO vps_system.mt5_accounts
        (user_id, vps_id, port_id, port_slot, assigned_port_no, windows_port_no,
         mt5_login, mt5_password, broker, server_name, mt5_server, account_name, status,
         last_error, last_login_message, updated_at)
        VALUES
        ($1,$2,$3,$4,$5,$5,$6,$7,'MH Markets',$8,$8,$9,'connecting',NULL,'กำลังเปิด MT5 และ Login...',NOW())
        RETURNING id
      `, [
        userId,
        reservedPort.vps_id,
        reservedPort.port_id,
        portSlot,
        allocPortNo,
        mt5Login,
        mt5Password,
        serverName,
        `PORT ${portSlot}`
      ]).catch(async (insErr) => {
        if (insErr?.code !== '23505') throw insErr;
        await releaseStaleVpsPortAccounts(reservedPort.vps_id, allocPortNo, null);
        return query(`
          UPDATE vps_system.mt5_accounts
          SET
            vps_id=$2,
            port_id=$3,
            port_slot=$4,
            assigned_port_no=$5,
            windows_port_no=$5,
            mt5_password=$7,
            broker='MH Markets',
            server_name=$8,
            account_name=$9,
            status='connecting',
            last_error=NULL,
            last_login_message='กำลังเปิด MT5 และ Login...',
            updated_at=NOW()
          WHERE user_id=$1
            AND mt5_login=$6
            AND COALESCE(server_name, mt5_server, '')=$8
            AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
          RETURNING id
        `, [
          userId,
          reservedPort.vps_id,
          reservedPort.port_id,
          portSlot,
          allocPortNo,
          mt5Login,
          mt5Password,
          serverName,
          `PORT ${portSlot}`
        ]);
      });
    }

    if (!acc.rows?.[0]) {
      acc = await query(
        `
        UPDATE vps_system.mt5_accounts
        SET
          vps_id=$2,
          port_id=$3,
          port_slot=$4,
          assigned_port_no=$5,
          windows_port_no=$5,
          mt5_password=$7,
          broker='MH Markets',
          server_name=$8,
          account_name=$9,
          status='connecting',
          last_error=NULL,
          last_login_message='กำลังเปิด MT5 และ Login...',
          updated_at=NOW()
        WHERE user_id=$1
          AND mt5_login=$6
          AND COALESCE(server_name, mt5_server, '')=$8
          AND LOWER(TRIM(COALESCE(status, ''))) IN ('deleted', 'expired', 'failed', 'ready', 'cancelled')
        RETURNING id
      `,
        [
          userId,
          reservedPort.vps_id,
          reservedPort.port_id,
          portSlot,
          allocPortNo,
          mt5Login,
          mt5Password,
          serverName,
          `PORT ${portSlot}`
        ]
      ).catch(() => ({ rows: [] }));
    }

    const accountId = acc.rows[0].id;
    await clearOtherAccountsOnPortSlot(query, userId, portSlot, accountId);

    await expireStuckMaintenanceCommands(reservedPort.vps_id).catch(() => {});
    await deferMaintenanceForLogin(reservedPort.vps_id).catch(() => {});

    if (reservedPort.admin_node_id && allocPortNo) {
      await setAdminAllocationStatus(
        reservedPort.admin_node_id,
        allocPortNo,
        'locked',
        reservedPort.allocation_id
      ).catch(() => {});
    }

    const activeOnVps = await countActiveLoginsOnVps(reservedPort.vps_id);
    const journalTimeoutSec = computeJournalTimeoutSec({
      totalPorts,
      activeLoginCount: activeOnVps,
      portSlot
    });
    const queueDelay = await computeLoginQueueDelaySec(reservedPort.vps_id, accountId);

    const payload = buildMt5LoginPayload({
      accountId,
      userId,
      reservedPort,
      portSlot,
      mt5Login,
      mt5Password,
      serverName,
      journalTimeoutSec,
      loginQueueDelaySec: queueDelay
    });

    const queued = await insertPendingAgentCommand({
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      commandType: 'login_mt5',
      payload
    });

    await query(`
      INSERT INTO vps_system.mt5_login_history
      (user_id, account_id, vps_id, port_id, port_no, mt5_login, server_name, status, message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','ส่งคำสั่ง login_mt5 แล้ว')
    `, [userId, accountId, reservedPort.vps_id, reservedPort.port_id, allocPortNo, mt5Login, serverName]).catch(() => {});

    const portLabel = String(allocPortNo || portSlot).padStart(2, '0');
    const pickName = reservedPort.node_name
      ? `${reservedPort.node_name} / ${reservedPort.port_name || 'PORT-' + portLabel}`
      : `PORT ${portLabel}`;

    return respondConnectQueued(res, req, {
      ok: true,
      status: 'queued',
      accountId,
      commandId: queued.id || null,
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      portNo: allocPortNo,
      portSlot,
      connectStep: '① ส่งคำสั่งแล้ว — รอ Agent รับงาน',
      commandStatus: 'pending',
      progressStep: 0,
      progressStepLabel: 'ส่งคำสั่ง',
      progressTotal: 4,
      message: `กำลังเปิด MT5 — แพ็กเกจ PORT ${portSlot} / ${pickName} (${serverName})`
    });
  } catch (e) {
    if (reservedPort?.port_id) await releasePort(reservedPort.port_id, e.message);
    return respondConnectFailed(res, req, e.message);
  } finally {
    if (loginLockKey) await redis.del(loginLockKey).catch(() => {});
    if (lockKey) await redis.del(lockKey).catch(() => {});
  }
}

async function handleMt5ConnectStatusProduction(req, res) {
  try {
    await ensureRuntimeColumns();
    const userId = req.user.id;
    const accountId = num(req.query.accountId || req.query.account_id);

    const params = [userId];
    let where = `user_id=$1`;
    if (accountId) {
      params.push(accountId);
      where += ` AND id=$2`;
    }

    const r = await query(`
      SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
             a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
             p.folder_path
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE ${where.replace(/\buser_id\b/g, 'a.user_id').replace(/\bid\b/g, 'a.id')}
      ORDER BY
        CASE LOWER(COALESCE(a.status, ''))
          WHEN 'connecting' THEN 0
          WHEN 'starting' THEN 1
          WHEN 'checking' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'connected' THEN 4
          ELSE 5
        END,
        a.updated_at DESC NULLS LAST,
        a.id DESC
      LIMIT 1
    `, params);

    const a = r.rows?.[0];
    if (!a) return res.json({ ok: true, connected: false, status: 'none', message: 'ยังไม่มีรายการเชื่อมต่อ' });

    const updatedAt = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const staleMs = Date.now() - updatedAt;
    let status = String(a.status || '').toLowerCase();

    if (['deleted', 'expired'].includes(status)) {
      const { MT5_LOGIN_TIMEOUT_MSG } = require('../lib/mt5Server');
      const blob = String(a.last_error || a.last_login_message || '').trim();
      let userMsg = 'เชื่อมต่อไม่สำเร็จ — กรุณาเลือก PORT ว่างแล้วกดเชื่อมต่อใหม่';
      if (blob && !/^ว่าง$/i.test(blob)) {
        userMsg = /ทันเวลา|timeout/i.test(blob) ? MT5_LOGIN_TIMEOUT_MSG : blob;
      }
      return res.json({
        ok: true,
        account: { ...a, status: 'failed' },
        connected: false,
        failed: true,
        staleAccount: true,
        status: 'failed',
        loginVerified: false,
        message: userMsg
      });
    }
    const loginNum = String(a.mt5_login || '').trim();
    const msgBlobEarly = String(a.last_login_message || a.last_error || '');
    if (messageIndicatesLoginFailed(msgBlobEarly, loginNum)) {
      await failAccountFromJournal(a.id, a.port_id, MT5_FAIL_USER_MSG, {
        vpsId: a.vps_id,
        portNo: a.assigned_port_no,
        folderPath: a.folder_path,
        reason: 'poll_journal_failed'
      }).catch(() => {});
      status = 'failed';
      a.last_error = MT5_FAIL_USER_MSG;
      a.last_login_message = MT5_FAIL_USER_MSG;
    }
    const vpsVerRow = a.vps_id
      ? await query(`SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1`, [a.vps_id]).catch(() => ({ rows: [] }))
      : { rows: [] };
    const staleLimitMs = connectPollStaleLimitMs();

    if (['connecting', 'starting', 'checking'].includes(status) && staleMs > staleLimitMs) {
      const loginStillBusy = await hasLoginCommandInProgress(a.id, a.vps_id).catch(() => false);
      if (!loginStillBusy) {
        const staleMsg = 'หมดเวลารอการเชื่อมต่อ — กรุณากรอก Login แล้วกดเชื่อมต่อใหม่';
        await failAccountFromJournal(a.id, a.port_id, staleMsg, {
          vpsId: a.vps_id,
          portNo: a.assigned_port_no,
          folderPath: a.folder_path,
          reason: 'connect_poll_timeout',
          killMt5: false
        }).catch(() => {});
        status = 'failed';
        a.last_error = staleMsg;
        a.last_login_message = staleMsg;
      }
    }

    let statusFinal = status;
    const windowHint = isLegacyWindowVerifiedMessage(a.last_login_message || '');

    if (['connecting', 'starting', 'checking'].includes(statusFinal)) {
      const fastEarly = await tryFastConnectConfirm(a).catch(() => ({ resolved: false }));
      if (fastEarly.resolved) {
        statusFinal = fastEarly.status || statusFinal;
        if (fastEarly.message) {
          a.last_login_message = fastEarly.message;
          a.last_error = statusFinal === 'failed' ? fastEarly.message : null;
        }
        if (statusFinal === 'connected') {
          a.status = 'connected';
          a.last_error = null;
          a.last_login_message = fastEarly.message || MT5_SUCCESS_MSG;
        } else if (statusFinal === 'failed') {
          a.status = 'failed';
          a.last_error = fastEarly.message || a.last_error;
        }
      }
    }

    const shouldSyncJournal =
      ['connecting', 'starting', 'checking'].includes(statusFinal) && !windowHint;

    if (shouldSyncJournal) {
      await syncJournalFromLatestCommand(
        a.id,
        a.vps_id,
        a.mt5_login,
        a.folder_path,
        a.assigned_port_no
      ).catch(() => {});
      const freshRow = await query(`
        SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
               a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
               p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1 AND a.user_id=$2
        LIMIT 1
      `, [a.id, userId]).catch(() => ({ rows: [] }));
      if (freshRow.rows?.[0]) {
        Object.assign(a, freshRow.rows[0]);
        status = String(a.status || '').toLowerCase();
        statusFinal = status;
      }
    }

    const loginInMsg = String(a.mt5_login || '').trim();
    const msgBlob = String(a.last_login_message || '');
    const windowHintOk =
      windowHint &&
      loginInMsg &&
      (msgBlob.includes(loginInMsg) || /window verified|เชื่อมต่อสำเร็จ/i.test(msgBlob)) &&
      !messageIndicatesLoginFailed(msgBlob, loginInMsg);

    if (['connecting', 'starting', 'checking'].includes(statusFinal) && windowHintOk) {
      await promoteAccountConnected({
        accountId: a.id,
        portId: a.port_id,
        mt5Login: a.mt5_login,
        message: MT5_SUCCESS_MSG
      }).catch(() => {});
      statusFinal = 'connected';
      a.status = 'connected';
      a.last_login_message = MT5_SUCCESS_MSG;
    }

    if (
      ['connecting', 'starting', 'checking', 'connected'].includes(statusFinal) &&
      (statusFinal !== 'connected' || messageIndicatesLoginFailed(msgBlob, loginInMsg))
    ) {
      const resolved = await resolveStuckLoginAccount(a).catch(() => ({ resolved: false }));
      if (resolved.resolved) {
        statusFinal = resolved.status || statusFinal;
        if (resolved.message) {
          a.last_login_message = resolved.message;
          a.last_error = resolved.status === 'failed' ? resolved.message : null;
        }
        if (statusFinal === 'connected') {
          a.status = 'connected';
          a.last_error = null;
          a.last_login_message = resolved.message || MT5_SUCCESS_MSG;
        } else if (statusFinal === 'failed') {
          a.status = 'failed';
          a.last_error = resolved.message || a.last_error;
          a.last_login_message = resolved.message || a.last_login_message;
        }
      }
      statusFinal = String(a.status || statusFinal).toLowerCase();
    }

    const inProgress = statusFinal === 'connecting' || statusFinal === 'checking' || statusFinal === 'starting';
    const failedMsg = a.last_error || a.last_login_message || '';
    const elapsedSec = Math.max(0, Math.floor(staleMs / 1000));
    let userMessage = statusFinal === 'connected'
      ? MT5_SUCCESS_MSG
      : statusFinal === 'failed'
        ? (/ทันเวลา|timeout|cancelled:\s*journal|journal\s+login\s+failed/i.test(failedMsg)
            ? MT5_LOGIN_TIMEOUT_MSG
            : failedMsg || MT5_FAIL_USER_MSG)
        : (a.last_login_message || a.last_error || statusFinal);
    if (inProgress) {
      const upgradeHint = /อัปเดต Agent|รอ 2.?3 นาที|Restart-Service/i.test(
        String(a.last_login_message || '')
      );
      userMessage = upgradeHint
        ? `กำลังเปิด MT5 และ Login... (${elapsedSec} วินาที)`
        : (a.last_login_message || `กำลังเปิด MT5 และตรวจสอบ Login (${elapsedSec} วินาที)...`);
    }
    const loginVerified = statusFinal === 'connected';
    const previewPath = previewPublicPath(a.id);
    const previewUrl = previewPath ? `${previewPath}?t=${Date.now()}` : '';
    const cmdMeta = await resolveLoginCommandMeta(a.id, a.vps_id);
    const agentMeta = await resolveVpsAgentOnline(a.vps_id);
    const cmdSt = String(cmdMeta.commandStatus || '').toLowerCase();
    const progress = deriveConnectProgress(
      statusFinal,
      cmdSt,
      previewUrl,
      loginVerified
    );
    let connectStep = progress.connectStep;
    if (inProgress && !cmdMeta.commandId && elapsedSec >= 8) {
      connectStep = '① ส่งคำสั่งแล้ว — ยังไม่เห็นคำสั่งในคิว VPS';
    }
    if (inProgress && agentMeta.agentOnline === false && elapsedSec >= 20) {
      connectStep = '② VPS Agent ไม่ตอบสนอง — ตรวจ /admin/vps';
    }
    return res.json({
      ok: true,
      account: { ...a, status: statusFinal },
      connected: loginVerified,
      failed: statusFinal === 'failed',
      checking: inProgress,
      pending: inProgress,
      status: statusFinal,
      loginVerified,
      legacyReady: statusFinal === 'ready',
      message: userMessage,
      windowTitle: windowTitleFromMessage(a.last_login_message),
      previewUrl,
      elapsedSec,
      maxWaitSec: Math.floor(connectPollStaleLimitMs() / 1000),
      connectStep,
      progressStep: progress.progressStep,
      progressStepLabel: progress.progressStepLabel,
      progressTotal: progress.progressTotal,
      commandId: cmdMeta.commandId || null,
      commandStatus: cmdMeta.commandStatus || '',
      commandMessage: cmdMeta.commandMessage || '',
      agentOnline: agentMeta.agentOnline,
      agentMessage: agentMeta.agentMessage || ''
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
}

/** เชื่อมต่อทุกช่องแพ็กเกจที่มีบัญชี+รหัสผ่านในระบบ (คิว login ทีละช่องบน VPS) */
async function handleMt5ConnectAllPorts(req, res) {
  try {
    await ensureRuntimeColumns();
    const userId = req.user.id;
    const totalPorts = await getUserPackagePortLimit(userId);
    if (totalPorts <= 0) {
      throw new Error('แพ็คเกจหมดอายุ กรุณาต่ออายุก่อนเชื่อมต่อ');
    }

    const accRes = await query(
      `
      SELECT
        a.id,
        a.port_slot,
        a.mt5_login,
        a.mt5_password,
        a.status,
        a.port_id,
        a.vps_id,
        a.assigned_port_no,
        a.windows_port_no,
        COALESCE(a.server_name, a.mt5_server, '') AS server_name,
        COALESCE(p.folder_path, '') AS folder_path,
        p.port_no
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE a.user_id = $1
        AND LOWER(TRIM(COALESCE(a.status, ''))) NOT IN ('deleted', 'expired')
      ORDER BY a.id DESC
    `,
      [userId]
    ).catch(() => ({ rows: [] }));

    const results = [];
    let primaryVpsId = 0;

    for (let slot = 1; slot <= totalPorts; slot += 1) {
      const acc = pickAccountForPortSlot(accRes.rows || [], slot);
      if (!acc) {
        results.push({ portSlot: slot, skipped: true, reason: 'no_account' });
        continue;
      }
      const st = String(acc.status || '').toLowerCase();
      if (st === 'connected') {
        results.push({ portSlot: slot, skipped: true, reason: 'already_connected', login: acc.mt5_login });
        continue;
      }
      if (['connecting', 'checking', 'starting'].includes(st)) {
        results.push({ portSlot: slot, skipped: true, reason: 'in_progress', login: acc.mt5_login });
        continue;
      }
      const mt5Password = clean(acc.mt5_password);
      if (!mt5Password) {
        results.push({ portSlot: slot, skipped: true, reason: 'no_saved_password', login: acc.mt5_login });
        continue;
      }

      const mt5Login = String(acc.mt5_login || '').trim();
      const fmt = validateMt5LoginFormat(mt5Login);
      if (!fmt.ok) {
        results.push({ portSlot: slot, skipped: true, reason: 'invalid_login', login: mt5Login });
        continue;
      }
      const serverName = resolveServerForLogin(fmt.normalized);

      const dup = await findMt5LoginInUse(fmt.normalized, serverName, userId);
      if (dup) {
        results.push({ portSlot: slot, skipped: true, reason: 'login_in_use', login: fmt.normalized });
        continue;
      }

      const lockKey = userPortLockKey(userId, slot);
      const locked = await redis.set(lockKey, '1', 'NX', 'EX', USER_LOCK_TTL);
      if (!locked) {
        results.push({ portSlot: slot, skipped: true, reason: 'slot_busy' });
        continue;
      }

      try {
        let reservedPort = null;
        if (acc.port_id && acc.vps_id && acc.folder_path) {
          await query(
            `
            UPDATE vps_system.vps_ports
            SET status='locked',
                locked_by_user_id=$1,
                locked_until=NOW() + ($2::text || ' minutes')::interval,
                last_error=NULL,
                updated_at=NOW()
            WHERE id=$3
          `,
            [userId, PORT_LOCK_MINUTES, acc.port_id]
          ).catch(() => {});
          reservedPort = {
            port_id: acc.port_id,
            vps_id: acc.vps_id,
            port_no: acc.assigned_port_no || acc.port_no,
            folder_path: acc.folder_path,
            port_number: slot
          };
        } else {
          const reserve = await reserveBestPort(userId, slot);
          if (!reserve.ok) {
            results.push({ portSlot: slot, ok: false, message: reserve.message || 'ไม่มี PORT ว่าง' });
            continue;
          }
          reservedPort = reserve.port;
        }

        const allocPortNo = num(
          reservedPort.port_number || parsePortNumber(reservedPort) || slot
        );
        primaryVpsId = num(reservedPort.vps_id) || primaryVpsId;

        await cancelPendingLoginCommands({ accountId: acc.id, mt5Login: fmt.normalized });

        const upd = await query(
          `
          UPDATE vps_system.mt5_accounts
          SET
            vps_id=$2,
            port_id=$3,
            port_slot=$4,
            assigned_port_no=$5,
            windows_port_no=$5,
            mt5_password=$6,
            broker='MH Markets',
            server_name=$7,
            account_name=$8,
            status='connecting',
            last_error=NULL,
            last_login_message='คิวเชื่อมต่อทุก PORT...',
            connect_started_at=NOW(),
            updated_at=NOW()
          WHERE id=$1
          RETURNING id
        `,
          [
            acc.id,
            reservedPort.vps_id,
            reservedPort.port_id,
            slot,
            allocPortNo,
            mt5Password,
            serverName,
            `PORT ${slot}`
          ]
        ).catch(() => ({ rows: [] }));

        if (!upd.rows?.[0]) {
          results.push({ portSlot: slot, ok: false, message: 'อัปเดตบัญชีไม่สำเร็จ' });
          continue;
        }

        await clearOtherAccountsOnPortSlot(query, userId, slot, acc.id);

        const activeOnVps = await countActiveLoginsOnVps(reservedPort.vps_id);
        const journalTimeoutSec = computeJournalTimeoutSec({
          totalPorts,
          activeLoginCount: activeOnVps,
          portSlot: slot
        });
        const queueDelay = await computeLoginQueueDelaySec(reservedPort.vps_id, acc.id);

        const payload = buildMt5LoginPayload({
          accountId: acc.id,
          userId,
          reservedPort,
          portSlot: slot,
          mt5Login: fmt.normalized,
          mt5Password,
          serverName,
          journalTimeoutSec,
          loginQueueDelaySec: queueDelay
        });

        const queued = await insertPendingAgentCommand({
          vpsId: reservedPort.vps_id,
          portId: reservedPort.port_id,
          commandType: 'login_mt5',
          payload
        });

        results.push({
          portSlot: slot,
          ok: true,
          accountId: acc.id,
          commandId: queued.id || null,
          login: fmt.normalized,
          queueDelaySec: queueDelay,
          journalTimeoutSec
        });
      } finally {
        await redis.del(lockKey).catch(() => {});
      }
    }

    if (primaryVpsId) {
      await expireStuckMaintenanceCommands(primaryVpsId).catch(() => {});
      await deferMaintenanceForLogin(primaryVpsId).catch(() => {});
    }

    const queuedCount = results.filter((r) => r.ok).length;
    return res.json({
      ok: queuedCount > 0,
      status: queuedCount > 0 ? 'queued' : 'noop',
      totalPorts,
      queuedCount,
      results,
      message:
        queuedCount > 0
          ? `ส่งคำสั่ง Login ${queuedCount}/${totalPorts} ช่องแล้ว — Agent จะเปิดทีละช่อง (รอช่องละ ~30–120 วิ)`
          : 'ไม่มีช่องที่ต้องเชื่อมต่อ (เชื่อมต่อครบแล้ว หรือยังไม่มีรหัสผ่านในระบบ)'
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
}

// ใช้ได้ทั้ง endpoint ใหม่และ endpoint เดิมของหน้าเว็บ
router.post('/mt5/connect-production', requireLogin, handleMt5ConnectProduction);
router.post('/mt5/connect-all-ports', requireLogin, handleMt5ConnectAllPorts);
router.post('/mt5/connect', requireLogin, handleMt5ConnectProduction);
router.get('/mt5/connect-status-production', requireLogin, handleMt5ConnectStatusProduction);
router.get('/mt5/connect-status', requireLogin, handleMt5ConnectStatusProduction);

router.post('/mt5/force-stop-port', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const portSlot = num(req.body.port_slot || req.body.portSlot);
    if (!portSlot) {
      return res.json({ ok: false, message: 'กรุณาเลือก PORT ก่อน' });
    }
    const result = await forceStopPackagePortSlot(userId, portSlot, {
      reason: 'ui_force_stop_port'
    });
    return res.json({
      ok: result.ok !== false,
      message: result.message || 'ส่งคำสั่งปิด MT5 บน VPS แล้ว — รอ 5–15 วินาที',
      portSlot: result.portSlot || portSlot
    });
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (/queueForceStopMt5|releaseUserPortCompletely|is not a function/i.test(msg)) {
      return res.json({
        ok: false,
        message: 'ระบบปิด MT5 ชั่วคราวไม่พร้อม — กด Ctrl+F5 แล้วลองอีกครั้ง'
      });
    }
    return res.json({ ok: false, message: msg || 'ปิด MT5 ไม่สำเร็จ' });
  }
});

router.post('/mt5/cancel-connect', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const portSlot = num(req.body.port_slot || req.body.portSlot);
    const accountId = num(req.body.accountId || req.body.account_id);
    const cancelMsg = 'ยกเลิกแล้ว — PORT ว่าง กดเชื่อมต่อใหม่ได้';

    if (accountId) {
      const accR = await query(
        `
        SELECT a.id, a.vps_id, a.port_slot, a.assigned_port_no
        FROM vps_system.mt5_accounts a
        WHERE a.id = $1 AND a.user_id = $2
        LIMIT 1
      `,
        [accountId, userId]
      );
      const acc = accR.rows?.[0];
      if (acc) {
        await cancelAgentCommandsForAccount(accountId, acc.vps_id).catch(() => 0);
      }
    }

    if (portSlot > 0) {
      await releaseUserPackagePortSlot(userId, portSlot, {
        message: cancelMsg,
        reason: 'ui_cancel_connect'
      }).catch(() => {});
      await forceStopPackagePortSlot(userId, portSlot, {
        reason: 'ui_cancel_connect'
      }).catch(() => {});
    } else {
      return res.json({ ok: false, message: 'กรุณาเลือก PORT ก่อน' });
    }

    return res.json({ ok: true, message: cancelMsg, portSlot });
  } catch (e) {
    return res.json({ ok: false, message: e.message || 'ยกเลิกไม่สำเร็จ' });
  }
});

router.post('/mt5/connect-fail-cleanup', requireLogin, async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = num(req.body.accountId || req.body.account_id);
    const portSlot = num(req.body.portSlot || req.body.port_slot);
    const message = clean(req.body.message) || MT5_FAIL_USER_MSG;

    if (accountId) {
      const accR = await query(
        `
        SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.port_slot,
               COALESCE(p.folder_path, '') AS port_folder
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id = $1 AND a.user_id = $2
        LIMIT 1
      `,
        [accountId, userId]
      );
      const acc = accR.rows?.[0];
      if (acc) {
        const { failAccountFromJournal } = require('../lib/mt5LoginCommandVerify');
        await failAccountFromJournal(Number(acc.id), Number(acc.port_id || 0), message, {
          vpsId: acc.vps_id,
          portNo: acc.assigned_port_no || acc.port_slot,
          folderPath: acc.port_folder,
          reason: 'connect_fail_cleanup',
          killMt5: true,
          clearPackagePort: true,
          journalVerdict: 'failed',
          forceFailed: true
        }).catch(() => {});
      }
    }

    const slot = portSlot || 0;
    if (slot > 0) {
      await releaseUserPackagePortSlot(userId, slot, {
        message,
        reason: 'connect_fail_cleanup_ui'
      }).catch(() => {});
    }

    return res.json({ ok: true, message: 'เคลียร์ PORT แล้ว' });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

module.exports = router;
