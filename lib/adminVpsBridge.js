'use strict';

const { query } = require('../config/database');

async function getAdminNode(adminNodeId) {
  const r = await query(`SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1`, [adminNodeId]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/** แมป vps_nodes (admin) → vps_system.vps_nodes (ที่ Agent poll คำสั่งจริง) */
async function resolveSystemVpsId(adminNodeId) {
  const adminId = Number(adminNodeId || 0);
  if (!adminId) return { adminNodeId: 0, systemVpsId: 0, nodeName: '' };

  const node = await getAdminNode(adminId);
  if (!node) return { adminNodeId: adminId, systemVpsId: adminId, nodeName: '' };

  const name = String(node.node_name || '').trim();
  const s = await query(
    `
    SELECT id
    FROM vps_system.vps_nodes
    WHERE UPPER(TRIM(COALESCE(node_code,''))) = UPPER(TRIM($1))
    LIMIT 1
  `,
    [name]
  ).catch(() => ({ rows: [] }));

  return {
    adminNodeId: adminId,
    systemVpsId: Number(s.rows[0]?.id || adminId),
    nodeName: name
  };
}

/** คิวคำสั่งไปตารางที่ Python Agent อ่านจริง */
async function queueSystemAgentCommand(systemVpsId, commandType, payload, portId = null) {
  const vpsId = Number(systemVpsId || 0);
  if (!vpsId) return null;

  const r = await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1,$1,$2,$3,$4::jsonb,'pending',NOW(),NOW())
    RETURNING id
  `,
    [vpsId, portId, commandType, JSON.stringify(payload || {})]
  ).catch(() => ({ rows: [] }));

  return r.rows[0] || null;
}

function isPortAdminDisabled(portRow) {
  if (!portRow) return false;
  if (portRow.admin_disabled === true) return true;
  const active = portRow.is_active;
  if (
    active === false ||
    active === 'f' ||
    active === 'false' ||
    active === 0 ||
    active === '0'
  ) {
    return true;
  }
  const st = String(portRow.status || portRow.port_status || '').trim().toLowerCase();
  return ['disabled', 'off', 'deleted', 'inactive'].includes(st);
}

const AGENT_HEALTH_MAX_AGE_MS = 3 * 60 * 1000;
const AGENT_HEALTH_RELAXED_MS = 60 * 60 * 1000;

/** เลข PORT แบบ slot 1–99 (จาก 101 หรือชื่อ VPS-WIN-01-PORT-01) */
function normalizePortSlot(portNo) {
  const n = Number(portNo || 0);
  if (!n) return 0;
  if (n >= 100) return n % 100;
  return n;
}

function hasAgentHealthWithin(live, maxAgeMs) {
  if (!live?.updated_at) return false;
  const ts = new Date(live.updated_at).getTime();
  return Number.isFinite(ts) && Date.now() - ts <= maxAgeMs;
}

function hasFreshAgentHealth(live) {
  return hasAgentHealthWithin(live, AGENT_HEALTH_MAX_AGE_MS);
}

/** null = ไม่มีข้อมูล Agent ล่าสุด, true/false = MT5 รันจริงหรือไม่ */
function isAgentMt5Running(live, maxAgeMs = AGENT_HEALTH_MAX_AGE_MS) {
  if (!hasAgentHealthWithin(live, maxAgeMs)) return null;
  return live.running === true;
}

function lookupLiveHealth(liveMap, portNo) {
  const slot = normalizePortSlot(portNo);
  if (!slot) return {};
  return (
    liveMap[slot] ||
    liveMap[portNo] ||
    liveMap[100 + slot] ||
    {}
  );
}

function lookupDbUsage(dbUsageMap, portNo) {
  const slot = normalizePortSlot(portNo);
  if (!slot) return {};
  return dbUsageMap[slot] || dbUsageMap[portNo] || dbUsageMap[100 + slot] || {};
}

/**
 * สถานะ PORT บน /admin/vps/:id/ports
 * - Agent บอกรัน (ล่าสุด 1 ชม.) → ใช้งาน
 * - Agent บอกไม่รัน (สด ≤3 นาที) → ว่าง
 * - ไม่มี Agent สด → ใช้เฉพาะบัญชี connected (ไม่ใช้ allocation ค้าง)
 */
function resolveAdminPortMt5State({ live, dbUse, adminDisabled }) {
  if (adminDisabled) {
    return { inUse: false, mt5Login: null, agentState: null, usageSource: 'disabled' };
  }

  const strict = isAgentMt5Running(live, AGENT_HEALTH_MAX_AGE_MS);
  const relaxed = isAgentMt5Running(live, AGENT_HEALTH_RELAXED_MS);
  const agentRunning = strict === true || relaxed === true;

  if (agentRunning) {
    const hasConnected = dbUse?.source === 'connected' && dbUse.running === true;
    if (hasConnected) {
      return {
        inUse: true,
        orphanRunning: false,
        mt5Login: live?.mt5_login || dbUse?.mt5_login || null,
        agentState: true,
        usageSource: strict === true ? 'agent' : 'agent_relaxed'
      };
    }
    // MT5 เปิดค้างบน VPS แต่ไม่มีบัญชี connected ในระบบ (เช่น login ผิดแล้วลบ)
    return {
      inUse: false,
      orphanRunning: true,
      mt5Login: live?.mt5_login || null,
      agentState: true,
      usageSource: 'orphan_mt5'
    };
  }

  if (strict === false) {
    return { inUse: false, orphanRunning: false, mt5Login: null, agentState: false, usageSource: 'agent_free' };
  }

  if (dbUse?.source === 'connected' && dbUse.running === true) {
    return {
      inUse: true,
      orphanRunning: false,
      mt5Login: dbUse.mt5_login || null,
      agentState: null,
      usageSource: 'connected'
    };
  }

  return { inUse: false, orphanRunning: false, mt5Login: null, agentState: null, usageSource: 'free' };
}

function systemPortNosForAdmin(portNo) {
  const n = Number(portNo || 0);
  if (!n) return [];
  if (n >= 100) return [n];
  return [...new Set([n, 100 + n].filter((x) => x > 0))];
}

/** เคลียร์ DB ค้างเมื่อ Agent รายงานว่าไม่มี MT5 รัน */
async function reconcilePortIdleWhenAgentFree(adminNodeId, portNo, folderPath = '') {
  const no = Number(portNo || 0);
  if (!no) return;
  const { adminNodeId: aid, systemVpsId } = await resolveSystemVpsId(adminNodeId);
  const nodeIds = [...new Set([aid, systemVpsId].filter((x) => x > 0))];
  const portNos = systemPortNosForAdmin(no);

  if (nodeIds.length && portNos.length) {
    await query(
      `
      UPDATE vps_system.vps_port_health
      SET running=FALSE, pid='[]'::jsonb, process_id=NULL, mt5_login=NULL, updated_at=NOW()
      WHERE node_id = ANY($1::bigint[]) AND port_number = ANY($2::int[])
    `,
      [nodeIds, portNos]
    ).catch(() => {});

    if (systemVpsId) {
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET status='ready',
            last_error='MT5 ไม่ได้รัน — รีเซ็ตสถานะอัตโนมัติ',
            last_login_message='ว่าง',
            updated_at=NOW()
        WHERE vps_id=$1
          AND COALESCE(assigned_port_no, windows_port_no) = ANY($2::int[])
          AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'checking', 'connecting', 'starting')
      `,
        [systemVpsId, portNos]
      ).catch(() => {});

      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='available', mt5_login=NULL, current_mt5_login=NULL,
            locked_by_user_id=NULL, locked_until=NULL, process_id=NULL, updated_at=NOW()
        WHERE vps_id=$1 AND port_no = ANY($2::int[])
      `,
        [systemVpsId, portNos]
      ).catch(() => {});
    }
  }

  if (aid) {
    await setAdminAllocationStatus(aid, no, 'free').catch(() => {});
    if (folderPath) {
      await query(
        `
        UPDATE vps_allocations
        SET status='free', mt5_login=NULL, mt5_status='stopped', is_active=TRUE, updated_at=NOW()
        WHERE node_id=$1 AND TRIM(COALESCE(folder_path, '')) = TRIM($2)
      `,
        [aid, folderPath]
      ).catch(() => {});
    }
  }
}

/** สถานะ "ใช้งาน" ตาม /admin/vps/:id/ports */
function isAdminPortInUse(portRow, liveMap = {}, dbUsageMap = {}, portNo = null) {
  const no = Number(portNo || parsePortNumber(portRow) || 0);
  const st = resolveAdminPortMt5State({
    live: lookupLiveHealth(liveMap, no),
    dbUse: lookupDbUsage(dbUsageMap, no),
    adminDisabled: isPortAdminDisabled(portRow)
  });
  return st.inUse === true;
}

/** PORT ว่างพร้อมเปิด MT5 — ตรงกับ badge "ว่าง" บน /admin/vps/:id/ports */
function isAdminPortAvailableForLogin(portRow, liveMap = {}, dbUsageMap = {}) {
  if (!portRow || isPortAdminDisabled(portRow)) return false;
  if (isAdminPortInUse(portRow, liveMap, dbUsageMap)) return false;
  const st = String(portRow.port_status || portRow.status || '').trim().toLowerCase();
  if (!st || ['free', 'available', 'idle'].includes(st)) return true;
  return false;
}

/** VPS ผ่านเงื่อนไขจาก /admin/vps/:id/edit (cpu_alarm, ram_alarm, ping_alarm) */
function isVpsNodeEligibleForLogin(nodeRow) {
  if (!nodeRow) return false;
  if (nodeRow.agent_enabled === false) return false;
  const nodeSt = String(nodeRow.node_status || nodeRow.status || '').toLowerCase();
  if (!['online', 'available', 'connected', 'active'].includes(nodeSt)) return false;
  const maxCpu = Number(nodeRow.max_cpu_percent ?? nodeRow.cpu_alarm ?? 80);
  const maxRam = Number(nodeRow.max_ram_percent ?? nodeRow.ram_alarm ?? 85);
  const maxPing = Number(nodeRow.max_ping_ms ?? nodeRow.ping_alarm ?? 150);
  if (Number(nodeRow.cpu_percent || 0) > maxCpu) return false;
  if (Number(nodeRow.ram_percent || 0) > maxRam) return false;
  if (Number(nodeRow.ping_ms || 0) > maxPing) return false;
  const seen = nodeRow.last_seen_at ? new Date(nodeRow.last_seen_at).getTime() : 0;
  if (seen && Date.now() - seen > 3 * 60 * 1000) return false;
  return true;
}

/** เงื่อนไข SQL จับเลข PORT จากแถว vps_allocations (ไม่ใช้ display_name — ตารางจริงไม่มีคอลัมน์นี้) */
const VPS_ALLOC_PORT_NO_SQL = `
  COALESCE(
    NULLIF((regexp_match(COALESCE(port_name, ''), '(?i)PORT[-_ ]*([0-9]+)$'))[1], '')::int,
    NULLIF(NULLIF(regexp_replace(COALESCE(port_number::text, ''), '[^0-9]', '', 'g'), ''), '')::int,
    0
  )
`;

async function ensureVpsAllocationsAdminColumns() {
  await query(`ALTER TABLE vps_allocations ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`).catch(() => {});
  await query(`ALTER TABLE vps_allocations ADD COLUMN IF NOT EXISTS folder_path TEXT`).catch(() => {});
}

/** อัปเดตสถานะ Folder PORT บน /admin/vps (free | locked | used | disabled) */
async function setAdminAllocationStatus(adminNodeId, portNo, status, allocationId = null) {
  await ensureVpsAllocationsAdminColumns().catch(() => {});
  const st = String(status || 'free').trim().toLowerCase();
  const isActive = !['disabled', 'off', 'deleted', 'inactive'].includes(st);
  if (allocationId) {
    await query(
      `UPDATE vps_allocations SET status=$2, is_active=$3, updated_at=NOW() WHERE id=$1`,
      [allocationId, st, isActive]
    ).catch(() => {});
  }
  if (adminNodeId && portNo) {
    await query(
      `
      UPDATE vps_allocations
      SET status=$3, is_active=$4, updated_at=NOW()
      WHERE node_id=$1 AND (${VPS_ALLOC_PORT_NO_SQL})=$2
    `,
      [adminNodeId, portNo, st, isActive]
    ).catch(() => {});
  }
}

function parsePortNumber(portRow) {
  const raw = String(
    portRow?.port_name || portRow?.display_name || portRow?.port_number || portRow?.port || ''
  );
  const m = raw.match(/PORT[-_\s]*(\d+)/i) || raw.match(/(\d+)/);
  return m ? Number(m[1]) : Number(portRow?.port_number || 0);
}

/** สถานะ MT5 สดจาก vps_system.vps_port_health (รวมทั้ง admin node id และ system vps id) */
async function fetchLiveHealthMap(adminNodeId) {
  const { adminNodeId: aid, systemVpsId } = await resolveSystemVpsId(adminNodeId);
  const nodeIds = [...new Set([aid, systemVpsId].filter((x) => x > 0))];
  if (!nodeIds.length) return {};

  const r = await query(
    `
    SELECT port_number, folder_path, running, pid, mt5_login, process_id, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id = ANY($1::bigint[])
      AND updated_at > NOW() - INTERVAL '2 hours'
    ORDER BY updated_at DESC
  `,
    [nodeIds]
  ).catch(() => ({ rows: [] }));

  const map = {};
  for (const row of r.rows || []) {
    const slot = normalizePortSlot(row.port_number);
    if (!slot) continue;
    const prev = map[slot];
    const running = row.running === true;
    const rowTs = new Date(row.updated_at).getTime();
    const prevTs = prev ? new Date(prev.updated_at).getTime() : 0;
    if (
      !prev
      || (running && !prev.running)
      || (running === prev.running && rowTs > prevTs)
      || (!prev.running && running)
    ) {
      map[slot] = { ...row, port_number: slot };
    }
  }
  return map;
}

async function countLiveRunningPorts(adminNodeId) {
  const live = await fetchLiveHealthMap(adminNodeId);
  const db = await fetchDbMt5UsageMap(adminNodeId);
  const keys = new Set([...Object.keys(live), ...Object.keys(db)]);
  let n = 0;
  for (const k of keys) {
    const portNo = Number(k);
    if (!portNo) continue;
    const row = live[portNo] || {};
    const usage = db[portNo] || {};
    if (row.running === true || usage.running === true) n += 1;
  }
  return n;
}

/** สถานะ MT5 จาก DB (connected / vps_ports.running / allocation locked) — สำรองเมื่อ Agent health ค้าง */
async function fetchDbMt5UsageMap(adminNodeId) {
  const { adminNodeId: aid, systemVpsId } = await resolveSystemVpsId(adminNodeId);
  const map = {};

  const push = (portNo, mt5Login, folderPath, source) => {
    const slot = normalizePortSlot(portNo);
    if (!slot) return;
    const login = String(mt5Login || '').trim() || null;
    const prev = map[slot];
    if (
      !prev
      || (login && !prev.mt5_login)
      || source === 'connected'
    ) {
      map[slot] = {
        port_number: slot,
        running: true,
        mt5_login: login,
        folder_path: folderPath || prev?.folder_path || null,
        source: source || prev?.source || 'db'
      };
    }
  };

  if (systemVpsId) {
    const acc = await query(
      `
      SELECT a.mt5_login, a.assigned_port_no, a.windows_port_no, a.port_slot,
             COALESCE(p.folder_path, '') AS folder_path
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE a.vps_id = $1
        AND LOWER(TRIM(COALESCE(a.status, ''))) = 'connected'
    `,
      [systemVpsId]
    ).catch(() => ({ rows: [] }));

    for (const row of acc.rows || []) {
      const portNo =
        Number(row.assigned_port_no || 0) ||
        Number(row.windows_port_no || 0) ||
        Number(row.port_slot || 0);
      push(portNo, row.mt5_login, row.folder_path, 'connected');
    }

    const vpsPorts = await query(
      `
      SELECT port_no, mt5_login, folder_path, status
      FROM vps_system.vps_ports
      WHERE vps_id = $1
        AND LOWER(TRIM(COALESCE(status, ''))) IN ('running', 'locked', 'busy', 'used')
    `,
      [systemVpsId]
    ).catch(() => ({ rows: [] }));

    for (const row of vpsPorts.rows || []) {
      let portNo = Number(row.port_no || 0);
      if (portNo >= 100) portNo = portNo % 100;
      if (!portNo) {
        const m = String(row.folder_path || '').match(/PORT[-_ ]*(\d+)/i);
        portNo = m ? Number(m[1]) : 0;
      }
      push(portNo, row.mt5_login, row.folder_path, 'vps_port');
    }
  }

  if (aid) {
    await ensureVpsAllocationsAdminColumns().catch(() => {});
    const alloc = await query(
      `
      SELECT port_name, port_number, folder_path, status, mt5_login
      FROM vps_allocations
      WHERE node_id = $1
        AND LOWER(TRIM(COALESCE(status, ''))) IN ('locked', 'used', 'running', 'busy', 'full')
    `,
      [aid]
    ).catch(() => ({ rows: [] }));

    for (const row of alloc.rows || []) {
      const portNo = parsePortNumber(row);
      push(portNo, row.mt5_login, row.folder_path, 'allocation');
    }
  }

  return map;
}

async function clearPortHealthRunning(systemVpsId, portNo) {
  const nodeId = Number(systemVpsId || 0);
  const portNos = systemPortNosForAdmin(portNo);
  if (!nodeId || !portNos.length) return;

  const { adminNodeId } = await resolveSystemVpsId(nodeId);
  const nodeIds = [...new Set([nodeId, adminNodeId].filter((x) => x > 0))];

  await query(
    `
    UPDATE vps_system.vps_port_health
    SET running=FALSE, pid='[]'::jsonb, process_id=NULL, mt5_login=NULL, updated_at=NOW()
    WHERE node_id = ANY($1::bigint[]) AND port_number = ANY($2::int[])
  `,
    [nodeIds, portNos]
  ).catch(() => {});
}

function adminPortNoFromSystem(portNo) {
  const n = Number(portNo || 0);
  if (!n) return 0;
  return n >= 100 ? n % 100 : n;
}

async function upsertPortHealthRunning(systemVpsId, portNo, folderPath, mt5Login) {
  const nodeId = Number(systemVpsId || 0);
  const no = Number(portNo || 0);
  if (!nodeId || !no) return;

  const { adminNodeId } = await resolveSystemVpsId(nodeId);
  const nodeIds = [...new Set([nodeId, adminNodeId].filter((x) => x > 0))];

  for (const nid of nodeIds) {
    await query(
      `
      INSERT INTO vps_system.vps_port_health
      (node_id, port_number, folder_path, running, mt5_login, updated_at)
      VALUES ($1, $2, $3, TRUE, $4, NOW())
      ON CONFLICT (node_id, port_number)
      DO UPDATE SET
        folder_path = COALESCE(EXCLUDED.folder_path, vps_system.vps_port_health.folder_path),
        running = TRUE,
        mt5_login = COALESCE(EXCLUDED.mt5_login, vps_system.vps_port_health.mt5_login),
        updated_at = NOW()
    `,
      [nid, no, folderPath || null, mt5Login || null]
    ).catch(() => {});
  }
}

module.exports = {
  getAdminNode,
  resolveSystemVpsId,
  queueSystemAgentCommand,
  fetchLiveHealthMap,
  fetchDbMt5UsageMap,
  upsertPortHealthRunning,
  clearPortHealthRunning,
  adminPortNoFromSystem,
  countLiveRunningPorts,
  ensureVpsAllocationsAdminColumns,
  setAdminAllocationStatus,
  isPortAdminDisabled,
  hasFreshAgentHealth,
  isAgentMt5Running,
  normalizePortSlot,
  lookupLiveHealth,
  lookupDbUsage,
  resolveAdminPortMt5State,
  reconcilePortIdleWhenAgentFree,
  isAdminPortInUse,
  isAdminPortAvailableForLogin,
  isVpsNodeEligibleForLogin,
  VPS_ALLOC_PORT_NO_SQL,
  parsePortNumber
};
