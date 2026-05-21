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
const { requireLogin, prefersJsonResponse } = require('../middleware/requireAuth');
const { query, getClient } = require('../config/database');
const {
  resolveStuckLoginAccount,
  reconcileConnectedAccountLive,
  tryRecoverLoginFromPortHealth,
  tryFastConnectConfirm,
  hasRecentAgentLoginSuccess,
  hasRecentAccountMetrics,
  findRecentLoginCommand,
  promoteAccountConnected,
  tryFastJournalFail,
  expireStuckLoginCommands,
  syncJournalFromLatestCommand,
  failAccountFromJournal,
  cancelJournalVerifyForAccount,
  cancelJournalVerifyWrongPort,
  queueJournalReadVerify
} = require('../lib/mt5LoginCommandVerify');

const connectStatusSyncAt = new Map();
const CONNECT_STATUS_SYNC_MS = Number(process.env.MT5_CONNECT_STATUS_SYNC_MS || 100);
const { previewPublicPath, windowTitleFromMessage } = require('../lib/mt5Preview');
const {
  normalizeLockedServer,
  MT5_LOCKED_SERVER,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG
} = require('../lib/mt5Server');
const { expireStuckMaintenanceCommands, deferMaintenanceForLogin } = require('../lib/agentDeploy');
const {
  reserveAdminPortForLogin,
  buildMt5LoginPayload
} = require('../lib/adminVpsPortPicker');
const { setAdminAllocationStatus, parsePortNumber } = require('../lib/adminVpsBridge');
const { clearOtherAccountsOnPortSlot } = require('../lib/mt5PortAccount');
const { buildConnectAdvice, buildDemoTradingPlan } = require('../lib/mt5AiConnectAdvisor');
const { positiveMoney, ensureEquityOnConnect } = require('../lib/mt5EquitySync');
const { loadAccountPortContext } = require('../lib/mt5AccountPort');
const { checkVpsAgentLiveness, assertVpsAgentOnline } = require('../lib/vpsAgentLiveness');
const { expireStalePendingAgentCommands } = require('../lib/mt5LoginCommandVerify');
const { insertPendingAgentCommand } = require('../lib/vpsAgentCommandQueue');

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

function userLockKey(userId) {
  return `mt5:connect:user:${userId}`;
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
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_journal_evidence TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS connect_started_at TIMESTAMPTZ`).catch(() => {});

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

async function reserveBestPort(userId, preferredPortNo = 0) {
  const preferNo = num(preferredPortNo, 0);
  await clearExpiredLocks();

  const agentGate = await assertVpsAgentOnline();
  if (!agentGate.ok) {
    return { ok: false, message: agentGate.message, code: 'AGENT_OFFLINE' };
  }

  const adminReserve = await reserveAdminPortForLogin(userId, preferNo);
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
        CASE WHEN $4 > 0 AND p.port_no = $4 THEN 0 ELSE 1 END,
        COALESCE(n.cpu_percent,0) ASC,
        COALESCE(n.ram_percent,0) ASC,
        COALESCE(n.ping_ms,0) ASC,
        p.vps_id ASC,
        p.port_no ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [MAX_CPU, MAX_RAM, MAX_PING, preferNo]);

    const port = r.rows?.[0];
    if (!port) {
      await client.query('ROLLBACK');
      const preferMsg =
        adminReserve.code === 'AGENT_OFFLINE'
          ? adminReserve.message
          : adminReserve.message ||
            'ไม่มี VPS/PORT ว่าง — ตรวจสอบ /admin/vps/ports (ข้าม PORT ใช้งาน/ปิด) และ /admin/vps/edit (CPU/RAM/PING)';
      return { ok: false, message: preferMsg, code: adminReserve.code };
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

/** เวลารอที่แสดงบน UI — แยกจาก timeout ภายใน (180s) */
const MT5_CONNECT_HINT_TYPICAL_MAX_SEC = 35;
const MT5_CONNECT_HINT_HARD_MAX_SEC = 60;

function buildConnectWaitHint(waitSec) {
  const sec = Math.max(0, Number(waitSec) || 0);
  if (sec >= MT5_CONNECT_HINT_HARD_MAX_SEC) {
    return (
      'เกิน ' +
      MT5_CONNECT_HINT_TYPICAL_MAX_SEC +
      ' วินาทีแล้ว — รอได้ถึง ~' +
      MT5_CONNECT_HINT_HARD_MAX_SEC +
      ' วิ อย่ากดซ้ำ (ถ้าค้าง restart Agent)'
    );
  }
  if (sec >= 40) {
    return (
      'ใช้เวลานานกว่าปกติ (' +
      sec +
      ' วิ) — ยังยืนยัน Login อยู่ (มักจบภายใน ~' +
      MT5_CONNECT_HINT_TYPICAL_MAX_SEC +
      ' วิ)'
    );
  }
  if (sec >= 18) {
    return 'กำลังยืนยัน Login จาก MT5... (มักจบภายใน ~35 วินาที)';
  }
  return 'โดยปกติใช้เวลา 15–35 วินาที — หลังสำเร็จไปขั้นตอน 3 เลือกบอทแล้วเปิด BOT';
}

async function getLoginConnectDiagnostics(account, elapsedSec = 0) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  let agentOnline = null;
  let agentMessage = '';
  if (vpsId) {
    const live = await checkVpsAgentLiveness(vpsId).catch(() => ({ ok: false, message: '' }));
    agentOnline = !!live.ok;
    agentMessage = live.ok ? 'VPS Agent ออนไลน์' : (live.message || 'VPS Agent ไม่ตอบสนอง');
  }

  let commandStatus = '';
  let commandMessage = '';
  let commandAgeSec = null;
  if (accountId || vpsId) {
    const cmd = await query(
      `
      SELECT status, result_message, error, created_at, updated_at
      FROM vps_system.vps_agent_commands
      WHERE command_type IN ('login_mt5', 'connect_mt5')
        AND (
          ($1::bigint > 0 AND (payload->>'accountId')::bigint = $1)
          OR (
            $2::bigint > 0
            AND vps_id = $2
            AND created_at > NOW() - INTERVAL '45 minutes'
          )
        )
      ORDER BY
        CASE LOWER(COALESCE(status, ''))
          WHEN 'processing' THEN 0
          WHEN 'picked' THEN 1
          WHEN 'running' THEN 2
          WHEN 'pending' THEN 3
          ELSE 4
        END,
        id DESC
      LIMIT 1
    `,
      [accountId, vpsId]
    ).catch(() => ({ rows: [] }));
    const row = cmd.rows?.[0];
    if (row) {
      commandStatus = String(row.status || '').toLowerCase();
      commandMessage = String(row.result_message || row.error || '').trim().slice(0, 240);
      const ts = row.updated_at || row.created_at;
      if (ts) {
        commandAgeSec = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
      }
    }
  }

  const st = String(account?.status || '').toLowerCase();
  let connectStep = 'เชื่อมต่อ MT5';
  if (agentOnline === false && (commandStatus === 'pending' || !commandStatus)) {
    connectStep = 'VPS Agent ไม่ตอบสนอง — คำสั่ง login อาจค้างในคิว';
  } else if (commandStatus === 'pending' && commandAgeSec != null && commandAgeSec >= 45) {
    connectStep = 'คำสั่ง login ค้างนาน — รอ Agent หรือ restart AvelquaPythonAgent';
  } else if (st === 'checking') {
    connectStep = 'ตรวจ Login — อ่าน Journal';
  } else if (st === 'starting') {
    connectStep = 'เปิด MT5 — รอหน้าต่างโปรแกรม';
  } else if (['processing', 'picked', 'running'].includes(commandStatus)) {
    connectStep = 'Agent รับงานแล้ว — กำลังดำเนินการ';
  } else if (commandStatus === 'pending') {
    connectStep = 'ส่งคำสั่งแล้ว — รอ Agent รับงาน';
  } else if (st === 'connecting') {
    connectStep = 'ส่งคำสั่งไป VPS';
  }

  const waitSec = Math.max(
    Number(elapsedSec) || 0,
    commandAgeSec != null ? commandAgeSec : 0
  );
  const waitHint = buildConnectWaitHint(waitSec);

  return {
    agentOnline,
    agentMessage,
    commandStatus,
    commandMessage,
    commandAgeSec,
    connectStep,
    waitHint,
    waitSec,
    expectedMaxSec: MT5_CONNECT_HINT_TYPICAL_MAX_SEC,
    maxWaitSec: MT5_CONNECT_HINT_HARD_MAX_SEC
  };
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
    WHERE (
        command_type IN ('login_mt5', 'connect_mt5', 'run_mt5_bot', 'run_mt5')
        OR (
          command_type IN ('read_file', 'port_read_file')
          AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
        )
      )
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

function respondConnect(req, res, body, statusCode = 200) {
  const useJson =
    prefersJsonResponse(req) ||
    String(req.headers['content-type'] || '').includes('json');
  if (useJson) {
    return res.status(statusCode).json(body);
  }
  if (
    body.ok &&
    body.accountId &&
    (body.status === 'queued' || body.status === 'connected' || body.status === 'pending')
  ) {
    const q = new URLSearchParams();
    const ps = body.portSlot || req.body?.port_slot || req.body?.portSlot || '';
    if (ps) q.set('port_slot', String(ps));
    q.set('connect_account', String(body.accountId));
    q.set('connect_queued', '1');
    return res.redirect(302, '/app/mt5?' + q.toString());
  }
  const errMsg = encodeURIComponent(String(body.message || 'เชื่อมต่อไม่สำเร็จ').slice(0, 800));
  return res.redirect(302, '/app/mt5?connect_error=' + errMsg);
}

async function handleMt5ConnectProduction(req, res) {
  let lockKey = null;
  let loginLockKey = null;
  let reservedPort = null;

  try {
    await ensureRuntimeColumns();

    const userId = Number((req.user || req.session?.user || {}).id || 0);
    if (!userId) throw new Error('กรุณาเข้าสู่ระบบใหม่');
    const mt5Login = clean(req.body.mt5_login || req.body.mt5Login);
    const mt5Password = clean(req.body.mt5_password || req.body.mt5Password);
    const serverName = normalizeLockedServer(clean(req.body.server_name || req.body.serverName));

    console.log('[mt5-connect] start', { userId, mt5Login, port_slot: req.body.port_slot || req.body.portSlot });

    if (!mt5Login) throw new Error('กรุณากรอก Login MT5');
    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');

    const agentGateEarly = await assertVpsAgentOnline();
    if (!agentGateEarly.ok) {
      throw new Error(agentGateEarly.message);
    }

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

    // ถ้าบัญชีนี้ connected อยู่แล้ว (ผู้ใช้กดเชื่อมต่อซ้ำ) ให้ตอบสำเร็จทันที
    const alreadyConnected = await query(
      `
      SELECT id, port_slot
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND mt5_login=$2
        AND COALESCE(server_name, mt5_server, '')=$3
        AND LOWER(COALESCE(status, ''))='connected'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
      [userId, mt5Login, serverName]
    ).catch(() => ({ rows: [] }));
    if (alreadyConnected.rows?.[0]) {
      const connectedRow = alreadyConnected.rows[0];
      return respondConnect(req, res, {
        ok: true,
        status: 'connected',
        accountId: connectedRow.id,
        portSlot: Number(connectedRow.port_slot || 0) || null,
        message: 'บัญชีนี้เชื่อมต่ออยู่แล้ว'
      });
    }

    // ป้องกันผู้ใช้กดเชื่อมต่อซ้ำแล้วรีสตาร์ท flow เดิมจนคำสั่งถูก cancel วน
    const inProgressAccount = await query(
      `
      SELECT id, port_slot
      FROM vps_system.mt5_accounts
      WHERE user_id=$1
        AND mt5_login=$2
        AND COALESCE(server_name, mt5_server, '')=$3
        AND LOWER(COALESCE(status, '')) IN ('connecting', 'starting', 'checking')
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
      [userId, mt5Login, serverName]
    ).catch(() => ({ rows: [] }));

    if (inProgressAccount.rows?.[0]) {
      const pendingAcc = inProgressAccount.rows[0];
      const activeCmd = await query(
        `
        SELECT id, status
        FROM vps_system.vps_agent_commands
        WHERE command_type IN ('login_mt5', 'connect_mt5')
          AND (payload->>'accountId')::text = $1::text
          AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
          AND created_at > NOW() - INTERVAL '10 minutes'
        ORDER BY
          CASE LOWER(COALESCE(status, ''))
            WHEN 'processing' THEN 0
            WHEN 'picked' THEN 1
            WHEN 'running' THEN 2
            WHEN 'pending' THEN 3
            ELSE 4
          END,
          id DESC
        LIMIT 1
      `,
        [pendingAcc.id]
      ).catch(() => ({ rows: [] }));

      if (activeCmd.rows?.[0]) {
        return respondConnect(req, res, {
          ok: true,
          status: 'queued',
          accountId: pendingAcc.id,
          commandId: activeCmd.rows[0].id,
          portSlot: Number(pendingAcc.port_slot || 0) || null,
          message: 'กำลังเชื่อมต่อบัญชีนี้อยู่แล้ว กรุณารอสักครู่'
        });
      }
    }

    await cancelPendingLoginCommands({ mt5Login });

    const requestedSlot = num(req.body.port_slot || req.body.portSlot);
    const retryPort = await findRetryPortForLogin(userId, mt5Login, serverName);
    let portSlot;

    if (requestedSlot > 0) {
      const alreadyOnSlot = await query(
        `
        SELECT id, status, mt5_login
        FROM vps_system.mt5_accounts
        WHERE user_id=$1
          AND port_slot=$2
          AND mt5_login=$3
          AND COALESCE(server_name, mt5_server, '')=$4
          AND LOWER(COALESCE(status, '')) = 'connected'
        LIMIT 1
      `,
        [userId, requestedSlot, mt5Login, serverName]
      ).catch(() => ({ rows: [] }));
      if (alreadyOnSlot.rows?.[0]) {
        return respondConnect(req, res, {
          ok: true,
          status: 'connected',
          accountId: alreadyOnSlot.rows[0].id,
          portSlot: requestedSlot,
          message: 'บัญชีนี้เชื่อมต่ออยู่แล้วบน PORT นี้'
        });
      }
      if (!(await isUserPortSlotAvailable(userId, requestedSlot, totalPorts))) {
        throw new Error(`PORT ${requestedSlot} ไม่ว่าง กรุณาเลือก PORT ที่ยังไม่ใช้งาน`);
      }
      portSlot = requestedSlot;
      const reserve = await reserveBestPort(userId, requestedSlot);
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
      const reserve = await reserveBestPort(userId, portSlot);
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
        last_journal_evidence=NULL,
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
         last_error, last_login_message, last_journal_evidence, connect_started_at, updated_at)
        VALUES
        ($1,$2,$3,$4,$5,$5,$6,$7,'MH Markets',$8,$8,$9,'connecting',NULL,'กำลังเปิด MT5 และ Login...',NULL,NOW(),NOW())
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
            last_journal_evidence=NULL,
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
    await cancelJournalVerifyForAccount(reservedPort.vps_id, accountId).catch(() => {});
    await cancelJournalVerifyWrongPort(reservedPort.vps_id, accountId, allocPortNo).catch(() => {});
    connectStatusSyncAt.delete(accountId);
    await clearOtherAccountsOnPortSlot(query, userId, portSlot, accountId);

    await expireStalePendingAgentCommands(reservedPort.vps_id, 120).catch(() => ({}));
    await expireStuckMaintenanceCommands(reservedPort.vps_id).catch(() => {});
    await expireStuckLoginCommands(reservedPort.vps_id, 1).catch(() => ({ expired: 0 }));
    await deferMaintenanceForLogin(reservedPort.vps_id).catch(() => {});

    if (reservedPort.admin_node_id && allocPortNo) {
      await setAdminAllocationStatus(
        reservedPort.admin_node_id,
        allocPortNo,
        'locked',
        reservedPort.allocation_id
      ).catch(() => {});
    }

    const payload = buildMt5LoginPayload({
      accountId,
      userId,
      reservedPort,
      portSlot,
      mt5Login,
      mt5Password,
      serverName
    });

    const cmdIns = await insertPendingAgentCommand({
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      commandType: 'login_mt5',
      payload
    });
    const cmd = { rows: [{ id: cmdIns.id }] };

    await query(`
      INSERT INTO vps_system.mt5_login_history
      (user_id, account_id, vps_id, port_id, port_no, mt5_login, server_name, status, message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending','ส่งคำสั่ง login_mt5 แล้ว')
    `, [userId, accountId, reservedPort.vps_id, reservedPort.port_id, allocPortNo, mt5Login, serverName]).catch(() => {});

    const portLabel = String(allocPortNo || portSlot).padStart(2, '0');
    const pickName = reservedPort.node_name
      ? `${reservedPort.node_name} / ${reservedPort.port_name || 'PORT-' + portLabel}`
      : `PORT ${portLabel}`;

    let connectAdvice = null;
    if (process.env.MT5_CONNECT_AI === '1') {
      connectAdvice = await buildConnectAdvice({
        reservedPort: { ...reservedPort, port_number: allocPortNo },
        capital: 0,
        tradeLevel: 'medium'
      }).catch(() => null);
    } else {
      connectAdvice = {
        portScore: 80,
        aiAssisted: false,
        summary: `${pickName} — Login เร็ว (ไม่รอ AI)`,
        recommendedBot: buildDemoTradingPlan({ capital: 1000, tradeLevel: 'medium' }),
        testingHint: 'หลัง Login สำเร็จ → เลือก BOT / ระดับเสี่ยง / ทุน / LOT แล้วกดเปิด BOT'
      };
    }

    console.log('[mt5-connect] queued', {
      userId,
      accountId,
      commandId: cmd.rows?.[0]?.id || cmdIns?.id,
      vpsId: reservedPort.vps_id,
      portSlot
    });

    return respondConnect(req, res, {
      ok: true,
      status: 'queued',
      accountId,
      commandId: cmd.rows?.[0]?.id || cmdIns?.id || null,
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      portNo: allocPortNo,
      portSlot,
      folderPath: reservedPort.folder_path || null,
      message: `กำลังเปิด MT5 — PORT ${portSlot} · โฟลเดอร์ VPS ${pickName} (${serverName})`,
      aiConnect: connectAdvice
    });
  } catch (e) {
    console.warn('[mt5-connect] failed', { userId: req.user?.id, message: e.message });
    if (reservedPort?.port_id) await releasePort(reservedPort.port_id, e.message);
    return respondConnect(req, res, { ok: false, status: 'failed', message: e.message }, 400);
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
    } else {
      where += ` AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired')`;
    }

    const r = await query(`
      SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
             a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
             a.connect_started_at, a.last_balance, a.last_equity,
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

    let a = r.rows?.[0];
    if (!a) return res.json({ ok: true, connected: false, status: 'none', message: 'ยังไม่มีรายการเชื่อมต่อ' });

    // ถ้า front-end ส่ง accountId เก่าที่ถูกลบ/หมดอายุ ให้เด้งไปแถว active ล่าสุดทันที
    if (accountId) {
      const stalePicked = ['deleted', 'expired', 'ready', 'failed'].includes(
        String(a.status || '').toLowerCase()
      );
      if (stalePicked) {
        const byLogin = await query(
          `
          SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
                 a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
                 a.connect_started_at, a.last_balance, a.last_equity,
                 p.folder_path
          FROM vps_system.mt5_accounts a
          LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
          WHERE a.user_id=$1
            AND a.id <> $2
            AND a.mt5_login=$3
            AND COALESCE(a.server_name, a.mt5_server, '') = COALESCE($4, COALESCE(a.server_name, a.mt5_server, ''))
            AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired')
          ORDER BY
            CASE LOWER(COALESCE(a.status, ''))
              WHEN 'connected' THEN 0
              WHEN 'checking' THEN 1
              WHEN 'starting' THEN 2
              WHEN 'connecting' THEN 3
              ELSE 4
            END,
            a.updated_at DESC NULLS LAST,
            a.id DESC
          LIMIT 1
        `,
          [userId, a.id, a.mt5_login, a.server_name || null]
        ).catch(() => ({ rows: [] }));

        if (byLogin.rows?.[0]) {
          a = byLogin.rows[0];
        } else {
          const latestActive = await query(
            `
            SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
                   a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
                   a.connect_started_at, a.last_balance, a.last_equity,
                   p.folder_path
            FROM vps_system.mt5_accounts a
            LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
            WHERE a.user_id=$1
              AND a.id <> $2
              AND LOWER(COALESCE(a.status, '')) IN ('connected', 'connecting', 'starting', 'checking')
              AND a.updated_at > NOW() - INTERVAL '20 minutes'
            ORDER BY
              CASE LOWER(COALESCE(a.status, ''))
                WHEN 'connected' THEN 0
                WHEN 'checking' THEN 1
                WHEN 'starting' THEN 2
                WHEN 'connecting' THEN 3
                ELSE 4
              END,
              a.updated_at DESC NULLS LAST,
              a.id DESC
            LIMIT 1
          `,
            [userId, a.id]
          ).catch(() => ({ rows: [] }));
          if (latestActive.rows?.[0]) a = latestActive.rows[0];
        }
      }
    }

    let statusEarly = String(a.status || '').toLowerCase();

    if (['deleted', 'expired'].includes(statusEarly)) {
      return res.json({
        ok: true,
        connected: false,
        failed: false,
        checking: false,
        pending: false,
        status: 'none',
        staleAccount: true,
        message: 'บัญชีนี้ถูกยกเลิกแล้ว — กรุณากดเชื่อมต่อใหม่',
        elapsedSec: 0
      });
    }

    if (['ready', 'failed'].includes(statusEarly)) {
      const recentOk = await hasRecentAgentLoginSuccess(a.id, a.vps_id, a.mt5_login).catch(() => false);
      const recentCmd = recentOk && a.vps_id
        ? await findRecentLoginCommand(a.id, a.vps_id).catch(() => null)
        : null;
      const finishedAt = recentCmd?.finished_at ? new Date(recentCmd.finished_at).getTime() : 0;
      const freshMs = finishedAt ? Date.now() - finishedAt : Number.MAX_SAFE_INTEGER;

      // บางจังหวะ isPortMt5Running false หลอก ทำให้หลุดเป็น ready ทั้งที่ login เพิ่ง success
      if (recentOk && freshMs <= 5 * 60 * 1000) {
        await promoteAccountConnected({
          accountId: a.id,
          portId: a.port_id,
          mt5Login: a.mt5_login,
          message: MT5_SUCCESS_MSG
        }).catch(() => {});

        const fresh = await query(
          `
          SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
                 a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
                 a.connect_started_at, a.last_balance, a.last_equity,
                 p.folder_path
          FROM vps_system.mt5_accounts a
          LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
          WHERE a.id=$1
          LIMIT 1
        `,
          [a.id]
        ).catch(() => ({ rows: [a] }));
        a = fresh.rows?.[0] || a;
        statusEarly = String(a.status || '').toLowerCase();
      }
    }

    if (['connecting', 'starting', 'checking'].includes(statusEarly)) {
      const loginDoneEarly = await hasRecentAgentLoginSuccess(
        a.id,
        a.vps_id,
        a.mt5_login
      ).catch(() => false);
      if (loginDoneEarly) {
        const recoveredEarly = await tryRecoverLoginFromPortHealth(a).catch(() => ({
          resolved: false
        }));
        if (recoveredEarly.resolved) {
          const accEarly = await query(
            `SELECT a.*, p.folder_path FROM vps_system.mt5_accounts a LEFT JOIN vps_system.vps_ports p ON p.id=a.port_id WHERE a.id=$1`,
            [a.id]
          ).catch(() => ({ rows: [a] }));
          const accNowEarly = accEarly.rows?.[0] || a;
          const previewEarly = previewPublicPath(accNowEarly.id);
          return res.json({
            ok: true,
            account: accNowEarly,
            connected: true,
            failed: false,
            checking: false,
            pending: false,
            status: 'connected',
            loginVerified: true,
            message: recoveredEarly.message || MT5_SUCCESS_MSG,
            windowTitle: windowTitleFromMessage(accNowEarly.last_login_message),
            previewUrl: previewEarly ? `${previewEarly}?t=${Date.now()}` : '',
            elapsedSec: 0
          });
        }
        await promoteAccountConnected({
          accountId: a.id,
          portId: a.port_id,
          mt5Login: a.mt5_login,
          message: MT5_SUCCESS_MSG
        }).catch(() => {});
        const accPromoted = await query(
          `SELECT a.*, p.folder_path FROM vps_system.mt5_accounts a LEFT JOIN vps_system.vps_ports p ON p.id=a.port_id WHERE a.id=$1`,
          [a.id]
        ).catch(() => ({ rows: [a] }));
        const accProm = accPromoted.rows?.[0] || a;
        const previewProm = previewPublicPath(accProm.id);
        return res.json({
          ok: true,
          account: accProm,
          connected: true,
          failed: false,
          checking: false,
          pending: false,
          status: 'connected',
          loginVerified: true,
          message: MT5_SUCCESS_MSG,
          windowTitle: windowTitleFromMessage(accProm.last_login_message),
          previewUrl: previewProm ? `${previewProm}?t=${Date.now()}` : '',
          elapsedSec: 0
        });
      }
    }

    if (statusEarly === 'connected') {
      const liveCheck = await reconcileConnectedAccountLive(a).catch(() => ({
        changed: false,
        account: a
      }));
      const accLive = liveCheck.account || a;
      const stLive = String(accLive.status || '').toLowerCase();
      if (liveCheck.changed && stLive !== 'connected') {
        const recentOk = await hasRecentAgentLoginSuccess(
          a.id,
          a.vps_id,
          a.mt5_login
        ).catch(() => false);
        if (recentOk || hasRecentAccountMetrics(a)) {
          await promoteAccountConnected({
            accountId: a.id,
            portId: a.port_id,
            mt5Login: a.mt5_login,
            message: MT5_SUCCESS_MSG
          }).catch(() => {});
          const accRec = await query(
            `SELECT a.*, p.folder_path FROM vps_system.mt5_accounts a LEFT JOIN vps_system.vps_ports p ON p.id=a.port_id WHERE a.id=$1`,
            [a.id]
          ).catch(() => ({ rows: [a] }));
          const accBack = accRec.rows?.[0] || a;
          const previewBack = previewPublicPath(accBack.id);
          return res.json({
            ok: true,
            account: { ...accBack, status: 'connected' },
            connected: true,
            failed: false,
            checking: false,
            pending: false,
            status: 'connected',
            loginVerified: true,
            message: MT5_SUCCESS_MSG,
            windowTitle: windowTitleFromMessage(accBack.last_login_message),
            previewUrl: previewBack ? `${previewBack}?t=${Date.now()}` : '',
            elapsedSec: 0
          });
        }
        const previewPathReset = previewPublicPath(accLive.id);
        return res.json({
          ok: true,
          account: accLive,
          connected: false,
          failed: stLive === 'failed',
          checking: false,
          pending: false,
          status: stLive,
          loginVerified: false,
          message: liveCheck.message || accLive.last_login_message || accLive.last_error,
          windowTitle: windowTitleFromMessage(accLive.last_login_message),
          previewUrl: previewPathReset ? `${previewPathReset}?t=${Date.now()}` : '',
          elapsedSec: 0,
          mt5Offline: stLive === 'ready'
        });
      }
      const previewPathEarly = previewPublicPath(accLive.id);
      return res.json({
        ok: true,
        account: { ...accLive, status: 'connected' },
        connected: true,
        failed: false,
        checking: false,
        pending: false,
        status: 'connected',
        loginVerified: true,
        message: accLive.last_login_message || MT5_SUCCESS_MSG,
        windowTitle: windowTitleFromMessage(accLive.last_login_message),
        previewUrl: previewPathEarly ? `${previewPathEarly}?t=${Date.now()}` : '',
        elapsedSec: 0
      });
    }

    const startedAt = a.connect_started_at
      ? new Date(a.connect_started_at).getTime()
      : a.updated_at
        ? new Date(a.updated_at).getTime()
        : 0;
    const staleMs = Date.now() - startedAt;
    const elapsedSec = Math.max(0, Math.floor(staleMs / 1000));
    let status = String(a.status || '').toLowerCase();
    const vpsVerRow = a.vps_id
      ? await query(`SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1`, [a.vps_id]).catch(() => ({ rows: [] }))
      : { rows: [] };
    const staleLimitMs = 180 * 1000;

    if (['connecting', 'starting', 'checking'].includes(status) && staleMs > staleLimitMs) {
      const loginDone = await hasRecentAgentLoginSuccess(
        a.id,
        a.vps_id,
        a.mt5_login
      ).catch(() => false);
      if (loginDone) {
        const recovered = await tryRecoverLoginFromPortHealth(a).catch(() => ({
          resolved: false
        }));
        if (recovered.resolved) {
          const accR = await query(
            `SELECT a.*, p.folder_path FROM vps_system.mt5_accounts a LEFT JOIN vps_system.vps_ports p ON p.id=a.port_id WHERE a.id=$1`,
            [a.id]
          ).catch(() => ({ rows: [a] }));
          const accNow = accR.rows?.[0] || a;
          const previewPath = previewPublicPath(accNow.id);
          return res.json({
            ok: true,
            account: accNow,
            connected: true,
            failed: false,
            checking: false,
            pending: false,
            status: 'connected',
            loginVerified: true,
            message: recovered.message || MT5_SUCCESS_MSG,
            windowTitle: windowTitleFromMessage(accNow.last_login_message),
            previewUrl: previewPath ? `${previewPath}?t=${Date.now()}` : '',
            elapsedSec
          });
        }
      } else {
        const cmd = a.vps_id
          ? await findRecentLoginCommand(a.id, a.vps_id).catch(() => null)
          : null;
        const cmdSt = String(cmd?.status || '').toLowerCase();
        if (['pending', 'processing', 'picked', 'running'].includes(cmdSt)) {
          /* Agent ยังทำ login อยู่ — อย่า timeout/kill MT5 */
        } else if (staleMs <= staleLimitMs + 60 * 1000) {
          /* รอเพิ่มอีกนาทีถ้ายังไม่มีคำสั่งค้าง */
        } else {
          const agentLive = a.vps_id
            ? await checkVpsAgentLiveness(a.vps_id).catch(() => ({ ok: false }))
            : { ok: false };
          const staleMsg = agentLive.ok
            ? 'หมดเวลารอการเชื่อมต่อ — กรุณากรอก Login แล้วกดเชื่อมต่อใหม่'
            : (agentLive.message ||
                'VPS Agent ไม่ตอบสนอง — คำสั่ง login ไม่ถูกดำเนินการ กรุณารอแล้วลองใหม่');
          await failAccountFromJournal(a.id, a.port_id, staleMsg, {
            vpsId: a.vps_id,
            portNo: a.assigned_port_no,
            folderPath: a.folder_path,
            reason: 'connect_poll_timeout',
            agentOffline: !agentLive.ok,
            killMt5: false
          }).catch(() => {});
          status = 'failed';
          a.last_error = staleMsg;
          a.last_login_message = staleMsg;
        }
      }
    }

    let statusFinal = status;
    const shouldSyncJournal = ['connecting', 'starting', 'checking'].includes(statusFinal);

    let resolved = { resolved: false };
    if (shouldSyncJournal) {
      const failFast = await tryFastJournalFail(a).catch(() => ({ resolved: false }));
      if (failFast.resolved) {
        resolved = failFast;
        statusFinal = 'failed';
        a.status = 'failed';
        a.last_error = failFast.message || MT5_FAIL_USER_MSG;
        a.last_login_message = a.last_error;
      }
      const portRecover =
        elapsedSec >= 1 && !failFast.resolved
          ? await tryRecoverLoginFromPortHealth(a).catch(() => ({ resolved: false }))
          : { resolved: false };
      if (portRecover.resolved) {
        resolved = portRecover;
        statusFinal = 'connected';
      }
      const fast =
        !failFast.resolved && !portRecover.resolved
          ? await tryFastConnectConfirm(a).catch(() => ({ resolved: false }))
          : { resolved: false };
      if (fast.resolved) {
        resolved = fast;
        statusFinal = fast.status || 'connected';
        const freshFast = await query(
          `
          SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
                 a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
                 a.connect_started_at, a.last_balance, a.last_equity,
                 p.folder_path
          FROM vps_system.mt5_accounts a
          LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
          WHERE a.id=$1 AND a.user_id=$2
          LIMIT 1
        `,
          [a.id, userId]
        ).catch(() => ({ rows: [] }));
        if (freshFast.rows?.[0]) {
          Object.assign(a, freshFast.rows[0]);
          statusFinal = String(a.status || statusFinal).toLowerCase();
        }
      }
    }
    if (shouldSyncJournal && !resolved.resolved && elapsedSec >= 22 && a.folder_path && a.vps_id && a.mt5_login) {
      const recentCmd = await findRecentLoginCommand(a.id, a.vps_id).catch(() => null);
      const recentSt = String(recentCmd?.status || '').toLowerCase();
      if (!['success', 'done'].includes(recentSt)) {
        await queueJournalReadVerify({
          accountId: a.id,
          vpsId: a.vps_id,
          folderPath: a.folder_path,
          mt5Login: a.mt5_login,
          portNo: a.assigned_port_no || a.port_slot,
          allowDuringLogin: true
        }).catch(() => {});
      }
    }
    if (shouldSyncJournal && !resolved.resolved) {
      const syncNow = Date.now();
      const lastSync = connectStatusSyncAt.get(a.id) || 0;
      const doSync = syncNow - lastSync >= CONNECT_STATUS_SYNC_MS;
      if (doSync) {
        connectStatusSyncAt.set(a.id, syncNow);
        await syncJournalFromLatestCommand(
          a.id,
          a.vps_id,
          a.mt5_login,
          a.folder_path,
          a.assigned_port_no
        ).catch(() => {});
      }
      const freshRow = await query(`
        SELECT a.id, a.status, a.last_error, a.last_login_message, a.vps_id, a.port_id,
               a.port_slot, a.assigned_port_no, a.mt5_login, a.server_name, a.updated_at,
               a.connect_started_at, a.last_balance, a.last_equity,
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
      if (
        doSync &&
        ['connecting', 'starting', 'checking'].includes(statusFinal)
      ) {
        resolved = await resolveStuckLoginAccount(a).catch(() => ({ resolved: false }));
      }
    }

    if (['connecting', 'starting', 'checking'].includes(statusFinal)) {
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
    const diagnostics = inProgress ? await getLoginConnectDiagnostics(a, elapsedSec) : null;
    let userMessage = statusFinal === 'connected'
      ? MT5_SUCCESS_MSG
      : statusFinal === 'failed'
        ? (failedMsg || 'เชื่อมต่อไม่สำเร็จผู้ใช้งานผิด')
        : (a.last_login_message || a.last_error || statusFinal);
    if (inProgress) {
      const upgradeHint = /อัปเดต Agent|รอ 2.?3 นาที|Restart-Service/i.test(
        String(a.last_login_message || '')
      );
      const stepHint = diagnostics?.connectStep || '';
      const baseMsg = upgradeHint
        ? `กำลังเปิด MT5 และ Login... (${elapsedSec} วินาที)`
        : (a.last_login_message || `กำลังเปิด MT5 และตรวจสอบ Login (${elapsedSec} วินาที)...`);
      userMessage = stepHint && !baseMsg.includes(stepHint)
        ? `${stepHint} — ${baseMsg}`
        : baseMsg;
    }
    const loginVerified = statusFinal === 'connected';
    if (loginVerified && !positiveMoney(a.last_equity)) {
      ensureEquityOnConnect(a.id, userId, () => loadAccountPortContext(a.id, userId)).catch(() => {});
    }
    const previewPath = previewPublicPath(a.id);
    const previewUrl = previewPath ? `${previewPath}?t=${Date.now()}` : '';
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
      connectStep: diagnostics?.connectStep || '',
      agentOnline: diagnostics?.agentOnline ?? null,
      agentMessage: diagnostics?.agentMessage || '',
      commandStatus: diagnostics?.commandStatus || '',
      commandMessage: diagnostics?.commandMessage || '',
      commandAgeSec: diagnostics?.commandAgeSec ?? null,
      waitHint: diagnostics?.waitHint || '',
      waitSec: diagnostics?.waitSec ?? elapsedSec,
      expectedMaxSec: diagnostics?.expectedMaxSec ?? MT5_CONNECT_HINT_TYPICAL_MAX_SEC,
      maxWaitSec: diagnostics?.maxWaitSec ?? MT5_CONNECT_HINT_HARD_MAX_SEC
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

module.exports = router;
