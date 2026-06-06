'use strict';

const { query, getClient } = require('../config/database');
const { adminPortToSystemPortNo, reserveAdminPortForLogin } = require('./adminVpsPortPicker');
const { portNoVariants } = require('./mt5PortIsolation');
const { vpsPortNotBusyByOthersClause, assertFolderPortFreeForUser } = require('./mt5PortSlotGuard');
const { normalizeSystemFolderPortNo } = require('./mt5ReservedPortNo');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const ACTIVE_BINDING_STATUSES = [
  'connected',
  'ready',
  'connecting',
  'checking',
  'starting'
];

function canonicalFolderPortNo(portSlot) {
  return normalizeSystemFolderPortNo(adminPortToSystemPortNo(num(portSlot)));
}

function isMisboundSlotFolder(portSlot, assignedPortNo) {
  const slot = num(portSlot);
  const expected = canonicalFolderPortNo(slot);
  const actual = normalizeSystemFolderPortNo(assignedPortNo);
  return slot > 0 && expected > 0 && actual > 0 && actual !== expected;
}

/** SQL: บล็อกเฉพาะ slot อื่นที่ผูก folder ถูกต้อง — ไม่นับ misbind ค้าง */
function otherSlotCorrectlyBoundFolderClause(userIdParam, slotParam) {
  void userIdParam;
  void slotParam;
  return `
  AND (
    a.assigned_port_no = (100 + a.port_slot)
    OR (a.assigned_port_no = a.port_slot AND a.port_slot > 0 AND a.port_slot < 100)
  )
  `;
}

/** ยกเลิก/แก้ slot อื่นที่ผูก folder ผิดแล้วบล็อก canonical ของ slot เป้าหมาย */
async function clearMisboundFolderBlockers(userId, targetSlot) {
  const uid = num(userId);
  const slot = num(targetSlot);
  const canonicalNo = canonicalFolderPortNo(slot);
  if (!uid || !slot || !canonicalNo) return 0;

  await repairMisboundSlotFolderBindings(uid).catch(() => 0);

  const variants = portNoVariants(canonicalNo);
  let cleared = 0;

  const portIds = await query(
    `
    SELECT id
    FROM vps_system.vps_ports
    WHERE port_no = ANY($1::int[])
  `,
    [variants]
  ).catch(() => ({ rows: [] }));
  const pidList = (portIds.rows || []).map((r) => num(r.id)).filter((n) => n > 0);

  const cancelled = await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='cancelled',
        assigned_port_no=NULL,
        windows_port_no=NULL,
        vps_id=NULL,
        port_id=NULL,
        last_login_message='ยกเลิก — PORT อื่นผูก FolderPort นี้ผิด',
        updated_at=NOW()
    WHERE user_id=$1
      AND port_slot IS NOT NULL
      AND port_slot <> $2
      AND LOWER(COALESCE(status, '')) IN ('checking', 'connecting', 'starting', 'ready')
      AND (
        assigned_port_no = ANY($3::int[])
        OR ($4::bigint[] IS NOT NULL AND port_id = ANY($4::bigint[]))
      )
      AND NOT (
        assigned_port_no = (100 + port_slot)
        OR (assigned_port_no = port_slot AND port_slot > 0 AND port_slot < 100)
      )
    RETURNING id
  `,
    [uid, slot, variants, pidList.length ? pidList : null]
  ).catch(() => ({ rows: [] }));
  cleared += cancelled.rows?.length || 0;

  const repairedAgain = await repairMisboundSlotFolderBindings(uid).catch(() => 0);
  return cleared + repairedAgain;
}

const ACTIVE_BOT_STATUSES = [
  'running',
  'pending',
  'starting',
  'connecting',
  'restarting'
];

/** แก้บัญชีที่ผูก folder ผิด slot (เช่น PORT 2 ไปอยู่ 103) ให้กลับ folder มาตรฐาน */
async function repairMisboundSlotFolderBindings(userId) {
  const uid = num(userId);
  if (!uid) return 0;

  const r = await query(
    `
    SELECT a.id, a.port_slot, a.assigned_port_no, a.vps_id, a.status
    FROM vps_system.mt5_accounts a
    WHERE a.user_id = $1
      AND a.port_slot IS NOT NULL
      AND a.assigned_port_no IS NOT NULL
      AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired', 'cancelled')
    ORDER BY a.port_slot ASC, a.updated_at DESC, a.id DESC
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  let repaired = 0;
  for (const row of r.rows || []) {
    const slot = num(row.port_slot);
    if (!isMisboundSlotFolder(slot, row.assigned_port_no)) continue;

    const expectedNo = canonicalFolderPortNo(slot);
    const vpsId = num(row.vps_id);

    const botRunning = await query(
      `
      SELECT 1
      FROM vps_system.bot_instances bi
      WHERE bi.mt5_account_id = $1
        AND bi.stopped_at IS NULL
        AND LOWER(TRIM(COALESCE(bi.status, ''))) = ANY($2::text[])
      LIMIT 1
    `,
      [row.id, ACTIVE_BOT_STATUSES]
    ).catch(() => ({ rows: [] }));
    if (botRunning.rows?.[0]) continue;

    const canonRes = await query(
      `
      SELECT id, vps_id, port_no, folder_path
      FROM vps_system.vps_ports
      WHERE port_no = $1
        AND ($2::bigint <= 0 OR vps_id = $2)
      ORDER BY CASE WHEN vps_id = $2 THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `,
      [expectedNo, vpsId]
    ).catch(() => ({ rows: [] }));
    const canon = canonRes.rows?.[0];
    if (!canon) continue;

    const occOnCanonical = await query(
      `
      SELECT a.id, a.port_slot
      FROM vps_system.mt5_accounts a
      WHERE a.user_id = $1
        AND a.id <> $2
        AND a.assigned_port_no = ANY($3::int[])
        AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired', 'failed', 'cancelled')
      ORDER BY a.updated_at DESC
      LIMIT 1
    `,
      [uid, row.id, portNoVariants(expectedNo)]
    ).catch(() => ({ rows: [] }));

    const other = occOnCanonical.rows?.[0];
    if (other && num(other.port_slot) !== slot) continue;

    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET port_id = $2,
          vps_id = $3,
          assigned_port_no = $4,
          windows_port_no = $4,
          last_login_message = COALESCE(NULLIF(last_login_message, ''), 'พร้อมรัน') || ' [แก้ผูก FolderPort]',
          updated_at = NOW()
      WHERE id = $1
    `,
      [row.id, canon.id, canon.vps_id, canon.port_no]
    ).catch(() => {});
    repaired += 1;
  }

  return repaired;
}

/** ห้ามจอง folder ที่ package port_slot อื่นของ user คนเดียวกันใช้อยู่ */
function folderNotUsedByOtherUserSlotClause(userIdParam, slotParam) {
  const u = `$${Number(userIdParam) || 1}`;
  const s = `$${Number(slotParam) || 2}`;
  return `
  AND NOT EXISTS (
    SELECT 1
    FROM vps_system.mt5_accounts a
    WHERE a.user_id = ${u}
      AND a.port_slot IS NOT NULL
      AND a.port_slot <> ${s}
      AND (
        a.port_id = p.id
        OR a.assigned_port_no = p.port_no
        OR a.assigned_port_no = ANY(
          ARRAY[p.port_no, CASE WHEN p.port_no >= 100 THEN p.port_no - 100 ELSE p.port_no + 100 END]
        )
      )
      AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired', 'failed', 'cancelled')
      ${otherSlotCorrectlyBoundFolderClause(userIdParam, slotParam)}
  )
  `;
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
  if (acc.rows?.[0]) {
    const row = acc.rows[0];
    if (isMisboundSlotFolder(row.port_slot, row.assigned_port_no)) return null;
    return { type: 'account', ...row };
  }

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

  const occSlot = num(occupant.port_slot);
  const occAssigned = num(occupant.assigned_port_no) || num(portNo);
  if (occSlot > 0 && isMisboundSlotFolder(occSlot, occAssigned)) {
    if (userId > 0 && num(occupant.user_id) === userId) {
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET status='cancelled',
            assigned_port_no=NULL,
            windows_port_no=NULL,
            vps_id=NULL,
            port_id=NULL,
            last_login_message='ยกเลิก — ผูก FolderPort ไม่ตรง PORT',
            updated_at=NOW()
        WHERE id=$1 AND user_id=$2
      `,
        [occupant.id, userId]
      ).catch(() => {});
    }
    return false;
  }

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
      AND LOWER(COALESCE(a.status, '')) = ANY($3::text[])
      AND COALESCE(a.assigned_port_no, p.port_no, 0) = $4
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
    [uid, slot, ACTIVE_BINDING_STATUSES, canonicalFolderPortNo(slot)]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row) return null;
  const boundNo = normalizeSystemFolderPortNo(num(row.assigned_port_no || row.port_no));
  if (boundNo && boundNo !== canonicalFolderPortNo(slot)) return null;
  return row;
}

/** จอง FolderPort มาตรฐานของ package port_slot (PORT 2 → 102) — ห้ามข้ามไป folder อื่น */
async function reserveCanonicalFolderForSlot(userId, portSlot, opts = {}) {
  const uid = num(userId);
  const slot = num(portSlot);
  const canonicalNo = canonicalFolderPortNo(slot);
  if (!uid || !slot || !canonicalNo) return null;

  if (!opts.skipRepair) {
    await clearMisboundFolderBlockers(uid, slot).catch(() => 0);
  }

  const occupied = await query(
    `
    SELECT a.port_slot, a.mt5_login, a.status
    FROM vps_system.mt5_accounts a
    WHERE a.user_id = $1
      AND a.port_slot IS NOT NULL
      AND a.port_slot <> $2
      AND a.assigned_port_no = ANY($3::int[])
      AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired', 'failed', 'cancelled')
      AND (
        a.assigned_port_no = (100 + a.port_slot)
        OR (a.assigned_port_no = a.port_slot AND a.port_slot > 0 AND a.port_slot < 100)
      )
    ORDER BY a.updated_at DESC
    LIMIT 1
  `,
    [uid, slot, portNoVariants(canonicalNo)]
  ).catch(() => ({ rows: [] }));

  const blocker = occupied.rows?.[0];
  if (blocker) {
    if (!opts.retriedRepair) {
      const cleared = await clearMisboundFolderBlockers(uid, slot).catch(() => 0);
      if (cleared > 0) {
        return reserveCanonicalFolderForSlot(userId, portSlot, { ...opts, retriedRepair: true });
      }
    }
    if (isMisboundSlotFolder(blocker.port_slot, canonicalNo)) {
      return {
        ok: false,
        code: 'SLOT_FOLDER_BUSY',
        message: `FolderPort ${canonicalNo} ถูก PORT ${blocker.port_slot} ผูกผิดค้างอยู่ — ลองรีเฟรชหน้าแล้ว login อีกครั้ง`
      };
    }
    return {
      ok: false,
      code: 'SLOT_FOLDER_BUSY',
      message: `FolderPort ${canonicalNo} ถูก PORT ${blocker.port_slot} ใช้อยู่แล้ว — ไม่ข้าม Folder`
    };
  }

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
      WHERE p.port_no = ANY($3::int[])
        AND (
          LOWER(COALESCE(p.status, '')) IN ('available', 'free', 'idle', 'running', 'busy', 'used')
          OR (
            LOWER(COALESCE(p.status, '')) = 'locked'
            AND (
              p.locked_by_user_id = $1
              OR p.locked_until IS NULL
              OR p.locked_until < NOW()
            )
          )
        )
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
            AND a.assigned_port_no = ANY($3::int[])
            AND LOWER(COALESCE(a.status, '')) IN ('connecting', 'checking', 'connected', 'ready', 'starting')
            AND a.port_slot IS NOT NULL
            AND a.port_slot <> $2
            AND (
              a.assigned_port_no = (100 + a.port_slot)
              OR (a.assigned_port_no = a.port_slot AND a.port_slot > 0 AND a.port_slot < 100)
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM vps_system.bot_instances bi
          WHERE bi.vps_id = p.vps_id
            AND bi.assigned_port_no = ANY($3::int[])
            AND bi.stopped_at IS NULL
            AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
              'running', 'pending', 'starting', 'connecting', 'restarting'
            )
        )
        ${folderNotUsedByOtherUserSlotClause(1, 2)}
        ${vpsPortNotBusyByOthersClause(1)}
      ORDER BY COALESCE(n.cpu_percent, 0) ASC, COALESCE(n.ping_ms, 0) ASC, p.id ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `,
      [uid, slot, portNoVariants(canonicalNo)]
    );

    let port = portRes.rows[0];
    if (!port) {
      await client.query(
        `
        UPDATE vps_system.vps_ports
        SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
        WHERE port_no = ANY($1::int[])
          AND LOWER(COALESCE(status, '')) IN ('running', 'busy', 'used', 'locked')
          AND NOT EXISTS (
            SELECT 1 FROM vps_system.mt5_accounts a
            WHERE a.port_id = vps_ports.id
              AND LOWER(COALESCE(a.status, '')) IN ('connecting', 'checking', 'connected', 'ready', 'starting')
          )
      `,
        [portNoVariants(canonicalNo)]
      ).catch(() => {});

      const retry = await client.query(
        `
        SELECT p.id AS port_id, p.vps_id, p.port_no, p.folder_path, p.status
        FROM vps_system.vps_ports p
        WHERE p.port_no = ANY($1::int[])
          AND LOWER(COALESCE(p.status, '')) IN ('available', 'free', 'idle')
        ORDER BY p.id ASC
        LIMIT 1
        FOR UPDATE OF p SKIP LOCKED
      `,
        [portNoVariants(canonicalNo)]
      );
      port = retry.rows?.[0];
    }

    if (!port) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'CANONICAL_FOLDER_BUSY',
        message: `FolderPort ${canonicalNo} สำหรับ PORT ${slot} ไม่ว่าง — รอให้ว่างก่อน (ไม่ข้าม Folder)`
      };
    }

    await clearMisboundFolderBlockers(uid, slot).catch(() => 0);
    const folderBusy = await isSystemPortOccupied(port.vps_id, port.port_no, { userId: uid, portSlot: slot });
    if (folderBusy) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'CANONICAL_FOLDER_BUSY',
        message: `FolderPort ${canonicalNo} สำหรับ PORT ${slot} ถูกใช้งานอยู่ — รอให้ว่างก่อน`
      };
    }

    const guard = await assertFolderPortFreeForUser(port.vps_id, port.port_no, uid);
    if (!guard.ok) {
      await client.query('ROLLBACK');
      return { ok: false, message: guard.message };
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
  const canonical = canonicalFolderPortNo(slot);
  if (slot > 0 && canonical > 0 && portNo !== canonical) {
    return null;
  }

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
  const uid = num(userId);
  const slot = num(portSlot);

  if (slot > 0) {
    const canonical = await reserveCanonicalFolderForSlot(uid, slot);
    if (canonical?.ok) return canonical;
    return canonical || {
      ok: false,
      message: `FolderPort ${canonicalFolderPortNo(slot)} สำหรับ PORT ${slot} ไม่ว่าง — ไม่ข้าม Folder`
    };
  }

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
        ${folderNotUsedByOtherUserSlotClause(1, 2)}
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
  if (uid && slot > 0) {
    await repairMisboundSlotFolderBindings(uid).catch(() => 0);
  }
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
  reserveCanonicalFolderForSlot,
  repairMisboundSlotFolderBindings,
  canonicalFolderPortNo,
  isMisboundSlotFolder,
  normalizeSystemFolderPortNo
};
