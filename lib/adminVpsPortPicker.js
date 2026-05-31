'use strict';

/**
 * เลือก VPS + Folder PORT ว่างจากตารางเดียวกับ /admin/vps
 * - ข้าม PORT ที่ Admin ปิด (status disabled)
 * - ข้าม PORT ที่ MT5 รันอยู่จริง (vps_port_health)
 * - ข้าม VPS ที่ CPU/RAM/PING เกิน threshold จาก /admin/vps/:id/edit
 * - ถ้า VPS เต็ม/เกิน limit จะไม่มีแถวจาก VPS นั้น → pickBest เลือก VPS ถัดไป
 */

const { query, getClient } = require('../config/database');
const { fetchVpsActiveLoginLoadMap, loginLoadFor } = require('./vpsLoginLoad');
const { MT5_LOCKED_SERVER, normalizeLockedServer } = require('./mt5Server');
const { systemPortNoFromReservedPort } = require('./mt5ReservedPortNo');
const { assertFolderPortFreeForUser } = require('./mt5PortSlotGuard');
const {
  resolveSystemVpsId,
  VPS_ALLOC_PORT_NO_SQL,
  parsePortNumber,
  isPortAdminDisabled,
  isAdminPortAvailableForLogin,
  isVpsNodeEligibleForLogin,
  fetchLiveHealthMap,
  fetchDbMt5UsageMap,
  ensureVpsAllocationsAdminColumns,
  setAdminAllocationStatus
} = require('./adminVpsBridge');

const PORT_LOCK_MINUTES = Number(process.env.MT5_PORT_LOCK_MINUTES || 3);
const PUBLIC_CALLBACK_BASE = (process.env.AVELQUA_PUBLIC_URL || 'https://trading.avelqua.com').replace(
  /\/$/,
  ''
);

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** แมปเลข PORT จาก admin → vps_system.vps_ports.port_no (เช่น 1 → 101) */
function adminPortToSystemPortNo(portNo) {
  const n = num(portNo);
  if (n <= 0) return 0;
  if (n >= 100) return n;
  return 100 + n;
}

/** เลือก PORT ต่ำสุดที่ว่างก่อน (1→20) — กระจาย login พร้อมกันไป VPS ที่โหลดน้อยก่อน */
function pickBestPortRow(rows, loginLoadMap = null) {
  const loadMap = loginLoadMap && typeof loginLoadMap === 'object' ? loginLoadMap : {};
  const list = (rows || []).filter((r) => !isPortAdminDisabled(r));
  list.sort(
    (a, b) =>
      loginLoadFor(loadMap, a.system_vps_id) - loginLoadFor(loadMap, b.system_vps_id) ||
      num(a.port_number) - num(b.port_number) ||
      num(a.cpu_percent) - num(b.cpu_percent) ||
      num(a.ram_percent) - num(b.ram_percent) ||
      num(a.ping_ms) - num(b.ping_ms) ||
      num(a.node_id) - num(b.node_id)
  );
  return list[0] || null;
}

/**
 * ค้นหา PORT ว่างจาก vps_nodes + vps_allocations
 * อ้างอิงสถานะเดียวกับ /admin/vps/:id/ports และ threshold จาก /admin/vps/:id/edit
 */
async function findBestAdminPortForLogin(excludeAllocationIds = []) {
  const exclude = new Set(
    (excludeAllocationIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
  );
  await ensureVpsAllocationsAdminColumns().catch(() => {});

  await query(`
    UPDATE vps_allocations
    SET status='free', updated_at=NOW()
    WHERE LOWER(COALESCE(status, '')) = 'locked'
      AND updated_at < NOW() - INTERVAL '5 minutes'
  `).catch(() => {});

  const r = await query(
    `
    WITH nodes AS (
      SELECT
        n.id AS admin_node_id,
        COALESCE(sn.id, n.id) AS system_vps_id,
        COALESCE(n.node_name, '') AS node_name,
        COALESCE(NULLIF(n.cpu_percent::text, '')::numeric, NULLIF(sn.cpu_percent::text, '')::numeric, 0) AS cpu_percent,
        COALESCE(NULLIF(n.ram_percent::text, '')::numeric, NULLIF(sn.ram_percent::text, '')::numeric, 0) AS ram_percent,
        COALESCE(NULLIF(n.ping_ms::text, '')::numeric, NULLIF(sn.ping_ms::text, '')::numeric, 0) AS ping_ms,
        COALESCE(NULLIF(n.cpu_alarm::text, '')::numeric, NULLIF(sn.max_cpu_percent::text, '')::numeric, 80) AS max_cpu_percent,
        COALESCE(NULLIF(n.ram_alarm::text, '')::numeric, NULLIF(sn.max_ram_percent::text, '')::numeric, 85) AS max_ram_percent,
        COALESCE(NULLIF(n.ping_alarm::text, '')::numeric, NULLIF(sn.max_ping_ms::text, '')::numeric, 150) AS max_ping_ms,
        COALESCE(n.cpu_alarm, 80) AS cpu_alarm,
        COALESCE(n.ram_alarm, 85) AS ram_alarm,
        COALESCE(n.ping_alarm, 150) AS ping_alarm,
        COALESCE(n.max_ports, sn.max_ports, 20)::int AS max_ports,
        LOWER(COALESCE(n.status, sn.status, 'offline')) AS node_status,
        COALESCE(n.agent_enabled, sn.agent_enabled, TRUE) AS agent_enabled,
        GREATEST(
          COALESCE(n.last_seen_at, n.updated_at),
          COALESCE(sn.last_seen_at, sn.updated_at)
        ) AS last_seen_at
      FROM vps_nodes n
      LEFT JOIN vps_system.vps_nodes sn
        ON UPPER(TRIM(COALESCE(sn.node_code, ''))) = UPPER(TRIM(COALESCE(n.node_name, '')))
      WHERE COALESCE(n.agent_enabled, TRUE) = TRUE
        AND LOWER(COALESCE(n.status, '')) IN ('online', 'available', 'connected', 'active')
    ),
    port_rows AS (
      SELECT
        nd.*,
        p.id AS allocation_id,
        COALESCE(p.port_name, 'PORT') AS port_name,
        COALESCE(
          NULLIF((regexp_match(COALESCE(p.port_name, ''), '(?i)PORT[-_ ]*([0-9]+)$'))[1], '')::int,
          NULLIF(NULLIF(regexp_replace(COALESCE(p.port_number::text, ''), '[^0-9]', '', 'g'), ''), '')::int,
          0
        ) AS port_number,
        COALESCE(NULLIF(TRIM(p.folder_path), ''), 'C:\\MT5_PORTS\\' || COALESCE(p.port_name, 'PORT')) AS folder_path,
        LOWER(COALESCE(p.status, 'free')) AS port_status,
        COALESCE(p.is_active, TRUE) AS is_active,
        (
          SELECT COUNT(*)::int
          FROM vps_allocations px
          WHERE px.node_id = nd.admin_node_id
            AND LOWER(COALESCE(px.status, '')) IN ('used', 'running', 'locked', 'busy')
        ) AS used_ports
      FROM nodes nd
      JOIN vps_allocations p ON p.node_id = nd.admin_node_id
      WHERE LOWER(COALESCE(p.status, 'free')) NOT IN ('disabled', 'off', 'deleted', 'inactive')
        AND COALESCE(p.is_active, TRUE) = TRUE
    )
    SELECT pr.*
    FROM port_rows pr
    WHERE COALESCE(pr.used_ports, 0) < COALESCE(pr.max_ports, 20)
      AND COALESCE(TRIM(pr.folder_path), '') <> ''
    ORDER BY pr.port_number ASC, pr.admin_node_id ASC
    `,
    []
  ).catch((e) => {
    console.error('[adminVpsPortPicker] query error:', e.message);
    return { rows: [] };
  });

  const byNode = new Map();
  for (const row of r.rows || []) {
    if (!isVpsNodeEligibleForLogin(row)) continue;
    const nid = Number(row.admin_node_id || 0);
    if (!nid) continue;
    if (!byNode.has(nid)) byNode.set(nid, []);
    byNode.get(nid).push(row);
  }

  const available = [];
  for (const [adminNodeId, rows] of byNode.entries()) {
    const liveMap = await fetchLiveHealthMap(adminNodeId).catch(() => ({}));
    const dbUsageMap = await fetchDbMt5UsageMap(adminNodeId).catch(() => ({}));
    for (const row of rows) {
      if (exclude.has(Number(row.allocation_id))) continue;
      if (isPortAdminDisabled(row)) continue;
      if (!isAdminPortAvailableForLogin(row, liveMap, dbUsageMap)) continue;
      available.push(row);
    }
  }

  const loginLoadMap = await fetchVpsActiveLoginLoadMap().catch(() => ({}));
  return pickBestPortRow(available, loginLoadMap);
}

async function resolveOrCreateSystemPort(systemVpsId, adminPort) {
  const portNo = parsePortNumber(adminPort);
  const folderPath =
    adminPort.folder_path ||
    `C:\\MT5_PORTS\\${adminPort.port_name || `PORT-${String(portNo).padStart(2, '0')}`}`;
  const systemPortNos = [...new Set([portNo, adminPortToSystemPortNo(portNo)].filter((x) => x > 0))];

  let row = await query(
    `
    SELECT id, vps_id, port_no, folder_path, status
    FROM vps_system.vps_ports
    WHERE vps_id = $1
      AND (
        TRIM(COALESCE(folder_path, '')) = TRIM($2)
        OR port_no = ANY($3::int[])
      )
    ORDER BY
      CASE WHEN LOWER(COALESCE(status, '')) IN ('available', 'free', 'idle') THEN 0 ELSE 1 END,
      id ASC
    LIMIT 1
  `,
    [systemVpsId, folderPath, systemPortNos]
  ).catch(() => ({ rows: [] }));

  if (row.rows[0]) return row.rows[0];

  const insertNo = systemPortNos[systemPortNos.length - 1] || portNo;
  row = await query(
    `
    INSERT INTO vps_system.vps_ports (vps_id, port_no, folder_path, status, updated_at)
    VALUES ($1, $2, $3, 'available', NOW())
    RETURNING id, vps_id, port_no, folder_path, status
  `,
    [systemVpsId, insertNo, folderPath]
  ).catch(() => ({ rows: [] }));

  return row.rows[0] || null;
}

/**
 * จอง PORT เดียว (transaction) — ใช้ภายใน retry loop
 */
async function lockSingleAdminPortForLogin(userId, best) {
  const { systemVpsId } = await resolveSystemVpsId(best.admin_node_id);
  if (!systemVpsId) {
    return { ok: false, message: 'ไม่พบ VPS ระบบที่ผูกกับ Windows VPS นี้' };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE vps_system.vps_ports
      SET status = 'available', locked_by_user_id = NULL, locked_until = NULL, updated_at = NOW()
      WHERE status = 'locked'
        AND locked_until IS NOT NULL
        AND locked_until < NOW()
    `).catch(() => {});

    const sysPort = await resolveOrCreateSystemPort(systemVpsId, best);
    if (!sysPort?.id) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'สร้าง/ผูก PORT ในระบบไม่สำเร็จ' };
    }

    const lockRes = await client.query(
      `
      UPDATE vps_system.vps_ports
      SET status = 'locked',
          locked_by_user_id = $1,
          locked_until = NOW() + ($2::text || ' minutes')::interval,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = $3
        AND LOWER(COALESCE(status, '')) IN ('available', 'free', 'idle', 'failed')
      RETURNING id, vps_id, port_no, folder_path
    `,
      [userId, String(PORT_LOCK_MINUTES), sysPort.id]
    );

    if (!lockRes.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'PORT นี้ถูกจองไปแล้ว' };
    }

    const locked = lockRes.rows[0];
    const portGuard = await assertFolderPortFreeForUser(
      locked.vps_id,
      locked.port_no,
      userId
    ).catch(() => ({ ok: true }));
    if (!portGuard.ok) {
      await client.query('ROLLBACK');
      return { ok: false, message: portGuard.message || 'Folder PORT ถูก user อื่นใช้อยู่' };
    }

    const portNo = parsePortNumber(best);
    await client.query(
      `
      UPDATE vps_allocations
      SET status = 'locked', updated_at = NOW()
      WHERE id = $1
    `,
      [best.allocation_id]
    ).catch(() => {});

    await client.query(
      `
      UPDATE vps_allocations
      SET status = 'locked', updated_at = NOW()
      WHERE node_id = $1
        AND (${VPS_ALLOC_PORT_NO_SQL}) = $2
    `,
      [best.admin_node_id, portNo]
    ).catch(() => {});

    await client.query('COMMIT');

    return {
      ok: true,
      port: {
        port_id: locked.id,
        vps_id: locked.vps_id,
        port_no: locked.port_no,
        folder_path: locked.folder_path || best.folder_path,
        admin_node_id: best.admin_node_id,
        allocation_id: best.allocation_id,
        port_number: locked.port_no || portNo,
        node_name: best.node_name,
        port_name: best.port_name,
        source: 'admin_vps_allocations'
      },
      pick: best
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * จอง PORT สำหรับ Login MT5 — auto-pick ว่าง; ถ้าชนกับ user อื่น retry PORT ถัดไป
 */
async function reserveAdminPortForLogin(userId) {
  const tried = [];
  const maxAttempts = Math.max(3, Number(process.env.MT5_PORT_RESERVE_ATTEMPTS || 12));
  let lastMessage =
    'ไม่มี Windows VPS / Folder PORT ว่าง — ตรวจสอบ /admin/vps/ports (ข้าม PORT ใช้งาน/ปิด) และ /admin/vps/edit (CPU/RAM/PING)';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const best = await findBestAdminPortForLogin(tried);
    if (!best) break;

    const portNoCheck = parsePortNumber(best);
    const liveMap = await fetchLiveHealthMap(best.admin_node_id).catch(() => ({}));
    const dbUsageMap = await fetchDbMt5UsageMap(best.admin_node_id).catch(() => ({}));
    if (!isAdminPortAvailableForLogin(best, liveMap, dbUsageMap)) {
      tried.push(best.allocation_id);
      lastMessage = `PORT ${String(portNoCheck).padStart(2, '0')} ไม่ว่าง — ระบบเลือก PORT อื่นให้อัตโนมัติ`;
      continue;
    }

    const locked = await lockSingleAdminPortForLogin(userId, best);
    if (locked.ok) return locked;

    tried.push(best.allocation_id);
    lastMessage = locked.message || 'PORT ถูกจองไปแล้ว — ระบบเลือก PORT อื่นให้อัตโนมัติ';
  }

  return { ok: false, message: lastMessage };
}

function formatPickMessage(pick) {
  if (!pick) return 'ยังไม่พบ Windows VPS / Folder PORT ว่าง';
  return (
    `${pick.node_name || 'Windows VPS'} → ${pick.port_name || `PORT ${pick.port_number}`}` +
    ` | โฟลเดอร์: ${pick.folder_path || '-'}` +
    ` | CPU ${num(pick.cpu_percent)}% RAM ${num(pick.ram_percent)}% Ping ${num(pick.ping_ms)}ms`
  );
}

/** Payload สำหรับ Agent เปิด MT5 + Login (ต้องมี vpsFolderPath) */
function buildMt5LoginPayload({
  accountId,
  attemptId,
  userId,
  reservedPort,
  portSlot,
  mt5Login,
  mt5Password,
  serverName = MT5_LOCKED_SERVER
}) {
  const folder = String(reservedPort.folder_path || '').trim();
  const portNo = systemPortNoFromReservedPort(reservedPort);
  return {
    action: 'login_mt5',
    accountId,
    attemptId: attemptId ? String(attemptId) : undefined,
    userId,
    vpsId: reservedPort.vps_id,
    nodeId: reservedPort.vps_id,
    portId: reservedPort.port_id,
    portSlot,
    portNo,
    port_no: portNo,
    port: portNo,
    portNumber: portNo,
    folderPath: folder,
    folder_path: folder,
    vpsFolderPath: folder,
    mt5Login: String(mt5Login || '').trim(),
    mt5Password: String(mt5Password || ''),
    botCode: 'LOGIN_ONLY',
    serverName: normalizeLockedServer(serverName),
    useStartupIni: true,
    portable: true,
    callbackUrl: `${PUBLIC_CALLBACK_BASE}/api/vps-agent/connect-result`
  };
}

module.exports = {
  findBestAdminPortForLogin,
  reserveAdminPortForLogin,
  adminPortToSystemPortNo,
  formatPickMessage,
  buildMt5LoginPayload,
  pickBestPortRow
};
