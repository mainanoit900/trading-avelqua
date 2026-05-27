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
const { normalizeLockedServer, MT5_LOCKED_SERVER } = require('../lib/mt5Server');
const { expireStuckMaintenanceCommands } = require('../lib/agentDeploy');
const {
  reserveAdminPortForLogin,
  buildMt5LoginPayload
} = require('../lib/adminVpsPortPicker');
const { setAdminAllocationStatus, parsePortNumber } = require('../lib/adminVpsBridge');
const { clearOtherAccountsOnPortSlot } = require('../lib/mt5PortAccount');
const {
  createConnectAttempt,
  ensureMt5ConnectAttemptTables,
  finalizeAttemptFailed,
  getConnectStatusForUser
} = require('../lib/mt5ConnectAttempt');

const PUBLIC_CALLBACK_BASE = (process.env.AVELQUA_PUBLIC_URL || 'https://trading.avelqua.com').replace(/\/$/, '');

const router = express.Router();
const redis = new Redis(process.env.REDIS_URL || undefined);

const DEFAULT_SERVER = MT5_LOCKED_SERVER;
const USER_LOCK_TTL = Number(process.env.MT5_USER_LOCK_TTL || 45);
const PORT_LOCK_MINUTES = Number(process.env.MT5_PORT_LOCK_MINUTES || 3);
const MAX_CPU = Number(process.env.MT5_MAX_CPU || 85);
const MAX_RAM = Number(process.env.MT5_MAX_RAM || 85);
const MAX_PING = Number(process.env.MT5_MAX_PING || 350);

function clean(v) {
  return String(v || '').trim();
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isAllowedMt5LoginUser(login) {
  const value = clean(login);
  return /^2\d{8}$/.test(value) || /^8\d{7}$/.test(value);
}

function mt5LoginUserValidationMessage() {
  return 'Userไม่ถูกต้อง - ใช้ได้เฉพาะเลขขึ้นต้น 2 จำนวน 9 หลัก หรือขึ้นต้น 8 จำนวน 8 หลัก';
}

function positiveMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function hasFreshAccountMetrics(account) {
  return Boolean(positiveMoney(account?.last_equity) || positiveMoney(account?.last_balance));
}

function snapshotMetricsFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.snapshot && typeof result.snapshot === 'object') {
    const nested = snapshotMetricsFromResult(result.snapshot);
    if (nested && (nested.balance || nested.equity)) return nested;
  }
  const balance = positiveMoney(result.balance);
  const equity = positiveMoney(result.equity);
  if (!balance && !equity) return null;
  return { balance, equity };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyAccountMetrics(accountId, balance, equity) {
  const bal = positiveMoney(balance);
  const eq = positiveMoney(equity);
  if (!bal && !eq) return false;
  await query(`
    UPDATE vps_system.mt5_accounts
    SET last_balance=COALESCE($2::numeric, last_balance),
        last_equity=COALESCE($3::numeric, last_equity),
        updated_at=NOW()
    WHERE id=$1
  `, [accountId, bal, eq]).catch(() => {});
  return true;
}

async function ensureEquityOnConnect(account, userId) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  const portNo = Number(account?.assigned_port_no || account?.port_slot || 0);
  const portSlot = Number(account?.port_slot || portNo || 0);
  const folderPath = String(account?.folder_path || '').trim();
  const mt5Login = String(account?.mt5_login || '').trim();
  if (!accountId || !userId || !vpsId || !portNo || !folderPath) return false;

  const recent = await query(`
    SELECT id, result
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('account_snapshot', 'sync_mt5_account', 'read_account_metrics')
      AND COALESCE(payload->>'accountId', '') = $2
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '2 minutes'
    ORDER BY id DESC
    LIMIT 1
  `, [vpsId, String(accountId)]).catch(() => ({ rows: [] }));
  const recentMetrics = snapshotMetricsFromResult(recent.rows?.[0]?.result);
  if (recentMetrics && await applyAccountMetrics(accountId, recentMetrics.balance, recentMetrics.equity)) {
    return true;
  }

  const pending = await query(`
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('account_snapshot', 'sync_mt5_account', 'read_account_metrics')
      AND COALESCE(payload->>'accountId', '') = $2
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running')
      AND created_at > NOW() - INTERVAL '25 seconds'
    ORDER BY id DESC
    LIMIT 1
  `, [vpsId, String(accountId)]).catch(() => ({ rows: [] }));

  let cmdId = Number(pending.rows?.[0]?.id || 0);
  if (!cmdId) {
    const payload = {
      port: portNo,
      portNumber: portNo,
      portSlot,
      accountId,
      userId: Number(userId),
      mt5Login,
      vpsFolderPath: folderPath,
      folder_path: folderPath,
      purpose: 'equity_connect'
    };
    const ins = await query(`
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1, $1, 'account_snapshot', $2::jsonb, 'pending', NOW(), NOW())
      RETURNING id
    `, [vpsId, JSON.stringify(payload)]).catch(() => ({ rows: [] }));
    cmdId = Number(ins.rows?.[0]?.id || 0);
  }
  if (!cmdId) return false;

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const snapRow = await query(`
      SELECT status, result
      FROM vps_system.vps_agent_commands
      WHERE id=$1
      LIMIT 1
    `, [cmdId]).catch(() => ({ rows: [] }));
    const row = snapRow.rows?.[0];
    const status = String(row?.status || '').toLowerCase();
    if (status === 'success' || status === 'done') {
      const metrics = snapshotMetricsFromResult(row.result);
      if (metrics && await applyAccountMetrics(accountId, metrics.balance, metrics.equity)) {
        return true;
      }
      return false;
    }
    if (status === 'failed' || status === 'cancelled') return false;
    await waitMs(450);
  }
  return false;
}

function userLockKey(userId) {
  return `mt5:connect:user:${userId}`;
}

function mt5LoginLockKey(mt5Login, serverName) {
  return `mt5:connect:login:${String(serverName || '').toLowerCase()}:${String(mt5Login || '').trim()}`;
}

async function ensureRuntimeColumns() {
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

const {
  findMt5LoginInUse,
  mt5LoginInUseMessage
} = require('../lib/mt5LoginDuplicate');

async function reserveBestPort(userId) {
  await clearExpiredLocks();

  const adminReserve = await reserveAdminPortForLogin(userId);
  if (adminReserve.ok) return adminReserve;

  const client = await getClient();

  try {
    await client.query('BEGIN');

    const r = await client.query(`
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
        AND COALESCE(n.last_seen_at, n.updated_at, NOW() - INTERVAL '10 minutes') > NOW() - INTERVAL '60 seconds'
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
    `, [MAX_CPU, MAX_RAM, MAX_PING]);

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
      AND status IN ('pending', 'queued')
      AND (
        ($1::bigint IS NOT NULL AND port_id = $1)
        OR ($2::bigint IS NOT NULL AND (payload->>'accountId')::bigint = $2)
        OR ($3::text IS NOT NULL AND TRIM(payload->>'mt5Login') = $3)
      )
  `,
    [portId || null, accountId || null, mt5Login || null]
  ).catch(() => {});
}

async function findInFlightLoginCommand({ userId, mt5Login, serverName } = {}) {
  if (!userId || !mt5Login) return null;
  const r = await query(
    `
    SELECT
      id,
      status,
      payload->>'accountId' AS account_id,
      payload->>'portId' AS port_id,
      payload->>'portNo' AS port_no,
      payload->>'portSlot' AS port_slot,
      payload->>'vpsId' AS vps_id,
      payload->>'attemptId' AS attempt_id,
      payload->>'serverName' AS server_name
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('login_mt5', 'connect_mt5', 'run_mt5_bot', 'run_mt5')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'processing', 'picked', 'running')
      AND COALESCE(payload->>'userId', '') = $1::text
      AND TRIM(COALESCE(payload->>'mt5Login', '')) = $2
      AND ($3::text = '' OR COALESCE(payload->>'serverName', '') = $3)
      AND created_at > NOW() - INTERVAL '5 minutes'
    ORDER BY id DESC
    LIMIT 1
  `,
    [String(userId), String(mt5Login), String(serverName || '')]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
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
      AND LOWER(COALESCE(status, '')) IN ('connecting', 'checking', 'starting', 'connected', 'ready')
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

async function handleMt5ConnectProduction(req, res) {
  let lockKey = null;
  let loginLockKey = null;
  let reservedPort = null;
  let attemptId = null;

  try {
    await ensureRuntimeColumns();

    const userId = req.user.id;
    const mt5Login = clean(req.body.mt5_login || req.body.mt5Login);
    const mt5Password = clean(req.body.mt5_password || req.body.mt5Password);
    const serverName = normalizeLockedServer(clean(req.body.server_name || req.body.serverName));

    if (!mt5Login) throw new Error('กรุณากรอก Login MT5');
    if (!isAllowedMt5LoginUser(mt5Login)) throw new Error(mt5LoginUserValidationMessage());
    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');

    lockKey = userLockKey(userId);
    const locked = await redis.set(lockKey, '1', 'NX', 'EX', USER_LOCK_TTL);
    if (!locked) throw new Error('ระบบกำลังเชื่อมต่อบัญชีนี้อยู่ กรุณารอสักครู่');

    loginLockKey = mt5LoginLockKey(mt5Login, serverName);
    const loginLocked = await redis.set(loginLockKey, '1', 'NX', 'EX', USER_LOCK_TTL);
    if (!loginLocked) throw new Error('บัญชี MT5 นี้กำลังถูกเชื่อมต่ออยู่ กรุณารอสักครู่');

    const totalPorts = await getUserPackagePortLimit(userId);
    if (totalPorts <= 0) {
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

    const inFlight = await findInFlightLoginCommand({ userId, mt5Login, serverName });
    if (inFlight?.id) {
      return res.json({
        ok: true,
        status: 'queued',
        accountId: Number(inFlight.account_id || 0) || null,
        attemptId: String(inFlight.attempt_id || '').trim() || null,
        commandId: Number(inFlight.id || 0) || null,
        vpsId: Number(inFlight.vps_id || 0) || null,
        portId: Number(inFlight.port_id || 0) || null,
        portNo: Number(inFlight.port_no || 0) || null,
        portSlot: Number(inFlight.port_slot || 0) || null,
        message: 'ระบบกำลังเปิด MT5 อยู่ กรุณารอสักครู่...'
      });
    }

    await cancelPendingLoginCommands({ mt5Login });

    const requestedSlot = num(req.body.port_slot || req.body.portSlot);
    const retryPort = await findRetryPortForLogin(userId, mt5Login, serverName);
    let portSlot;

    if (requestedSlot > 0) {
      if (!(await isUserPortSlotAvailable(userId, requestedSlot, totalPorts))) {
        throw new Error(`PORT ${requestedSlot} ไม่ว่าง กรุณาเลือก PORT ที่ยังไม่ใช้งาน`);
      }
      portSlot = requestedSlot;
      const reserve = await reserveBestPort(userId);
      if (!reserve.ok) throw new Error(reserve.message);
      reservedPort = reserve.port;
    } else if (retryPort) {
      portSlot = Number(retryPort.port_slot) || 0;
      if (portSlot && !(await isUserPortSlotAvailable(userId, portSlot, totalPorts))) {
        portSlot = await getNextUserSlot(userId, totalPorts);
      }
      if (!portSlot) portSlot = await getNextUserSlot(userId, totalPorts);
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
      portSlot = await getNextUserSlot(userId, totalPorts);
      if (!portSlot) {
        throw new Error(`PORT ตามแพ็กเกจเต็มแล้ว (${usedPorts}/${totalPorts})`);
      }
      const reserve = await reserveBestPort(userId);
      if (!reserve.ok) throw new Error(reserve.message);
      reservedPort = reserve.port;
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
        last_balance=NULL,
        last_equity=NULL,
        connect_started_at=NOW(),
        updated_at=NOW()
      WHERE user_id=$1
        AND mt5_login=$6
        AND COALESCE(server_name, mt5_server, '')=$8
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
         last_error, last_login_message, last_balance, last_equity, connect_started_at, updated_at)
        VALUES
        ($1,$2,$3,$4,$5,$5,$6,$7,'MH Markets',$8,$8,$9,'connecting',NULL,'กำลังเปิด MT5 และ Login...',NULL,NULL,NOW(),NOW())
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
            last_balance=NULL,
            last_equity=NULL,
            connect_started_at=NOW(),
            updated_at=NOW()
          WHERE user_id=$1
            AND mt5_login=$6
            AND COALESCE(server_name, mt5_server, '')=$8
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

    const accountId = acc.rows[0].id;
    await clearOtherAccountsOnPortSlot(query, userId, portSlot, accountId);

    await expireStuckMaintenanceCommands(reservedPort.vps_id).catch(() => {});

    if (reservedPort.admin_node_id && allocPortNo) {
      await setAdminAllocationStatus(
        reservedPort.admin_node_id,
        allocPortNo,
        'locked',
        reservedPort.allocation_id
      ).catch(() => {});
    }

    attemptId = await createConnectAttempt({
      accountId,
      userId,
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      portSlot,
      assignedPortNo: allocPortNo,
      folderPath: reservedPort.folder_path,
      mt5Login,
      serverName
    });

    const payload = buildMt5LoginPayload({
      accountId,
      attemptId,
      userId,
      reservedPort,
      portSlot,
      mt5Login,
      mt5Password,
      serverName
    });

    const cmd = await query(`
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1,$1,$2,'login_mt5',$3::jsonb,'pending',NOW(),NOW())
      RETURNING id
    `, [reservedPort.vps_id, reservedPort.port_id, JSON.stringify(payload)]);
    if (attemptId && cmd.rows?.[0]?.id) {
      await query(`
        UPDATE vps_system.mt5_connect_attempts
        SET command_id=$2, updated_at=NOW()
        WHERE attempt_id=$1
      `, [attemptId, Number(cmd.rows[0].id)]).catch(() => {});
    }

    await query(`
      INSERT INTO vps_system.mt5_login_history
      (user_id, account_id, vps_id, port_id, port_no, mt5_login, server_name, status, message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','ส่งคำสั่ง login_mt5 แล้ว')
    `, [userId, accountId, reservedPort.vps_id, reservedPort.port_id, allocPortNo, mt5Login, serverName]).catch(() => {});

    const portLabel = String(allocPortNo || portSlot).padStart(2, '0');
    const pickName = reservedPort.node_name
      ? `${reservedPort.node_name} / ${reservedPort.port_name || 'PORT-' + portLabel}`
      : `PORT ${portLabel}`;

    return res.json({
      ok: true,
      status: 'queued',
      accountId,
      attemptId,
      commandId: cmd.rows?.[0]?.id || null,
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      portNo: allocPortNo,
      portSlot,
      message: `กำลังเปิด MT5 — ${pickName} (${serverName})`
    });
  } catch (e) {
    if (attemptId) {
      await finalizeAttemptFailed(
        { attempt_id: attemptId, account_id: null },
        e.message,
        { evidenceSource: 'connect_route_error' }
      ).catch(() => {});
    }
    if (reservedPort?.port_id) await releasePort(reservedPort.port_id, e.message);
    return res.json({ ok: false, status: 'failed', message: e.message });
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
    const data = await getConnectStatusForUser(userId, accountId).catch(() => null);
    if (!data) {
      return res.json({ ok: false, message: 'ไม่สามารถอ่านสถานะการเชื่อมต่อได้' });
    }
    return res.json(data);
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
}

// ใช้ได้ทั้ง endpoint ใหม่และ endpoint เดิมของหน้าเว็บ
router.post('/mt5/connect-production', requireLogin, handleMt5ConnectProduction);
router.post('/mt5/connect', requireLogin, handleMt5ConnectProduction);
router.get('/mt5/connect-status-production', requireLogin, handleMt5ConnectStatusProduction);
router.get('/mt5/connect-status', requireLogin, handleMt5ConnectStatusProduction);

module.exports = router;
