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
const {
  resolveStuckLoginAccount,
  syncJournalFromLatestCommand,
  failAccountFromJournal,
  promoteAccountConnected,
  isLegacyWindowVerifiedMessage
} = require('../lib/mt5LoginCommandVerify');
const { previewPublicPath, windowTitleFromMessage } = require('../lib/mt5Preview');
const { normalizeLockedServer, MT5_LOCKED_SERVER, MT5_SUCCESS_MSG } = require('../lib/mt5Server');
const { expireStuckMaintenanceCommands } = require('../lib/agentDeploy');
const {
  reserveAdminPortForLogin,
  buildMt5LoginPayload
} = require('../lib/adminVpsPortPicker');
const { setAdminAllocationStatus, parsePortNumber } = require('../lib/adminVpsBridge');
const { clearOtherAccountsOnPortSlot } = require('../lib/mt5PortAccount');

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
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance NUMERIC`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity NUMERIC`).catch(() => {});
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

async function handleMt5ConnectProduction(req, res) {
  let lockKey = null;
  let loginLockKey = null;
  let reservedPort = null;

  try {
    await ensureRuntimeColumns();

    const userId = req.user.id;
    const mt5Login = clean(req.body.mt5_login || req.body.mt5Login);
    const mt5Password = clean(req.body.mt5_password || req.body.mt5Password);
    const serverName = normalizeLockedServer(clean(req.body.server_name || req.body.serverName));

    if (!mt5Login) throw new Error('กรุณากรอก Login MT5');
    if (!mt5Password) throw new Error('กรุณากรอกรหัสผ่าน MT5');

    lockKey = userLockKey(userId);
    const locked = await redis.set(lockKey, '1', 'NX', 'EX', USER_LOCK_TTL);
    if (!locked) throw new Error('ระบบกำลังเชื่อมต่อบัญชีนี้อยู่ กรุณารอสักครู่');

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
        portSlot = await getNextUserSlot(userId, totalPorts);
        if (
          uiPreferredSlot > 0 &&
          uiPreferredSlot <= totalPorts &&
          (await isUserPortSlotAvailable(userId, uiPreferredSlot, totalPorts))
        ) {
          portSlot = uiPreferredSlot;
        }
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
        const reserve = await reserveBestPort(userId);
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

    const payload = buildMt5LoginPayload({
      accountId,
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
      commandId: cmd.rows?.[0]?.id || null,
      vpsId: reservedPort.vps_id,
      portId: reservedPort.port_id,
      portNo: allocPortNo,
      portSlot,
      message: `กำลังเปิด MT5 — แพ็กเกจ PORT ${portSlot} / ${pickName} (${serverName})`
    });
  } catch (e) {
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
    const vpsVerRow = a.vps_id
      ? await query(`SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1`, [a.vps_id]).catch(() => ({ rows: [] }))
      : { rows: [] };
    const staleLimitMs = 120 * 1000;

    if (['connecting', 'starting', 'checking'].includes(status) && staleMs > staleLimitMs) {
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

    let statusFinal = status;
    const windowHint = isLegacyWindowVerifiedMessage(a.last_login_message || '');
    const shouldSyncJournal = ['connecting', 'starting', 'checking'].includes(statusFinal)
      && staleMs >= 2500
      && !windowHint;

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
      (msgBlob.includes(loginInMsg) || /window verified|เชื่อมต่อสำเร็จ/i.test(msgBlob));

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

    if (['connecting', 'starting', 'checking'].includes(statusFinal)) {
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
        ? (failedMsg || 'เชื่อมต่อไม่สำเร็จผู้ใช้งานผิด')
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
      elapsedSec
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
