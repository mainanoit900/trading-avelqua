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
  isLegacyWindowVerifiedMessage,
  probeRecentLoginCommandFailed,
  findRecentTerminalLoginCommand,
  isPortMt5Running,
  verifyPortRunningLogin
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
  countRunningMt5OnVps,
  connectPollStaleLimitMs
} = require('../lib/mt5MultiPortLogin');
const { pickAccountForPortSlot } = require('../lib/mt5PortAccount');
const {
  reserveAdminPortForLogin,
  buildMt5LoginPayload
} = require('../lib/adminVpsPortPicker');
const {
  setAdminAllocationStatus,
  parsePortNumber,
  releaseUserPortCompletely,
  resolveSystemVpsId
} = require('../lib/adminVpsBridge');
const {
  clearOtherAccountsOnPortSlot,
  listAccountsToHandoffOnPortSlot,
  upsertAccountForPortSlot,
  expireDuplicatePortSlotRows
} = require('../lib/mt5PortAccount');
const { validateMt5LoginFormat } = require('../lib/mt5LoginFormat');
const {
  findLoginCommandInProgress,
  findLoginCommandForAttempt,
  findRecentLoginCommand,
  reconcileConnectedAccountLive,
  releaseUserPackagePortSlot,
  forceStopPackagePortSlot,
  tryFastConnectConfirm,
  tryFastJournalFail,
  expireStuckLoginVerify,
  verifyLoginFromCommand,
  extractJournalEvidence,
  hasLoginCommandInProgress,
  loginUsesEquityVerify,
  loginCommandNeedsEquityResult,
  queueEquityLoginVerify
} = require('../lib/mt5LoginCommandVerify');
const { cancelAgentCommandsForAccount } = require('../lib/vpsAgentCommandQueue');

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
const PORT_LOCK_MINUTES = Number(process.env.MT5_PORT_LOCK_MINUTES || 2);
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

function positiveMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hasVerifiedMt5Snapshot(account) {
  if (!account) return false;
  if (account.login_verified === true) return true;
  if (positiveMoney(account.last_balance) > 0) return true;
  if (positiveMoney(account.last_equity) > 0) return true;
  return false;
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
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS login_verified BOOLEAN DEFAULT FALSE`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ`).catch(() => {});
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
  findMt5LoginOnOtherUserPort,
  mt5LoginInUseMessage,
  mt5LoginOnOtherPortMessage
} = require('../lib/mt5LoginDuplicate');

async function reserveBestPort(userId, preferredSlot = 0) {
  await clearExpiredLocks();
  void preferredSlot;

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
      error = COALESCE(error, 'cancelled: new login attempt'),
      result_message = COALESCE(result_message, 'ยกเลิกเพราะมีคำสั่ง login ใหม่ (รหัสผ่านล่าสุด)'),
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

async function releasePreviousLoginBindingIfMoved(existingRow, reservedPort, allocPortNo) {
  if (!existingRow?.id || !reservedPort) return;
  const oldVpsId = num(existingRow.vps_id);
  const oldPortId = num(existingRow.port_id);
  const oldPortNo = num(
    existingRow.assigned_port_no || existingRow.windows_port_no || existingRow.port_no || existingRow.port_slot
  );
  const nextVpsId = num(reservedPort.vps_id);
  const nextPortId = num(reservedPort.port_id);
  const nextPortNo = num(allocPortNo || reservedPort.port_no || parsePortNumber(reservedPort));
  if (!oldVpsId || !oldPortNo) return;
  if (oldVpsId === nextVpsId && oldPortId === nextPortId && oldPortNo === nextPortNo) return;

  const { adminNodeId } = await resolveSystemVpsId(oldVpsId).catch(() => ({ adminNodeId: 0 }));
  await releaseUserPortCompletely({
    systemVpsId: oldVpsId,
    adminNodeId: adminNodeId || oldVpsId,
    portNo: oldPortNo,
    folderPath: existingRow.folder_path || '',
    portId: oldPortId || null,
    reason: 'rebind_login_new_port'
  }).catch(() => {});
}

/** ปล่อยแถว mt5_accounts ที่ค้างบน vps+port เดียวกัน (กัน uq_mt5_running_vps_port ตอน INSERT) */
async function releaseStaleVpsPortAccounts(vpsId, portNo, keepAccountId = null, opts = {}) {
  if (!vpsId || !portNo) return;
  const params = [vpsId, portNo];
  const statuses = opts.includeConnected
    ? ['connecting', 'checking', 'starting', 'connected', 'ready']
    : ['connecting', 'checking', 'starting'];
  let sql = `
    UPDATE vps_system.mt5_accounts
    SET status='expired',
        assigned_port_no=NULL,
        windows_port_no=NULL,
        vps_id=NULL,
        port_id=NULL,
        port_slot=NULL,
        last_login_message=$3,
        updated_at=NOW()
    WHERE vps_id=$1
      AND assigned_port_no=$2
      AND LOWER(COALESCE(status, '')) = ANY($4::text[])
  `;
  const msg = opts.message || 'ถูกแทนที่ด้วยการเชื่อมต่อใหม่';
  params.push(msg, statuses);
  if (keepAccountId) {
    params.push(keepAccountId);
    sql += ` AND id <> $${params.length}`;
  }
  await query(sql, params).catch(() => {});
}

const PORT_SWAP_HANDOFF_MSG = 'ถูกแทนที่ด้วย Login ใหม่บน PORT เดิม';

/** สลับบัญชี MT5 ใหม่ทับ port_slot เดิม — ไม่ต้องกดลบ PORT */
async function handoffPackagePortSlotForNewLogin(userId, portSlot, newLogin, serverName) {
  const uid = Number(userId || 0);
  const slot = Number(portSlot || 0);
  if (!uid || !slot) return { handoffCount: 0 };

  const botBusy = await query(
    `
    SELECT b.id
    FROM vps_system.bot_instances b
    JOIN vps_system.mt5_accounts a ON a.id = b.mt5_account_id
    WHERE b.user_id = $1
      AND a.port_slot = $2
      AND b.status IN ('running', 'pending', 'starting', 'restarting')
      AND NOT (
        a.mt5_login = $3
        AND COALESCE(a.server_name, a.mt5_server, '') = $4
      )
    LIMIT 1
  `,
    [uid, slot, String(newLogin || '').trim(), String(serverName || '').trim()]
  ).catch(() => ({ rows: [] }));

  if (botBusy.rows?.[0]) {
    throw new Error('PORT นี้กำลังรัน BOT อยู่ — กดหยุด BOT ก่อนสลับบัญชี MT5');
  }

  const toHandoff = await listAccountsToHandoffOnPortSlot(
    query,
    uid,
    slot,
    newLogin,
    serverName
  );

  const slotRow = await query(
    `
    SELECT id, mt5_login, vps_id, assigned_port_no, windows_port_no
    FROM vps_system.mt5_accounts
    WHERE user_id=$1
      AND port_slot=$2
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [uid, slot]
  ).catch(() => ({ rows: [] }));
  const canonical = slotRow.rows?.[0];
  const loginChanged =
    canonical &&
    String(canonical.mt5_login || '').trim() !== String(newLogin || '').trim();

  if (loginChanged || toHandoff.length) {
    await forceStopPackagePortSlot(uid, slot, { reason: 'port_slot_login_swap' }).catch(() => {});
  }

  if (!toHandoff.length) {
    return { handoffCount: loginChanged ? 1 : 0 };
  }

  const seenVpsPort = new Set();
  for (const row of toHandoff) {
    await cancelAgentCommandsForAccount(Number(row.id), Number(row.vps_id || 0)).catch(() => 0);
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='expired',
          port_slot=NULL,
          assigned_port_no=NULL,
          windows_port_no=NULL,
          vps_id=NULL,
          port_id=NULL,
          last_error=NULL,
          last_login_message=$2,
          updated_at=NOW()
      WHERE id=$1
    `,
      [row.id, PORT_SWAP_HANDOFF_MSG]
    ).catch(() => {});
    const vpsId = Number(row.vps_id || 0);
    const portNo = Number(row.assigned_port_no || row.windows_port_no || slot);
    if (vpsId && portNo) seenVpsPort.add(`${vpsId}:${portNo}`);
  }

  for (const key of seenVpsPort) {
    const [vpsId, portNo] = key.split(':').map(Number);
    await releaseStaleVpsPortAccounts(vpsId, portNo, null, {
      includeConnected: true,
      message: PORT_SWAP_HANDOFF_MSG
    });
  }

  return { handoffCount: toHandoff.length };
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

/** เลือกเฉพาะ PORT แพ็กเกจว่าง; FolderPort ให้ระบบหาอัตโนมัติ */
async function pickBestPackageSlotForConnect(userId, totalPorts, preferredSlot = 0) {
  const pref = num(preferredSlot);

  async function slotOk(slot) {
    if (slot < 1 || slot > totalPorts) return false;
    if (!(await isUserPortSlotAvailable(userId, slot, totalPorts))) return false;
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

async function resolveLoginCommandMeta(accountId, vpsId, sinceMs = 0) {
  const aid = num(accountId);
  const vid = num(vpsId);
  if (!aid || !vid) return {};
  const cmd = await findRecentTerminalLoginCommand(aid, vid, sinceMs > 0 ? { sinceMs } : {});
  if (!cmd) return {};
  const st = String(cmd.status || '').toLowerCase();
  const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
  let commandMessage = String(cmd.error || res.message || res.error || '').trim();
  if (!commandMessage && st === 'failed') commandMessage = 'คำสั่ง login_mt5 ล้มเหลว';
  const loginHint = String(
    cmd.payload?.mt5Login || cmd.payload?.login || res.login || ''
  ).trim();
  if (loginCommandNeedsEquityResult(cmd, loginHint)) {
    return {
      commandId: cmd.id,
      commandStatus: 'processing',
      commandMessage: 'Agent กำลังเปิด MT5 และรอ Equity ล่าสุด...'
    };
  }
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
    commandMessage,
    commandResult: res,
    commandCreatedAt: cmd.created_at || null,
    commandStartedAt: cmd.started_at || null,
    commandFinishedAt: cmd.finished_at || null
  };
}

function loginCommandNeverPickedForCurrentAttempt(account, cmdMeta) {
  const cmdSt = String(cmdMeta?.commandStatus || '').toLowerCase();
  if (!['cancelled', 'failed', 'error'].includes(cmdSt)) return false;
  if (cmdMeta?.commandStartedAt) return false;
  const connectMs = account?.connect_started_at
    ? new Date(account.connect_started_at).getTime()
    : 0;
  const cmdCreatedMs = cmdMeta?.commandCreatedAt
    ? new Date(cmdMeta.commandCreatedAt).getTime()
    : 0;
  if (!connectMs || !cmdCreatedMs) return false;
  return cmdCreatedMs >= connectMs - 3000;
}

function isTransientCancelledLoginMeta(cmdMeta) {
  const cmdSt = String(cmdMeta?.commandStatus || '').toLowerCase();
  if (cmdSt !== 'cancelled') return false;
  const msg = String(cmdMeta?.commandMessage || '').trim();
  return !msg || /new login attempt|superseded|login takes priority/i.test(msg);
}

function shouldGraceNeverPickedLogin(account, cmdMeta) {
  if (!loginCommandNeverPickedForCurrentAttempt(account, cmdMeta)) return false;
  const connectMs = account?.connect_started_at
    ? new Date(account.connect_started_at).getTime()
    : 0;
  if (!connectMs) return false;
  return Date.now() - connectMs < 15000;
}

/** ยืนยัน Login จริง (journal/คำสั่ง) — ใช้ได้ทั้ง checking/connecting เมื่อคำสั่งสำเร็จแล้ว */
async function resolvePollLoginVerified(account, statusFinal, cmdMeta) {
  const st = String(statusFinal || '').toLowerCase();
  if (!['connecting', 'starting', 'checking', 'connected'].includes(st)) return false;

  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  const login = String(account?.mt5_login || '').trim();
  const portNo = Number(account?.assigned_port_no || account?.port_slot || 0);
  if (!accountId || !vpsId || !login) return false;

  const msg = String(account?.last_login_message || account?.last_error || '');
  if (messageIndicatesLoginFailed(msg, login)) return false;

  const snapshotVerified =
    account?.login_verified === true ||
    positiveMoney(account?.last_balance) > 0 ||
    positiveMoney(account?.last_equity) > 0;
  if (snapshotVerified) {
    if (portNo && (await isPortMt5Running(vpsId, portNo).catch(() => false))) {
      const run = await verifyPortRunningLogin(vpsId, portNo, login).catch(() => ({ ok: false }));
      if (run.ok) return true;
    }
    const cmdStSnap = String(cmdMeta?.commandStatus || '').toLowerCase();
    const cmdResSnap = cmdMeta?.commandResult && typeof cmdMeta.commandResult === 'object'
      ? cmdMeta.commandResult
      : {};
    if (
      ['success', 'done'].includes(cmdStSnap) &&
      (
        String(cmdResSnap.status || '').toLowerCase() === 'connected' ||
        cmdResSnap.loginOnly === true ||
        cmdResSnap.keepMt5Open === true
      )
    ) {
      return true;
    }
  }

  if (st === 'connected') {
    if (portNo && (await isPortMt5Running(vpsId, portNo))) {
      const run = await verifyPortRunningLogin(vpsId, portNo, login).catch(() => ({ ok: false }));
      if (run.ok) return true;
    }
  }

  const cmdSt = String(cmdMeta?.commandStatus || '').toLowerCase();
  if (['pending', 'processing', 'picked', 'running'].includes(cmdSt)) return false;
  if (await hasLoginCommandInProgress(accountId, vpsId).catch(() => false)) return false;

  const verified = await verifyLoginFromCommand({
    accountId,
    vpsId,
    mt5Login: login,
    portNo
  }).catch(() => ({ ok: false }));
  return verified.ok === true;
}

function deriveConnectProgress(statusFinal, cmdSt, previewUrl, loginVerified, hasLoginCmd = true, mt5Login = '') {
  const progressTotal = 4;
  const equityMode = loginUsesEquityVerify(mt5Login);
  if (!hasLoginCmd && ['connecting', 'starting', 'checking'].includes(statusFinal)) {
    return {
      progressStep: 0,
      progressTotal,
      progressStepLabel: 'ส่งคำสั่ง',
      connectStep: equityMode
        ? '① กำลังส่งคำสั่งเปิด MT5 ไป VPS...'
        : '① กำลังส่งคำสั่ง login_mt5 ไป VPS...'
    };
  }
  if (loginVerified) {
    return {
      progressStep: progressTotal,
      progressTotal,
      progressStepLabel: 'เชื่อมต่อสำเร็จ',
      connectStep: '④ เชื่อมต่อสำเร็จ — พร้อมขั้นตอน 3 เปิด BOT'
    };
  }
  if (statusFinal === 'failed') {
    return {
      progressStep: 3,
      progressTotal,
      progressStepLabel: 'Login ไม่สำเร็จ',
      connectStep: equityMode ? '④ เชื่อมต่อไม่สำเร็จ (ไม่พบ Equity)' : '④ Login ไม่สำเร็จ'
    };
  }
  if (statusFinal === 'checking') {
    return {
      progressStep: 3,
      progressTotal,
      progressStepLabel: equityMode ? 'ตรวจ Equity' : 'ตรวจ Journal',
      connectStep: equityMode
        ? '④ กำลังตรวจ Equity ล่าสุดจาก MT5...'
        : '④ กำลังตรวจ Login จาก Journal MT5...'
    };
  }
  if (statusFinal === 'starting' || previewUrl) {
    return {
      progressStep: 2,
      progressTotal,
      progressStepLabel: 'เปิด MT5',
      connectStep: equityMode
        ? '③ เปิด MT5 — รอ Equity ล่าสุด...'
        : '③ เปิด MT5 บน VPS...'
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

    if (!mt5Password) {
      return respondConnectFailed(res, req, 'กรุณากรอกรหัสผ่าน MT5');
    }
    if (mt5Password.length < 4 || mt5Password.length > 64) {
      return respondConnectFailed(res, req, 'Password ไม่ถูกต้อง (4-64 ตัวอักษร)');
    }

    const uiPreferredSlotEarly = num(
      req.body.port_slot || req.body.portSlot || req.body.ui_port_hint || req.body.uiPortHint
    );

    if (uiPreferredSlotEarly > 0) {
      const portBusy = await query(
        `
        SELECT id FROM vps_system.mt5_accounts
        WHERE user_id = $1
          AND port_slot = $2
          AND LOWER(COALESCE(status, '')) IN ('connecting', 'checking', 'starting')
        LIMIT 1
      `,
        [userId, uiPreferredSlotEarly]
      ).catch(() => ({ rows: [] }));
      if (portBusy.rows?.[0]) {
        return respondConnectFailed(
          res,
          req,
          `PORT ${uiPreferredSlotEarly} กำลังเชื่อมต่ออยู่ — รอให้จบหรือกดยกเลิกก่อนลองใหม่`
        );
      }
    }

    if (uiPreferredSlotEarly > 0 && loginUsesEquityVerify(mt5Login)) {
      const liveRes = await query(
        `
        SELECT a.id, a.status, a.vps_id, a.port_id, a.port_slot, a.assigned_port_no,
               COALESCE(p.folder_path, '') AS folder_path, a.last_login_message
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.user_id = $1
          AND a.mt5_login = $2
          AND COALESCE(a.server_name, a.mt5_server, '') = $3
          AND LOWER(COALESCE(a.status, '')) = 'connected'
          AND (a.port_slot = $4 OR a.assigned_port_no = $4)
        ORDER BY a.id DESC
        LIMIT 1
      `,
        [userId, mt5Login, serverName, uiPreferredSlotEarly]
      ).catch(() => ({ rows: [] }));
      let live = liveRes.rows?.[0];
      if (live?.id) {
        const reconciled = await reconcileConnectedAccountLive(
          {
            ...live,
            mt5_login: mt5Login,
            server_name: serverName
          },
          { allowDemote: true }
        ).catch(() => ({ changed: false, account: live }));
        live = reconciled.account || live;
      }
      if (live?.vps_id) {
        const portNo = Number(live.assigned_port_no || uiPreferredSlotEarly);
        const run = await verifyPortRunningLogin(live.vps_id, portNo, mt5Login).catch(() => ({
          ok: false
        }));
        if (run.ok) {
          if (!live.port_slot) {
            await query(
              `UPDATE vps_system.mt5_accounts SET port_slot=$2, updated_at=NOW() WHERE id=$1`,
              [live.id, uiPreferredSlotEarly]
            ).catch(() => {});
            live.port_slot = uiPreferredSlotEarly;
          }
          return respondConnectQueued(res, req, {
            ok: true,
            status: 'connected',
            accountId: live.id,
            vpsId: live.vps_id,
            portId: live.port_id,
            portNo,
            portSlot: uiPreferredSlotEarly,
            loginVerified: true,
            connected: true,
            connectStep: '④ เชื่อมต่อสำเร็จ — พร้อมขั้นตอน 3 เปิด BOT',
            commandStatus: 'success',
            progressStep: 4,
            progressStepLabel: 'เชื่อมต่อสำเร็จ',
            progressTotal: 4,
            message: live.last_login_message || MT5_SUCCESS_MSG
          });
        }
      }
    }

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

    const uiPreferredSlot = num(
      req.body.port_slot || req.body.portSlot || req.body.ui_port_hint || req.body.uiPortHint
    );

    if (!uiPreferredSlot) {
      throw new Error(
        'กรุณาคลิกเลือก PORT (ขั้นตอน 1) ก่อนเชื่อมต่อ — 1 PORT = 1 Login = 1 FolderPort ห้ามข้ามช่อง'
      );
    }

    if (uiPreferredSlot > 0) {
      const onOtherSlot = await findMt5LoginOnOtherUserPort(
        userId,
        mt5Login,
        serverName,
        uiPreferredSlot
      );
      if (onOtherSlot) {
        throw new Error(mt5LoginOnOtherPortMessage(onOtherSlot, uiPreferredSlot));
      }
    }

    const duplicate = await findMt5LoginInUse(mt5Login, serverName, userId);
    if (duplicate) {
      throw new Error(mt5LoginInUseMessage(duplicate, uiPreferredSlot));
    }

    let retryPort = await findRetryPortForLogin(userId, mt5Login, serverName);
    let existingLoginRow = null;
    let portSlot = 0;

    if (retryPort?.port_slot && Number(retryPort.port_slot) !== uiPreferredSlot) {
      retryPort = null;
    }

    if (retryPort) {
      portSlot = uiPreferredSlot;
      reservedPort = {
        port_id: retryPort.port_id,
        vps_id: retryPort.vps_id,
        port_no: retryPort.port_no,
        folder_path: retryPort.folder_path,
        port_slot: portSlot
      };
    } else {
      const existRes = await query(
        `
        SELECT a.id, a.port_slot, a.port_id, a.vps_id, a.assigned_port_no, a.windows_port_no,
               a.status, a.updated_at, p.folder_path, p.port_no
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
      existingLoginRow = exist || null;
      portSlot = uiPreferredSlot;

      if (!portSlot || portSlot > totalPorts) {
        throw new Error(
          portSlot > totalPorts
            ? `PORT ${portSlot} เกินแพ็กเกจ (${totalPorts} ช่อง)`
            : `PORT ตามแพ็กเกจเต็มแล้ว (${usedPorts}/${totalPorts})`
        );
      }

      if (exist?.port_id && exist?.vps_id && exist?.folder_path) {
        const existPhysical = num(exist.assigned_port_no || exist.port_no);
        if (existPhysical > 0 && existPhysical === portSlot) {
          reservedPort = {
            port_id: exist.port_id,
            vps_id: exist.vps_id,
            port_no: existPhysical,
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
      } else {
        const reserve = await reserveBestPort(userId, uiPreferredSlot || portSlot);
        if (!reserve.ok) throw new Error(reserve.message);
        reservedPort = reserve.port;
      }
    }

    const allocPortNo = num(
      reservedPort.port_number || parsePortNumber(reservedPort) || portSlot
    );

    await releasePreviousLoginBindingIfMoved(
      existingLoginRow,
      reservedPort,
      allocPortNo
    ).catch(() => {});

    await handoffPackagePortSlotForNewLogin(userId, portSlot, mt5Login, serverName);

    await releaseStaleVpsPortAccounts(reservedPort.vps_id, allocPortNo, null);

    const upserted = await upsertAccountForPortSlot(query, {
      userId,
      portSlot,
      mt5Login,
      mt5Password,
      serverName,
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      allocPortNo,
      accountName: `PORT ${portSlot}`
    });

    if (!upserted.id) {
      throw new Error('ไม่สามารถบันทึกข้อมูล PORT ได้ — กรุณาลองใหม่');
    }

    const accountId = upserted.id;
    await expireDuplicatePortSlotRows(
      query,
      userId,
      portSlot,
      accountId,
      PORT_SWAP_HANDOFF_MSG
    );
    await clearOtherAccountsOnPortSlot(query, userId, portSlot, accountId);

    await expireStuckMaintenanceCommands(reservedPort.vps_id).catch(() => {});
    await deferMaintenanceForLogin(reservedPort.vps_id).catch(() => {});
    const { expireStalePendingAgentCommands, cancelPendingStopCommandsForSlot } =
      require('../lib/mt5LoginCommandVerify');
    await cancelPendingStopCommandsForSlot(
      reservedPort.vps_id,
      portSlot,
      reservedPort.folder_path || ''
    ).catch(() => {});
    await expireStalePendingAgentCommands(reservedPort.vps_id, 45).catch(() => {});

    if (reservedPort.admin_node_id && allocPortNo) {
      await setAdminAllocationStatus(
        reservedPort.admin_node_id,
        allocPortNo,
        'locked',
        reservedPort.allocation_id
      ).catch(() => {});
    }

    const activeOnVps = await countActiveLoginsOnVps(reservedPort.vps_id);
    const runningOnVps = await countRunningMt5OnVps(reservedPort.vps_id);
    const journalTimeoutSec = computeJournalTimeoutSec({
      totalPorts,
      activeLoginCount: activeOnVps,
      runningMt5Count: runningOnVps,
      portSlot
    });
    const equityFast = loginUsesEquityVerify(mt5Login);
    const queueDelay = await computeLoginQueueDelaySec(reservedPort.vps_id, accountId, {
      equityFast
    });

    const connectStartedAt = new Date().toISOString();
    const payload = {
      ...buildMt5LoginPayload({
        accountId,
        userId,
        reservedPort,
        portSlot,
        mt5Login,
        mt5Password,
        serverName,
        journalTimeoutSec,
        loginQueueDelaySec: queueDelay
      }),
      connectStartedAt,
      forceLogin: true
    };

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
    const failSlot = num(
      req.body.port_slot || req.body.portSlot || req.body.ui_port_hint || req.body.uiPortHint
    );
    if (failSlot && req.user?.id) {
      await releaseUserPackagePortSlot(req.user.id, failSlot, {
        message: e.message,
        reason: 'connect_request_error'
      }).catch(() => {});
    }
    return respondConnectFailed(res, req, e.message);
  } finally {
    if (loginLockKey) await redis.del(loginLockKey).catch(() => {});
    if (lockKey) await redis.del(lockKey).catch(() => {});
  }
}

async function ensureActiveLoginCommandForPoll(account, opts = {}) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  const portSlot = Number(account?.port_slot || account?.assigned_port_no || 0);
  const portNo = Number(account?.assigned_port_no || account?.port_slot || 0);
  const login = String(account?.mt5_login || '').trim();
  const status = String(account?.status || '').toLowerCase();
  const forceRequeue = opts?.forceRequeue === true;
  if (!accountId || !vpsId || !login || !portNo) return { requeued: false };
  if (!['connecting', 'starting', 'checking', 'connected'].includes(status)) {
    return { requeued: false };
  }

  const connectMs = account.connect_started_at
    ? new Date(account.connect_started_at).getTime()
    : 0;
  if (!connectMs || Date.now() - connectMs > 8 * 60 * 1000) return { requeued: false };
  if (Date.now() - connectMs < 800 && !forceRequeue) return { requeued: false };

  const live = await verifyPortRunningLogin(vpsId, portNo, login).catch(() => ({ ok: false }));
  if (live.ok) return { requeued: false, live: true };
  if (status === 'connected' && hasVerifiedMt5Snapshot(account)) {
    return { requeued: false, live: true, verifiedSnapshot: true };
  }

  if (await hasLoginCommandInProgress(accountId, vpsId).catch(() => false)) {
    return { requeued: false };
  }

  const roundCmd = await findRecentTerminalLoginCommand(accountId, vpsId, {
    sinceMs: connectMs
  }).catch(() => null);
  if (roundCmd) {
    const st = String(roundCmd.status || '').toLowerCase();
    if (['pending', 'processing', 'picked', 'running', 'success', 'done'].includes(st)) {
      return { requeued: false };
    }
  }

  const cred = await query(
    `
    SELECT mt5_password, user_id, port_id, server_name, port_slot, assigned_port_no,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id = $1
    LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const row = cred.rows?.[0];
  if (!row?.mt5_password) return { requeued: false };

  if (status === 'connected') {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='checking',
          last_login_message='② กำลังส่งคำสั่งเปิด MT5 ไป VPS...',
          last_error=NULL,
          updated_at=NOW()
      WHERE id=$1
    `,
      [accountId]
    ).catch(() => {});
    account.status = 'checking';
    account.last_login_message = '② กำลังส่งคำสั่งเปิด MT5 ไป VPS...';
    account.last_error = null;
  }

  const userId = Number(row.user_id || 0);
  const totalPorts = userId ? await getUserPackagePortLimit(userId).catch(() => 4) : 4;
  const activeOnVps = await countActiveLoginsOnVps(vpsId).catch(() => 0);
  const runningOnVps = await countRunningMt5OnVps(vpsId).catch(() => 0);
  const journalTimeoutSec = computeJournalTimeoutSec({
    totalPorts,
    activeLoginCount: activeOnVps,
    runningMt5Count: runningOnVps,
    portSlot: portSlot || portNo
  });
  const equityFast = loginUsesEquityVerify(login);
  const queueDelay = await computeLoginQueueDelaySec(vpsId, accountId, { equityFast }).catch(
    () => 0
  );
  const connectStartedAt = account.connect_started_at
    ? new Date(account.connect_started_at).toISOString()
    : new Date().toISOString();
  const reservedPort = {
    vps_id: vpsId,
    port_id: Number(row.port_id || account.port_id || 0),
    port_no: portNo,
    folder_path: row.folder_path || account.folder_path || ''
  };
  const payload = {
    ...buildMt5LoginPayload({
      accountId,
      userId,
      reservedPort,
      portSlot: portSlot || portNo,
      mt5Login: login,
      mt5Password: String(row.mt5_password),
      serverName: String(row.server_name || resolveServerForLogin(login)),
      journalTimeoutSec,
      loginQueueDelaySec: queueDelay
    }),
    connectStartedAt,
    forceLogin: true,
    purpose: 'poll_requeue_login'
  };

  const queued = await insertPendingAgentCommand({
    vpsId,
    portId: reservedPort.port_id || null,
    commandType: 'login_mt5',
    payload
  }).catch(() => ({ id: 0 }));

  if (queued.id) {
    const message = forceRequeue
      ? '① ส่งคำสั่ง login_mt5 ใหม่แล้ว — รอ Agent รับงาน'
      : '① ส่งคำสั่ง login_mt5 แล้ว — รอ Agent รับงาน';
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='connecting',
          last_login_message=$2,
          last_error=NULL,
          updated_at=NOW()
      WHERE id=$1
    `,
      [accountId, message]
    ).catch(() => {});
    account.status = 'connecting';
    account.last_login_message = message;
    account.last_error = null;
  }

  return { requeued: !!queued.id, commandId: queued.id || null };
}

async function persistConnectingAttempt(userId, accountId, status, message) {
  const nextStatus = ['connecting', 'starting', 'checking'].includes(String(status || '').toLowerCase())
    ? String(status).toLowerCase()
    : 'connecting';
  if (!userId || !accountId) return;
  await query(
    `
      UPDATE vps_system.mt5_accounts
      SET status=$3,
          last_login_message=$4,
          last_error=NULL,
          updated_at=NOW()
      WHERE id=$1 AND user_id=$2
    `,
    [accountId, userId, nextStatus, message]
  ).catch(() => {});
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
             a.login_verified, a.last_balance, a.last_equity,
             p.folder_path
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE ${where.replace(/\buser_id\b/g, 'a.user_id').replace(/\bid\b/g, 'a.id')}
      ORDER BY
        CASE LOWER(COALESCE(a.status, ''))
          ${accountId
            ? `WHEN 'connecting' THEN 0
          WHEN 'starting' THEN 1
          WHEN 'checking' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'connected' THEN 4`
            : `WHEN 'connected' THEN 0
          WHEN 'connecting' THEN 1
          WHEN 'starting' THEN 2
          WHEN 'checking' THEN 3
          WHEN 'failed' THEN 4`}
          ELSE 5
        END,
        a.updated_at DESC NULLS LAST,
        a.id DESC
      LIMIT 1
    `, params);

    let a = r.rows?.[0];
    if (!a) return res.json({ ok: true, connected: false, status: 'none', message: 'ยังไม่มีรายการเชื่อมต่อ' });

    if (String(a.status || '').toLowerCase() === 'connected') {
      const reconciled = await reconcileConnectedAccountLive(a, {
        allowDemote: true
      }).catch(() => ({ changed: false, account: a }));
      a = reconciled.account || a;
      if (reconciled.changed) {
        a.updated_at = new Date().toISOString();
      }
    }

    const updatedAt = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    const staleMs = Date.now() - updatedAt;
    let status = String(a.status || '').toLowerCase();

    if (['connecting', 'starting', 'checking'].includes(status)) {
      const cmdFailEarly = await probeRecentLoginCommandFailed(a).catch(() => ({ failed: false }));
      if (cmdFailEarly.failed) {
        const failMsg = cmdFailEarly.message || MT5_LOGIN_TIMEOUT_MSG;
        await failAccountFromJournal(a.id, a.port_id, failMsg, {
          vpsId: a.vps_id,
          portNo: a.assigned_port_no || a.port_slot,
          portSlot: a.port_slot || a.assigned_port_no,
          folderPath: a.folder_path,
          reason: 'login_cmd_failed',
          killMt5: true,
          clearPackagePort: true,
          forceFailed: true
        }).catch(() => {});
        status = 'failed';
        a.status = 'failed';
        a.last_error = failMsg;
        a.last_login_message = failMsg;
      } else {
        const stuck = await expireStuckLoginVerify(a).catch(() => ({ expired: false }));
        if (stuck.expired) {
          status = 'failed';
          a.status = 'failed';
          a.last_error = stuck.message;
          a.last_login_message = stuck.message;
        }
      }
    }

    if (status === 'failed' && hasVerifiedMt5Snapshot(a)) {
      const recoverCmd = await findRecentTerminalLoginCommand(a.id, a.vps_id).catch(() => null);
      const recoverRes = recoverCmd?.result && typeof recoverCmd.result === 'object' ? recoverCmd.result : {};
      const recoverCmdSuccess =
        ['success', 'done'].includes(String(recoverCmd?.status || '').toLowerCase()) &&
        (
          String(recoverRes.status || '').toLowerCase() === 'connected' ||
          recoverRes.loginOnly === true ||
          recoverRes.keepMt5Open === true
        );
      const runningVerified =
        a.vps_id && (a.assigned_port_no || a.port_slot) && a.mt5_login
          ? await verifyPortRunningLogin(
              a.vps_id,
              Number(a.assigned_port_no || a.port_slot),
              String(a.mt5_login || '').trim()
            ).catch(() => ({ ok: false }))
          : { ok: false };
      const snapshotRecovered =
        !a.port_id &&
        !(a.assigned_port_no || a.port_slot) &&
        hasVerifiedMt5Snapshot(a);
      if (runningVerified.ok || recoverCmdSuccess || snapshotRecovered) {
        await promoteAccountConnected({
          accountId: a.id,
          portId: a.port_id,
          mt5Login: a.mt5_login,
          message: recoverRes.message || MT5_SUCCESS_MSG,
          balance: a.last_balance,
          equity: a.last_equity
        }).catch(() => {});
        a.status = 'connected';
        a.last_error = null;
        a.last_login_message = recoverRes.message || MT5_SUCCESS_MSG;
        status = 'connected';
      }
    }

    if (status === 'failed') {
      const failMsg = a.last_error || a.last_login_message || MT5_FAIL_USER_MSG;
      return res.json({
        ok: true,
        account: { ...a, status: 'failed' },
        connected: false,
        failed: true,
        checking: false,
        pending: false,
        status: 'failed',
        loginVerified: false,
        message: failMsg,
        commandStatus: 'failed',
        commandMessage: failMsg,
        elapsedSec: Math.max(0, Math.floor(staleMs / 1000)),
        connectStep: '④ Login ไม่สำเร็จ',
        progressStep: 3,
        progressStepLabel: 'Login ไม่สำเร็จ',
        progressTotal: 4
      });
    }

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
    const connectStartedMs = a.connect_started_at
      ? new Date(a.connect_started_at).getTime()
      : 0;
    const cmdMetaSeed = await resolveLoginCommandMeta(a.id, a.vps_id, connectStartedMs);
    const transientCancelledSeed = isTransientCancelledLoginMeta(cmdMetaSeed);
    const forceRequeueNeverPicked =
      shouldGraceNeverPickedLogin(a, cmdMetaSeed) || transientCancelledSeed;
    const requeueLogin = await ensureActiveLoginCommandForPoll(a, {
      forceRequeue: forceRequeueNeverPicked
    }).catch(() => ({
      requeued: false
    }));
    if (requeueLogin.requeued) {
      status = String(a.status || status).toLowerCase();
    }
    const loginNum = String(a.mt5_login || '').trim();
    const msgBlobEarly = String(a.last_login_message || a.last_error || '');
    if (messageIndicatesLoginFailed(msgBlobEarly, loginNum) && !forceRequeueNeverPicked) {
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

    const dbStatusEarly = String(a.status || '').toLowerCase();
    const needsStaleWatch = ['connecting', 'starting', 'checking'].includes(dbStatusEarly);
    if (needsStaleWatch && staleMs > staleLimitMs) {
      const loginStillBusy = await hasLoginCommandInProgress(a.id, a.vps_id).catch(() => false);
      if (!loginStillBusy) {
        const staleMsg = 'หมดเวลารอการเชื่อมต่อ — กรุณากรอก Login แล้วกดเชื่อมต่อใหม่';
        await failAccountFromJournal(a.id, a.port_id, staleMsg, {
          vpsId: a.vps_id,
          portNo: a.assigned_port_no,
          folderPath: a.folder_path,
          reason: 'connect_poll_timeout'
        }).catch(() => {});
        status = 'failed';
        a.last_error = staleMsg;
        a.last_login_message = staleMsg;
      }
    }

    let statusFinal = status;
    const windowHint = isLegacyWindowVerifiedMessage(a.last_login_message || '');
    const cmdMetaEarly = cmdMetaSeed.commandId != null || cmdMetaSeed.commandStatus
      ? cmdMetaSeed
      : await resolveLoginCommandMeta(a.id, a.vps_id, connectStartedMs);
    const cmdStEarly = String(cmdMetaEarly.commandStatus || '').toLowerCase();

    if (
      ['success', 'done'].includes(cmdStEarly) &&
      ['connecting', 'starting', 'checking'].includes(statusFinal)
    ) {
      await syncJournalFromLatestCommand(
        a.id,
        a.vps_id,
        a.mt5_login,
        a.folder_path,
        a.assigned_port_no
      ).catch(() => {});
      const jr = await query(
        `
        SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
               a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
               a.login_verified, a.last_balance, a.last_equity,
               p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1 AND a.user_id=$2
        LIMIT 1
      `,
        [a.id, userId]
      ).catch(() => ({ rows: [] }));
      if (jr.rows?.[0]) {
        Object.assign(a, jr.rows[0]);
        status = String(a.status || '').toLowerCase();
        statusFinal = status;
      }
    }

    const fastAfterMs = ['success', 'done'].includes(cmdStEarly) ? 1500 : 3000;
    if (['connecting', 'starting', 'checking'].includes(statusFinal) && staleMs >= 1000) {
      const failEarly = await tryFastJournalFail(a).catch(() => ({ resolved: false }));
      if (failEarly.resolved) {
        statusFinal = failEarly.status || 'failed';
        a.status = 'failed';
        a.last_error = failEarly.message || MT5_FAIL_USER_MSG;
        a.last_login_message = failEarly.message || MT5_FAIL_USER_MSG;
      }
    }
    if (
      ['connecting', 'starting', 'checking'].includes(statusFinal) &&
      staleMs >= fastAfterMs
    ) {
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
      ['connecting', 'starting', 'checking'].includes(statusFinal) &&
      !windowHint &&
      !loginUsesEquityVerify(a.mt5_login);

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
               a.login_verified, a.last_balance, a.last_equity,
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

    const failedMsg = a.last_error || a.last_login_message || '';
    const elapsedSec = Math.max(0, Math.floor(staleMs / 1000));
    const previewPath = previewPublicPath(a.id);
    const cmdMeta = cmdMetaEarly.commandId != null || cmdMetaEarly.commandStatus
      ? cmdMetaEarly
      : await resolveLoginCommandMeta(a.id, a.vps_id, connectStartedMs);
    const neverPickedCurrentAttempt = loginCommandNeverPickedForCurrentAttempt(a, cmdMeta);
    const graceNeverPicked = shouldGraceNeverPickedLogin(a, cmdMeta);
    const transientCancelledAttempt = isTransientCancelledLoginMeta(cmdMeta);

    if (graceNeverPicked || transientCancelledAttempt || requeueLogin.requeued) {
      cmdMeta.commandId = requeueLogin.commandId || cmdMeta.commandId || null;
      cmdMeta.commandStatus = requeueLogin.requeued ? 'pending' : '';
      cmdMeta.commandMessage = requeueLogin.requeued
        ? 'กำลังส่งคำสั่ง login_mt5 ใหม่ไป VPS...'
        : transientCancelledAttempt
          ? 'กำลังรอ Agent รับคำสั่ง login_mt5...'
          : 'กำลังส่งคำสั่ง login_mt5 ไป VPS...';
    }
    const cmdSt = String(cmdMeta.commandStatus || '').toLowerCase();

    if (neverPickedCurrentAttempt) {
      if (graceNeverPicked || transientCancelledAttempt) {
        statusFinal = ['connecting', 'starting', 'checking'].includes(statusFinal)
          ? statusFinal
          : 'connecting';
        a.status = statusFinal;
        a.last_error = null;
        a.last_login_message = requeueLogin.requeued
          ? '① ส่งคำสั่ง login_mt5 ใหม่แล้ว — รอ Agent รับงาน'
          : '① ส่งคำสั่ง login_mt5 แล้ว — รอ Agent รับงาน';
        await persistConnectingAttempt(userId, a.id, statusFinal, a.last_login_message);
      } else {
        const failMsg =
          cmdMeta.commandMessage ||
          'คำสั่ง login ยังไม่ถูก Agent รับงาน — กรุณากดเชื่อมต่อใหม่อีกครั้ง';
        await failAccountFromJournal(a.id, a.port_id, failMsg, {
          vpsId: a.vps_id,
          portNo: a.assigned_port_no || a.port_slot,
          folderPath: a.folder_path,
          reason: 'login_cmd_not_picked'
        }).catch(() => {});
        statusFinal = 'failed';
        a.status = 'failed';
        a.last_error = failMsg;
        a.last_login_message = failMsg;
      }
    }

    if (
      (['failed', 'error'].includes(cmdSt) || (cmdSt === 'cancelled' && !transientCancelledAttempt)) &&
      ['connecting', 'starting', 'checking'].includes(statusFinal) &&
      !neverPickedCurrentAttempt
    ) {
      if (hasVerifiedMt5Snapshot(a)) {
        const runningVerified =
          a.vps_id && (a.assigned_port_no || a.port_slot) && a.mt5_login
            ? await verifyPortRunningLogin(
                a.vps_id,
                Number(a.assigned_port_no || a.port_slot),
                String(a.mt5_login || '').trim()
              ).catch(() => ({ ok: false }))
            : { ok: false };
        if (runningVerified.ok) {
          await promoteAccountConnected({
            accountId: a.id,
            portId: a.port_id,
            mt5Login: a.mt5_login,
            message: MT5_SUCCESS_MSG,
            balance: a.last_balance,
            equity: a.last_equity
          }).catch(() => {});
          statusFinal = 'connected';
          a.status = 'connected';
          a.last_error = null;
          a.last_login_message = MT5_SUCCESS_MSG;
        }
      }
    }

    if (
      ['failed', 'error', 'cancelled'].includes(cmdSt) &&
      ['connecting', 'starting', 'checking'].includes(statusFinal) &&
      !neverPickedCurrentAttempt
    ) {
      const failMsg =
        cmdMeta.commandMessage ||
        (cmdSt === 'cancelled'
          ? 'คำสั่ง login ถูกยกเลิก — กรุณากดเชื่อมต่อใหม่อีกครั้ง (กดครั้งเดียว อย่ากดซ้ำ)'
          : /authorization|invalid account|user ผิด/i.test(String(a.last_login_message || ''))
            ? MT5_FAIL_USER_MSG
            : MT5_LOGIN_TIMEOUT_MSG);
      await failAccountFromJournal(a.id, a.port_id, failMsg, {
        vpsId: a.vps_id,
        portNo: a.assigned_port_no || a.port_slot,
        folderPath: a.folder_path,
        reason: 'login_cmd_failed'
      }).catch(() => {});
      statusFinal = 'failed';
      a.status = 'failed';
      a.last_error = failMsg;
      a.last_login_message = failMsg;
    }

    const agentMeta = await resolveVpsAgentOnline(a.vps_id);
    let loginVerified = neverPickedCurrentAttempt
      ? false
      : await resolvePollLoginVerified(a, statusFinal, cmdMeta);
    if (!loginVerified && statusFinal === 'connected' && hasVerifiedMt5Snapshot(a)) {
      loginVerified = true;
    }
    if (loginVerified && statusFinal !== 'connected') {
      await promoteAccountConnected({
        accountId: a.id,
        portId: a.port_id,
        mt5Login: a.mt5_login,
        message: MT5_SUCCESS_MSG
      }).catch(() => {});
      statusFinal = 'connected';
      a.status = 'connected';
      a.last_error = null;
      a.last_login_message = MT5_SUCCESS_MSG;
    }
    if (statusFinal === 'connected' && !loginVerified) {
      const loginInMsg = String(a.mt5_login || '').trim();
      const msgBlob = String(a.last_login_message || a.last_error || '');
      const portRunning =
        a.vps_id && (a.assigned_port_no || a.port_slot)
          ? await isPortMt5Running(
              a.vps_id,
              Number(a.assigned_port_no || a.port_slot)
            ).catch(() => false)
          : false;
      if (
        portRunning &&
        !messageIndicatesLoginFailed(msgBlob, loginInMsg) &&
        (await verifyPortRunningLogin(
          a.vps_id,
          Number(a.assigned_port_no || a.port_slot),
          loginInMsg
        ).catch(() => ({ ok: false }))).ok
      ) {
        loginVerified = true;
      } else if (!portRunning) {
        statusFinal = 'checking';
        a.status = statusFinal;
      } else {
        statusFinal = 'checking';
        a.status = statusFinal;
      }
    }
    const inProgress = ['connecting', 'checking', 'starting'].includes(statusFinal);
    let userMessage;
    if (loginVerified) {
      userMessage = MT5_SUCCESS_MSG;
    } else if (statusFinal === 'failed') {
      userMessage = /ทันเวลา|timeout|cancelled:\s*journal|journal\s+login\s+failed/i.test(failedMsg)
        ? MT5_LOGIN_TIMEOUT_MSG
        : failedMsg || MT5_FAIL_USER_MSG;
    } else if (inProgress) {
      const equityMode = loginUsesEquityVerify(a.mt5_login);
      const upgradeHint = /อัปเดต Agent|รอ 2.?3 นาที|Restart-Service/i.test(
        String(a.last_login_message || '')
      );
      if (['success', 'done'].includes(cmdSt)) {
        userMessage = equityMode
          ? loginCommandNeedsEquityResult(
              { status: cmdSt, result: cmdMeta.commandResult || {} },
              a.mt5_login
            )
            ? `Agent กำลังเปิด MT5 และรอ Equity (${elapsedSec} วิ)...`
            : `กำลังตรวจ Equity ล่าสุดจาก MT5 (${elapsedSec} วินาที)...`
          : `กำลังตรวจ Login จาก Journal MT5 (${elapsedSec} วินาที)...`;
      } else if (upgradeHint) {
        userMessage = `กำลังเปิด MT5 และ Login... (${elapsedSec} วินาที)`;
      } else {
        userMessage =
          a.last_login_message || `กำลังเปิด MT5 และตรวจสอบ Login (${elapsedSec} วินาที)...`;
      }
    } else {
      userMessage = a.last_login_message || a.last_error || statusFinal;
    }
    const previewBust = Math.floor(Date.now() / 15000);
    const previewUrl = previewPath ? `${previewPath}?t=${previewBust}` : '';
    const maxWaitSec = Math.floor(connectPollStaleLimitMs() / 1000);
    const dbStatusLate = String(a.status || '').toLowerCase();
    if (
      !loginVerified &&
      (inProgress || dbStatusLate === 'connected') &&
      elapsedSec >= maxWaitSec &&
      (['success', 'done'].includes(cmdSt) || dbStatusLate === 'connected')
    ) {
      const busy = await hasLoginCommandInProgress(a.id, a.vps_id).catch(() => false);
      if (!busy) {
        await failAccountFromJournal(a.id, a.port_id, MT5_LOGIN_TIMEOUT_MSG, {
          vpsId: a.vps_id,
          portNo: a.assigned_port_no,
          folderPath: a.folder_path,
          reason: 'journal_verify_poll_timeout'
        }).catch(() => {});
        statusFinal = 'failed';
        a.status = 'failed';
        a.last_error = MT5_LOGIN_TIMEOUT_MSG;
        a.last_login_message = MT5_LOGIN_TIMEOUT_MSG;
        userMessage = MT5_LOGIN_TIMEOUT_MSG;
      }
    }
    const hasLoginCmd = !!cmdMeta.commandId;
    const progress = deriveConnectProgress(
      statusFinal,
      cmdSt,
      previewUrl,
      loginVerified,
      hasLoginCmd,
      a.mt5_login
    );
    let connectStep = progress.connectStep;
    const loginMsg = String(a.last_login_message || '').trim();
    if (inProgress && !cmdMeta.commandId && elapsedSec >= 8) {
      connectStep = '① ส่งคำสั่งแล้ว — ยังไม่เห็นคำสั่งในคิว VPS';
    }
    if (inProgress && agentMeta.agentOnline === false && elapsedSec >= 20) {
      connectStep = '② VPS Agent ไม่ตอบสนอง — ตรวจ /admin/vps';
    }
    if (inProgress && ['success', 'done'].includes(cmdSt)) {
      if (loginUsesEquityVerify(a.mt5_login)) {
        connectStep = '④ กำลังตรวจ Equity ล่าสุดจาก MT5';
        if (/Equity|equity/i.test(loginMsg)) {
          connectStep = loginMsg;
        }
        if (loginCommandNeedsEquityResult({ status: cmdSt, result: cmdMeta.result || {} }, a.mt5_login)) {
          connectStep = '③ Agent กำลังเปิด MT5 — รอ Equity ล่าสุด...';
          await queueEquityLoginVerify({
            accountId: a.id,
            vpsId: a.vps_id,
            folderPath: a.folder_path,
            mt5Login: a.mt5_login,
            portNo: a.assigned_port_no || a.port_slot
          }).catch(() => {});
        }
      } else {
        connectStep = '④ กำลังตรวจ Login จาก Journal MT5';
        if (/MT5 เปิดแล้ว|ยังไม่เห็นเลข|title bar|หน้าต่าง MT5/i.test(loginMsg)) {
          connectStep = '④ รอเลข Login บนหน้าต่าง MT5 — ตรวจรหัสผ่านและ Server';
        }
      }
    }
    const statusDetail =
      loginVerified || /^เชื่อมต่อสำเร็จ$/i.test(loginMsg)
        ? ''
        : loginMsg
          ? loginMsg.replace(/\s*\(\s*\d+\s*วิ(?:นาที)?\s*\)/g, '').trim()
          : '';

    let commandStatusOut = cmdMeta.commandStatus || '';
    if (
      loginVerified &&
      ['cancelled', 'failed', 'error'].includes(String(commandStatusOut).toLowerCase()) &&
      !neverPickedCurrentAttempt
    ) {
      commandStatusOut = 'success';
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
      statusDetail,
      previewUrl,
      elapsedSec,
      maxWaitSec,
      connectStep,
      progressStep: progress.progressStep,
      progressStepLabel: progress.progressStepLabel,
      progressTotal: progress.progressTotal,
      commandId: cmdMeta.commandId || null,
      commandStatus: commandStatusOut,
      commandMessage: cmdMeta.commandMessage || '',
      loginRequeued: !!requeueLogin.requeued,
      loginRequeueCommandId: requeueLogin.commandId || null,
      agentOnline: agentMeta.agentOnline,
      agentMessage: agentMeta.agentMessage || ''
    });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
}

// ใช้ได้ทั้ง endpoint ใหม่และ endpoint เดิมของหน้าเว็บ
router.post('/mt5/connect-production', requireLogin, handleMt5ConnectProduction);
router.post('/mt5/connect', requireLogin, handleMt5ConnectProduction);
router.get('/mt5/connect-status-production', requireLogin, handleMt5ConnectStatusProduction);
router.get('/mt5/connect-status', requireLogin, handleMt5ConnectStatusProduction);

/** สถานะ login แบบย่อ — ใช้ poll UI (alias connect-status) */
async function handleMt5AccountStatus(req, res) {
  try {
    const userId = req.user.id;
    const accountId = num(req.params.accountId || req.params.id);
    if (!accountId) return res.status(400).json({ ok: false, message: 'NO_ACCOUNT_ID' });

    const row = await query(
      `
      SELECT id, status, last_error, last_login_message, last_equity, last_balance, login_verified, connect_started_at,
             created_at, updated_at, mt5_login, assigned_port_no, port_slot, vps_id, port_id
      FROM vps_system.mt5_accounts
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
      [accountId, userId]
    ).catch(() => ({ rows: [] }));

    const acc = row.rows?.[0];
    if (!acc) return res.json({ ok: false, status: 'none', message: 'ไม่พบบัญชี' });

    const st = String(acc.status || '').toLowerCase();
    if (['connecting', 'starting', 'checking'].includes(st)) {
      await expireStuckLoginVerify(acc).catch(() => ({ expired: false }));
      const refreshed = await query(
        `SELECT status, last_error, last_login_message, last_equity, last_balance, login_verified, updated_at
         FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
        [accountId]
      ).catch(() => ({ rows: [] }));
      if (refreshed.rows?.[0]) Object.assign(acc, refreshed.rows[0]);
    }

    const startedMs = acc.connect_started_at
      ? new Date(acc.connect_started_at).getTime()
      : acc.created_at
        ? new Date(acc.created_at).getTime()
        : Date.now();
    const elapsed = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    let statusNow = String(acc.status || '').toLowerCase();
    const cmdMeta = await resolveLoginCommandMeta(acc.id, acc.vps_id, startedMs).catch(() => ({}));
    const neverPickedCurrentAttempt = loginCommandNeverPickedForCurrentAttempt(acc, cmdMeta);
    const graceNeverPicked = shouldGraceNeverPickedLogin(acc, cmdMeta);
    const transientCancelledAttempt = isTransientCancelledLoginMeta(cmdMeta);
    if (neverPickedCurrentAttempt) {
      if (graceNeverPicked || transientCancelledAttempt) {
        statusNow = ['connecting', 'starting', 'checking'].includes(statusNow)
          ? statusNow
          : 'connecting';
        acc.status = statusNow;
        acc.last_error = null;
        acc.last_login_message = transientCancelledAttempt
          ? '① ส่งคำสั่ง login_mt5 แล้ว — รอ Agent รับงาน'
          : '① ส่งคำสั่ง login_mt5 ใหม่แล้ว — รอ Agent รับงาน';
        await persistConnectingAttempt(userId, acc.id, statusNow, acc.last_login_message);
      } else {
        const failMsg =
          cmdMeta.commandMessage ||
          'คำสั่ง login ยังไม่ถูก Agent รับงาน — กรุณากดเชื่อมต่อใหม่อีกครั้ง';
        statusNow = 'failed';
        acc.status = 'failed';
        acc.last_error = failMsg;
        acc.last_login_message = failMsg;
      }
    }
    if (statusNow === 'failed' && hasVerifiedMt5Snapshot(acc) && !neverPickedCurrentAttempt) {
      const recoverCmd = await findRecentTerminalLoginCommand(acc.id, acc.vps_id).catch(() => null);
      const recoverRes = recoverCmd?.result && typeof recoverCmd.result === 'object' ? recoverCmd.result : {};
      const recoverCmdSuccess =
        ['success', 'done'].includes(String(recoverCmd?.status || '').toLowerCase()) &&
        (
          String(recoverRes.status || '').toLowerCase() === 'connected' ||
          recoverRes.loginOnly === true ||
          recoverRes.keepMt5Open === true
        );
      const runningVerified =
        acc.vps_id && (acc.assigned_port_no || acc.port_slot) && acc.mt5_login
          ? await verifyPortRunningLogin(
              acc.vps_id,
              Number(acc.assigned_port_no || acc.port_slot),
              String(acc.mt5_login || '').trim()
            ).catch(() => ({ ok: false }))
          : { ok: false };
      const snapshotRecovered =
        !acc.port_id &&
        !(acc.assigned_port_no || acc.port_slot) &&
        hasVerifiedMt5Snapshot(acc);
      if (runningVerified.ok || recoverCmdSuccess || snapshotRecovered) {
        await promoteAccountConnected({
          accountId: acc.id,
          portId: acc.port_id,
          mt5Login: acc.mt5_login,
          message: recoverRes.message || MT5_SUCCESS_MSG,
          balance: acc.last_balance,
          equity: acc.last_equity
        }).catch(() => {});
        statusNow = 'connected';
        acc.status = 'connected';
        acc.last_error = null;
        acc.last_login_message = recoverRes.message || MT5_SUCCESS_MSG;
      }
    }
    let message = acc.last_login_message || acc.last_error || '';
    if (statusNow === 'connected') message = message || MT5_SUCCESS_MSG;
    if (statusNow === 'failed') message = acc.last_error || acc.last_login_message || MT5_FAIL_USER_MSG;
    if (['connecting', 'checking', 'starting'].includes(statusNow)) {
      if (elapsed < 20) message = message || `⏳ กำลังเปิด MT5... (${elapsed} วิ)`;
      else if (elapsed < 90) message = message || `⏳ ตรวจ Login / Journal... (${elapsed} วิ)`;
      else message = message || `⏳ รอผลจาก VPS... (${elapsed} วิ)`;
    }

    return res.json({
      ok: true,
      status: statusNow,
      equity: acc.last_equity,
      error: acc.last_error,
      message,
      elapsed,
      accountId: acc.id,
      failed: statusNow === 'failed',
      connected: statusNow === 'connected'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}

router.get('/mt5/status/:accountId', requireLogin, handleMt5AccountStatus);
router.get('/mt5/equity/:accountId', requireLogin, async (req, res) => {
  try {
    const accountId = num(req.params.accountId);
    const row = await query(
      `SELECT last_equity FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [accountId, req.user.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ ok: true, equity: row.rows?.[0]?.last_equity ?? null });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

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

    let folderPath = String(req.body.folderPath || req.body.folder_path || '').trim();
    let slot = portSlot || 0;

    if (accountId) {
      const accR = await query(
        `
        SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.port_slot,
               LOWER(COALESCE(a.status, '')) AS status,
               a.login_verified,
               a.connect_started_at,
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
        const connectStartedMs = acc.connect_started_at
          ? new Date(acc.connect_started_at).getTime()
          : 0;
        const cmdMeta = await resolveLoginCommandMeta(acc.id, acc.vps_id, connectStartedMs).catch(
          () => ({})
        );
        const graceNeverPicked = shouldGraceNeverPickedLogin(acc, cmdMeta);
        const transientCancelledAttempt = isTransientCancelledLoginMeta(cmdMeta);
        if (graceNeverPicked || transientCancelledAttempt) {
          const pendingStatus = ['connecting', 'starting', 'checking'].includes(acc.status)
            ? acc.status
            : 'connecting';
          const pendingMessage = transientCancelledAttempt
            ? '① ส่งคำสั่ง login_mt5 แล้ว — รอ Agent รับงาน'
            : '① ส่งคำสั่ง login_mt5 ใหม่แล้ว — รอ Agent รับงาน';
          await persistConnectingAttempt(userId, acc.id, pendingStatus, pendingMessage);
          return res.json({
            ok: true,
            message: 'คำสั่ง login ยังอยู่ระหว่างรอ Agent/รีคิว — ยังไม่เคลียร์ PORT'
          });
        }
        if (acc.status === 'connected' || acc.login_verified === true) {
          return res.json({ ok: true, message: 'บัญชีเชื่อมต่ออยู่แล้ว — ไม่ต้องเคลียร์ PORT' });
        }
        if (
          ['connecting', 'starting', 'checking'].includes(acc.status) &&
          connectStartedMs > 0 &&
          Date.now() - connectStartedMs < 15000
        ) {
          return res.json({ ok: true, message: 'คำสั่ง login ยังอยู่ระหว่างรอ Agent/ตรวจ Login — ยังไม่เคลียร์ PORT' });
        }
        if (!folderPath && acc.port_folder) folderPath = String(acc.port_folder).trim();
        if (!slot) slot = num(acc.port_slot || acc.assigned_port_no);
      }
    }

    if (slot > 0) {
      await releaseUserPackagePortSlot(userId, slot, {
        message,
        folderPath,
        reason: 'connect_fail_cleanup_ui'
      }).catch(() => {});
    }

    return res.json({ ok: true, message: 'เคลียร์ PORT แล้ว' });
  } catch (e) {
    return res.json({ ok: false, message: e.message });
  }
});

module.exports = router;
module.exports.handleMt5AccountStatus = handleMt5AccountStatus;
module.exports.handleMt5AccountEquity = async function handleMt5AccountEquity(req, res) {
  try {
    const accountId = num(req.params.accountId);
    const row = await query(
      `SELECT last_equity FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 LIMIT 1`,
      [accountId, req.user.id]
    ).catch(() => ({ rows: [] }));
    return res.json({ ok: true, equity: row.rows?.[0]?.last_equity ?? null });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
};
