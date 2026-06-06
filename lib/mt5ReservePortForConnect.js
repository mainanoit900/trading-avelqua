'use strict';

const { query, getClient } = require('../config/database');
const { reserveAdminPortForLogin } = require('./adminVpsPortPicker');
const { portNoVariants } = require('./mt5PortIsolation');
const { vpsPortNotBusyByOthersClause, assertFolderPortFreeForUser } = require('./mt5PortSlotGuard');
const { normalizeSystemFolderPortNo } = require('./mt5ReservedPortNo');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

async function findOccupantForFolderPort(vpsId, portNo) {
  const nodeId = num(vpsId);
  const variants = portNoVariants(portNo);
  if (!nodeId || !variants.length) return null;

  const acc = await query(
    `
    SELECT id, user_id, port_slot, assigned_port_no, status
    FROM vps_system.mt5_accounts
    WHERE vps_id = $1
      AND assigned_port_no = ANY($2::int[])
      AND LOWER(COALESCE(status, '')) IN ('connecting', 'checking', 'connected', 'ready', 'starting')
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [nodeId, variants]
  ).catch(() => ({ rows: [] }));
  if (acc.rows?.[0]) return { type: 'account', ...acc.rows[0] };

  const bot = await query(
    `
    SELECT bi.id, bi.user_id, bi.assigned_port_no, bi.status, a.port_slot
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
    WHERE bi.vps_id = $1
      AND bi.assigned_port_no = ANY($2::int[])
      AND bi.stopped_at IS NULL
      AND LOWER(COALESCE(bi.status, '')) IN ('running', 'pending', 'restarting', 'starting', 'connecting')
    ORDER BY bi.updated_at DESC
    LIMIT 1
  `,
    [nodeId, variants]
  ).catch(() => ({ rows: [] }));
  if (bot.rows?.[0]) return { type: 'bot', ...bot.rows[0] };

  return null;
}

async function isSystemPortOccupied(vpsId, portNo, opts = {}) {
  const nodeId = num(vpsId);
  const variants = portNoVariants(portNo);
  const userId = num(opts.userId);
  const portSlot = num(opts.portSlot);
  if (!nodeId || !variants.length) return false;

  const port = await query(
    `
    SELECT 1
    FROM vps_system.vps_ports
    WHERE vps_id = $1
      AND port_no = ANY($2::int[])
      AND LOWER(COALESCE(status, '')) IN ('locked', 'running', 'busy', 'used')
    LIMIT 1
  `,
    [nodeId, variants]
  ).catch(() => ({ rows: [] }));
  if (port.rows?.[0]) return true;

  const occupant = await findOccupantForFolderPort(nodeId, portNo);
  if (!occupant) return false;

  if (
    userId > 0
    && portSlot > 0
    && num(occupant.user_id) === userId
    && num(occupant.port_slot) === portSlot
  ) {
    return false;
  }
  return true;
}

/** FolderPort ที่ package port_slot นี้เคยผูกไว้ — ห้ามข้ามไป folder อื่น */
async function findUserSlotBoundPort(userId, portSlot) {
  const uid = num(userId);
  const slot = num(portSlot);
  if (!uid || !slot) return null;

  const r = await query(
    `
    SELECT
      a.port_id,
      a.vps_id,
      a.assigned_port_no,
      p.port_no,
      p.folder_path,
      n.node_name
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    LEFT JOIN vps_system.vps_nodes n ON n.id = a.vps_id
    WHERE a.user_id = $1
      AND a.port_slot = $2
      AND a.port_id IS NOT NULL
    ORDER BY
      CASE LOWER(COALESCE(a.status, ''))
        WHEN 'connected' THEN 0
        WHEN 'ready' THEN 1
        WHEN 'connecting' THEN 2
        WHEN 'checking' THEN 3
        ELSE 4
      END,
      a.updated_at DESC,
      a.id DESC
    LIMIT 1
  `,
    [uid, slot]
  ).catch(() => ({ rows: [] }));

  return r.rows?.[0] || null;
}

async function lockVpsPortRow(portId, userId) {
  await query(
    `
    UPDATE vps_system.vps_ports
    SET status='locked', locked_by_user_id=$2, locked_until=NOW() + INTERVAL '3 minutes', updated_at=NOW()
    WHERE id=$1
  `,
    [portId, userId]
  ).catch(() => {});
}

function portResultFromRow(port) {
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

async function tryReuseBoundPort(userId, portId, portSlot = 0) {
  const pid = num(portId);
  if (!pid) return null;

  const row = await query(
    `
    SELECT p.id AS port_id, p.vps_id, p.port_no, p.folder_path, n.node_name
    FROM vps_system.vps_ports p
    INNER JOIN vps_system.vps_nodes n ON n.id = p.vps_id
    WHERE p.id = $1
    LIMIT 1
  `,
    [pid]
  ).catch(() => ({ rows: [] }));

  const port = row.rows?.[0];
  if (!port || !String(port.folder_path || '').trim()) return null;

  const portNo = num(port.port_no);
  const slot = num(portSlot);
  const occupied = await isSystemPortOccupied(port.vps_id, portNo, { userId, portSlot: slot });

  if (occupied) {
    const occ = await findOccupantForFolderPort(port.vps_id, portNo);
    const otherSlot = num(occ?.port_slot);
    if (occ && num(occ.user_id) === num(userId) && otherSlot > 0 && otherSlot !== slot) {
      return {
        ok: false,
        message: `FolderPort ${normalizeSystemFolderPortNo(portNo)} ถูก PORT ${otherSlot} ใช้อยู่แล้ว — ไม่ข้าม Folder`
      };
    }
    return {
      ok: false,
      message: `FolderPort ${normalizeSystemFolderPortNo(portNo)} ถูกใช้งานอยู่ — รอให้ว่างก่อน`
    };
  }

  const guard = await assertFolderPortFreeForUser(port.vps_id, portNo, userId);
  if (!guard.ok) return { ok: false, message: guard.message };

  await lockVpsPortRow(port.port_id, userId);
  return portResultFromRow(port);
}

async function reserveMt5PortFallback(userId, portSlot = 0) {
  const adminReserve = await reserveAdminPortForLogin(userId);
  if (adminReserve.ok) return adminReserve;

  const uid = num(userId);
  const slot = num(portSlot);
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

    const portRes = await client.query(
      `
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
        AND NOT EXISTS (
          SELECT 1
          FROM vps_system.mt5_accounts a
          WHERE a.vps_id = p.vps_id
            AND a.assigned_port_no = ANY(
              ARRAY[p.port_no, CASE WHEN p.port_no >= 100 THEN p.port_no - 100 ELSE p.port_no + 100 END]
            )
            AND LOWER(COALESCE(a.status, '')) IN ('connecting', 'checking', 'connected', 'ready', 'starting')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM vps_system.bot_instances bi
          WHERE bi.vps_id = p.vps_id
            AND bi.assigned_port_no = ANY(
              ARRAY[p.port_no, CASE WHEN p.port_no >= 100 THEN p.port_no - 100 ELSE p.port_no + 100 END]
            )
            AND bi.stopped_at IS NULL
            AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
              'running', 'pending', 'starting', 'connecting', 'restarting'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM vps_system.mt5_accounts a
          WHERE a.user_id = $1
            AND a.port_slot IS NOT NULL
            AND ($2::int <= 0 OR a.port_slot <> $2)
            AND (
              a.port_id = p.id
              OR a.assigned_port_no = p.port_no
            )
            AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired', 'failed', 'cancelled')
        )
        ${vpsPortNotBusyByOthersClause(1)}
      ORDER BY COALESCE(n.cpu_percent, 0) ASC, COALESCE(n.ping_ms, 0) ASC, p.port_no ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `,
      [uid, slot]
    );

    const port = portRes.rows[0];
    if (!port) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        message: adminReserve.message || 'ไม่มี Folder PORT ว่างบน VPS — รอ PORT ว่างหรือหยุดบอทที่ใช้งานอยู่'
      };
    }

    await client.query(
      `
      UPDATE vps_system.vps_ports
      SET status='locked', locked_by_user_id=$1, locked_until=NOW() + INTERVAL '3 minutes', updated_at=NOW()
      WHERE id=$2
    `,
      [uid, port.port_id]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      port: {
        port_id: port.port_id,
        vps_id: port.vps_id,
        port_number: port.port_no,
        port_no: port.port_no,
        folder_path: port.folder_path
      }
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * จอง Folder PORT บน VPS — package port_slot ผูก folder เดิม ไม่ข้ามไปเคลียร์ slot อื่น
 */
async function reserveVpsPortForConnect(userId, existingPortId, portSlot = 0) {
  const uid = num(userId);
  const slot = num(portSlot);
  let pid = num(existingPortId);

  if (!pid && slot > 0) {
    const bound = await findUserSlotBoundPort(uid, slot);
    if (bound?.port_id) pid = num(bound.port_id);
  }

  if (pid > 0) {
    const reused = await tryReuseBoundPort(uid, pid, slot);
    if (reused?.ok) return reused;
    if (reused && reused.ok === false) return reused;
  }

  return reserveMt5PortFallback(uid, slot);
}

function vpsPortFolderRegexForSlot(slot) {
  const s = Math.max(1, num(slot));
  return `-PORT-${String(s).padStart(2, '0')}([^0-9]|$)`;
}

async function releaseVpsPortReservation(portId, message = '') {
  const pid = num(portId);
  if (!pid) return;
  await query(
    `
    UPDATE vps_system.vps_ports
    SET status='available',
        locked_by_user_id=NULL,
        locked_until=NULL,
        process_id=NULL,
        mt5_login=NULL,
        current_mt5_login=NULL,
        last_error=$2,
        updated_at=NOW()
    WHERE id=$1
  `,
    [pid, message || null]
  ).catch(() => {});
}

module.exports = {
  reserveVpsPortForConnect,
  releaseVpsPortReservation,
  vpsPortFolderRegexForSlot,
  findUserSlotBoundPort,
  normalizeSystemFolderPortNo
};
