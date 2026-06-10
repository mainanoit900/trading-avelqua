'use strict';

const { query } = require('../config/database');

async function getAdminNode(adminNodeId) {
  const r = await query(`SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1`, [adminNodeId]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/** แมป vps_nodes (admin) ↔ vps_system.vps_nodes (ที่ Agent poll คำสั่งจริง) */
async function resolveSystemVpsId(adminOrSystemNodeId) {
  const id = Number(adminOrSystemNodeId || 0);
  if (!id) return { adminNodeId: 0, systemVpsId: 0, nodeName: '' };

  const node = await getAdminNode(id);
  if (node) {
    const name = String(node.node_name || '').trim();
    const s = await query(
      `
      SELECT id
      FROM vps_system.vps_nodes
      WHERE UPPER(TRIM(COALESCE(node_code, ''))) = UPPER(TRIM($1))
      LIMIT 1
    `,
      [name]
    ).catch(() => ({ rows: [] }));

    return {
      adminNodeId: id,
      systemVpsId: Number(s.rows[0]?.id || id),
      nodeName: name
    };
  }

  const sys = await query(
    `
    SELECT id, node_code, node_name
    FROM vps_system.vps_nodes
    WHERE id = $1
    LIMIT 1
  `,
    [id]
  ).catch(() => ({ rows: [] }));

  if (sys.rows[0]) {
    const code = String(sys.rows[0].node_code || sys.rows[0].node_name || '').trim();
    const admin = await query(
      `
      SELECT id, node_name
      FROM vps_nodes
      WHERE UPPER(TRIM(COALESCE(node_name, ''))) = UPPER(TRIM($1))
      LIMIT 1
    `,
      [code]
    ).catch(() => ({ rows: [] }));
    return {
      adminNodeId: Number(admin.rows[0]?.id || 0),
      systemVpsId: id,
      nodeName: String(admin.rows[0]?.node_name || code)
    };
  }

  return { adminNodeId: id, systemVpsId: id, nodeName: '' };
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

function hasFreshAgentHealth(live) {
  if (!live?.updated_at) return false;
  const ts = new Date(live.updated_at).getTime();
  return Number.isFinite(ts) && Date.now() - ts <= AGENT_HEALTH_MAX_AGE_MS;
}

/** null = ไม่มีข้อมูล Agent ล่าสุด, true/false = MT5 รันจริงหรือไม่ */
function isAgentMt5Running(live) {
  if (!hasFreshAgentHealth(live)) return null;
  return live.running === true;
}

function systemPortNosForAdmin(portNo) {
  const n = Number(portNo || 0);
  if (!n) return [];
  if (n >= 100) return [n];
  return [...new Set([n, 100 + n].filter((x) => x > 0))];
}

/** PORT ที่ล็อกจงใจหลัง login (MT5 ปิดแล้ว แต่ยังจอง FolderPort รอ Run BOT) */
async function isPortIntentionallyLocked(adminNodeId, portNo, scope = {}) {
  const no = Number(portNo || 0);
  if (!no) return false;
  const { systemVpsId, adminNodeId: aid } = await resolveSystemVpsId(adminNodeId);
  const portNos = systemPortNosForAdmin(no);
  const slot = adminPortNoFromSystem(no) || no;

  if (systemVpsId && portNos.length) {
    const lock = await query(
      `
      SELECT 1
      FROM vps_system.vps_ports
      WHERE vps_id = $1
        AND port_no = ANY($2::int[])
        AND locked_by_user_id IS NOT NULL
        AND (locked_until IS NULL OR locked_until > NOW())
      LIMIT 1
    `,
      [systemVpsId, portNos]
    ).catch(() => ({ rows: [] }));
    if (lock.rows[0]) return true;

    const accountParams = [systemVpsId, portNos];
    let accountSql = `
      SELECT 1
      FROM vps_system.mt5_accounts
      WHERE vps_id = $1
        AND COALESCE(assigned_port_no, windows_port_no) = ANY($2::int[])
        AND LOWER(TRIM(COALESCE(status, ''))) = 'connected'
    `;
    const scopedAccountId = Number(scope.accountId || 0);
    const scopedUserId = Number(scope.userId || 0);
    const scopedPortSlot = Number(scope.portSlot || 0);
    if (scopedAccountId > 0) {
      accountParams.push(scopedAccountId);
      accountSql += ` AND id = $${accountParams.length}`;
    } else if (scopedUserId > 0 && scopedPortSlot > 0) {
      accountParams.push(scopedUserId, scopedPortSlot);
      accountSql += ` AND user_id = $${accountParams.length - 1} AND port_slot = $${accountParams.length}`;
    }
    const acc = await query(accountSql, accountParams).catch(() => ({ rows: [] }));
    if (acc.rows[0]) return true;
  }

  if (aid) {
    const alloc = await query(
      `
      SELECT 1
      FROM vps_allocations
      WHERE node_id = $1
        AND (${VPS_ALLOC_PORT_NO_SQL}) = $2
        AND LOWER(TRIM(COALESCE(status, ''))) IN ('locked', 'used')
      LIMIT 1
    `,
      [aid, slot]
    ).catch(() => ({ rows: [] }));
    if (alloc.rows[0]) return true;
  }

  return false;
}

/** เคลียร์ DB ค้างเมื่อ Agent รายงานว่าไม่มี MT5 รัน */
async function reconcilePortIdleWhenAgentFree(adminNodeId, portNo, folderPath = '', scope = {}) {
  const no = Number(portNo || 0);
  if (!no) return;
  if (!scope.forceRelease && (await isPortIntentionallyLocked(adminNodeId, no, scope))) return;
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
      const accountParams = [systemVpsId, portNos];
      let accountSql = `
        UPDATE vps_system.mt5_accounts
        SET status='ready',
            last_error='MT5 ไม่ได้รัน — รีเซ็ตสถานะอัตโนมัติ',
            last_login_message='ว่าง',
            updated_at=NOW()
        WHERE vps_id=$1
          AND COALESCE(assigned_port_no, windows_port_no) = ANY($2::int[])
          AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'checking', 'connecting', 'starting')
      `;
      const scopedAccountId = Number(scope.accountId || 0);
      const scopedUserId = Number(scope.userId || 0);
      const scopedPortSlot = Number(scope.portSlot || 0);
      if (scopedAccountId > 0) {
        accountParams.push(scopedAccountId);
        accountSql += ` AND id=$${accountParams.length}`;
      } else if (scopedUserId > 0 && scopedPortSlot > 0) {
        accountParams.push(scopedUserId, scopedPortSlot);
        accountSql += ` AND user_id=$${accountParams.length - 1} AND port_slot=$${accountParams.length}`;
      }
      await query(accountSql, accountParams).catch(() => {});

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

/** สถานะ "ใช้งาน" ตาม /admin/vps/:id/ports — Agent ไม่รัน = ว่าง (ไม่ค้างจาก DB) */
function isAdminPortInUse(portRow, liveMap = {}, dbUsageMap = {}, portNo = null) {
  const no = Number(portNo || parsePortNumber(portRow) || 0);
  if (!no) return false;
  const live = liveMap[no] || {};
  const agentState = isAgentMt5Running(live);
  if (agentState === false) return false;

  const dbUse = dbUsageMap[no] || {};
  const agentRunning = agentState === true;
  const dbRunning = dbUse.running === true;
  const st = String(portRow?.port_status || portRow?.status || '').trim().toLowerCase();
  const dbBusy = ['locked', 'used', 'running', 'busy', 'full'].includes(st);
  return agentRunning || dbRunning || dbBusy;
}

/** PORT ว่างพร้อมเปิด MT5 — ตรงกับ badge "ว่าง" บน /admin/vps/:id/ports */
function isAdminPortAvailableForLogin(portRow, liveMap = {}, dbUsageMap = {}) {
  if (!portRow || isPortAdminDisabled(portRow)) return false;
  const no = parsePortNumber(portRow);
  const dbUse = lookupDbUsage(dbUsageMap, no);
  if (dbUse.locked) return false;
  if (isAdminPortInUse(portRow, liveMap, dbUsageMap, no)) return false;
  const st = String(portRow.port_status || portRow.status || '').trim().toLowerCase();
  if (['locked', 'used', 'running', 'busy', 'full'].includes(st)) return false;
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
  const seenMs = Math.max(
    nodeRow.last_seen_at ? new Date(nodeRow.last_seen_at).getTime() : 0,
    nodeRow.updated_at ? new Date(nodeRow.updated_at).getTime() : 0
  );
  const maxSeenMs = Number(process.env.MT5_AGENT_LAST_SEEN_MAX_SEC || 600) * 1000;
  if (seenMs && Date.now() - seenMs > maxSeenMs) return false;
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
  const slot = adminPortNoFromSystem(Number(portNo || 0)) || Number(portNo || 0);
  const clearMeta = ['free', 'available', 'idle'].includes(st);
  if (allocationId) {
    await query(
      `
      UPDATE vps_allocations
      SET status=$2,
          is_active=$3,
          mt5_status=CASE WHEN $4 THEN 'stopped' ELSE mt5_status END,
          updated_at=NOW()
      WHERE id=$1
    `,
      [allocationId, st, isActive, clearMeta]
    ).catch(() => {});
  }
  if (adminNodeId && slot) {
    await query(
      `
      UPDATE vps_allocations
      SET status=$3,
          is_active=$4,
          mt5_status=CASE WHEN $5 THEN 'stopped' ELSE mt5_status END,
          updated_at=NOW()
      WHERE node_id=$1 AND (${VPS_ALLOC_PORT_NO_SQL})=$2
    `,
      [adminNodeId, slot, st, isActive, clearMeta]
    ).catch(() => {});
  }
}

/** เคลียร์ vps_allocations ค้าง locked เมื่อ FolderPort บน VPS ว่างแล้ว */
async function syncStaleAdminAllocations(adminNodeId) {
  const aid = Number(adminNodeId || 0);
  if (!aid) return 0;
  const { systemVpsId } = await resolveSystemVpsId(aid);
  if (!systemVpsId) return 0;

  const r = await query(
    `
    UPDATE vps_allocations a
    SET status='free',
        mt5_status='stopped',
        is_active=TRUE,
        updated_at=NOW()
    WHERE a.node_id = $1
      AND LOWER(TRIM(COALESCE(a.status, ''))) IN ('locked', 'used', 'running', 'busy', 'full')
      AND EXISTS (
        SELECT 1
        FROM vps_system.vps_ports p
        WHERE p.vps_id = $2
          AND (
            TRIM(COALESCE(p.folder_path, '')) = TRIM(COALESCE(a.folder_path, ''))
            OR p.port_no = (100 + (${VPS_ALLOC_PORT_NO_SQL}))
          )
          AND LOWER(TRIM(COALESCE(p.status, ''))) IN ('available', 'free', 'idle')
          AND p.locked_by_user_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM vps_system.mt5_accounts ma
        WHERE ma.vps_id = $2
          AND LOWER(TRIM(COALESCE(ma.status, ''))) IN ('connected', 'checking', 'connecting', 'starting')
          AND (
            ma.assigned_port_no = (100 + (${VPS_ALLOC_PORT_NO_SQL}))
            OR EXISTS (
              SELECT 1 FROM vps_system.vps_ports px
              WHERE px.id = ma.port_id
                AND TRIM(COALESCE(px.folder_path, '')) = TRIM(COALESCE(a.folder_path, ''))
            )
          )
      )
    RETURNING a.id
  `,
    [aid, systemVpsId]
  ).catch(() => ({ rows: [] }));

  return r.rows?.length || 0;
}

function parsePortNumber(portRow) {
  const raw = String(
    portRow?.port_name || portRow?.display_name || portRow?.port_number || portRow?.port || ''
  );
  const m = raw.match(/PORT[-_\s]*(\d+)/i) || raw.match(/(\d+)/);
  return m ? Number(m[1]) : Number(portRow?.port_number || 0);
}

/** แมปเลข PORT แพ็กเกจ (1) ↔ system (101) สำหรับ lookup health/usage */
function normalizePortSlot(portNo) {
  const n = Number(portNo || 0);
  if (!n) return 0;
  return n >= 100 ? adminPortNoFromSystem(n) : 100 + n;
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
      AND updated_at > NOW() - INTERVAL '3 minutes'
    ORDER BY updated_at DESC
  `,
    [nodeIds]
  ).catch(() => ({ rows: [] }));

  const map = {};
  for (const row of r.rows || []) {
    const no = Number(row.port_number || 0);
    if (!no) continue;
    const prev = map[no];
    const running = row.running === true;
    if (
      !prev
      || (running && !prev.running)
      || new Date(row.updated_at).getTime() > new Date(prev.updated_at).getTime()
    ) {
      map[no] = row;
    }
  }
  return map;
}

async function countLiveRunningPorts(adminNodeId) {
  const live = await fetchLiveHealthMap(adminNodeId);
  const db = await fetchDbMt5UsageMap(adminNodeId);
  const seen = new Set();
  let n = 0;

  function markUsed(portNo) {
    const slot = adminPortNoFromSystem(portNo) || Number(portNo || 0);
    if (!slot || seen.has(slot)) return;
    seen.add(slot);
    n += 1;
  }

  for (const k of Object.keys(live)) {
    const portNo = Number(k);
    if (!portNo) continue;
    if (live[portNo]?.running === true) markUsed(portNo);
  }
  for (const k of Object.keys(db)) {
    const portNo = Number(k);
    if (!portNo) continue;
    if (db[portNo]?.running === true) markUsed(portNo);
  }
  return n;
}

/** Lot รวมจาก bot ที่กำลังรัน/เปิดอยู่บน VPS (ทุก user) */
async function countLiveUsedLot(adminNodeId) {
  const { systemVpsId, adminNodeId: aid } = await resolveSystemVpsId(adminNodeId);
  const vpsIds = [...new Set([systemVpsId, aid].filter((x) => x > 0))];
  if (!vpsIds.length) return 0;

  const r = await query(
    `
    SELECT COALESCE(SUM(
      CASE
        WHEN COALESCE(bi.lot_used, 0) > 0 THEN bi.lot_used
        ELSE COALESCE(
          NULLIF((bi.run_payload->>'lot')::numeric, 0),
          NULLIF((bi.run_payload->>'lotPlus')::numeric, 0),
          0.01
        )
      END
    ), 0)::numeric AS total_lot
    FROM vps_system.bot_instances bi
    WHERE bi.vps_id = ANY($1::bigint[])
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
        'running', 'pending', 'restarting', 'connecting', 'starting'
      )
  `,
    [vpsIds]
  ).catch(() => ({ rows: [{ total_lot: 0 }] }));

  return Number(r.rows[0]?.total_lot || 0);
}

/** สถานะ MT5 จาก DB (connected / vps_ports.running / allocation locked) — สำรองเมื่อ Agent health ค้าง */
async function fetchDbMt5UsageMap(adminNodeId) {
  const { adminNodeId: aid, systemVpsId } = await resolveSystemVpsId(adminNodeId);
  const map = {};

  const push = (portNo, mt5Login, folderPath, source, opts = {}) => {
    const no = Number(portNo || 0);
    if (!no) return;
    const login = String(mt5Login || '').trim() || null;
    const prev = map[no];
    const locked = opts.locked === true || prev?.locked === true;
    const running = opts.running === true || prev?.running === true;
    const shouldReplace =
      !prev
      || (login && !prev.mt5_login)
      || source === 'connected'
      || (opts.locked && !prev.locked)
      || (opts.running && !prev?.running);
    if (!shouldReplace) return;
    map[no] = {
      port_number: no,
      running,
      locked,
      mt5_login: login || prev?.mt5_login || null,
      folder_path: folderPath || prev?.folder_path || null,
      source: source || prev?.source || 'db'
    };
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
      push(portNo, row.mt5_login, row.folder_path, 'connected', { locked: true, running: false });
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
      const st = String(row.status || '').trim().toLowerCase();
      push(portNo, row.mt5_login, row.folder_path, 'vps_port', {
        locked: ['locked', 'busy', 'used', 'running'].includes(st),
        running: st === 'running'
      });
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
      const st = String(row.status || '').trim().toLowerCase();
      push(portNo, row.mt5_login, row.folder_path, 'allocation', {
        locked: ['locked', 'used', 'running', 'busy', 'full'].includes(st),
        running: ['running', 'busy', 'full'].includes(st)
      });
    }
  }

  if (systemVpsId) {
    const bots = await query(
      `
      SELECT DISTINCT ON (bi.assigned_port_no)
        bi.assigned_port_no,
        bi.status,
        bi.ea_status,
        bi.updated_at,
        a.mt5_login,
        COALESCE(p.folder_path, '') AS folder_path
      FROM vps_system.bot_instances bi
      JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE bi.vps_id = $1
        AND bi.stopped_at IS NULL
        AND bi.assigned_port_no IS NOT NULL
        AND LOWER(TRIM(COALESCE(bi.status, ''))) = 'running'
        AND bi.updated_at > NOW() - INTERVAL '30 minutes'
      ORDER BY bi.assigned_port_no, bi.updated_at DESC
    `,
      [systemVpsId]
    ).catch(() => ({ rows: [] }));

    for (const row of bots.rows || []) {
      const portNo = Number(row.assigned_port_no || 0);
      if (!portNo) continue;
      const ea = String(row.ea_status || '').trim().toLowerCase();
      if (ea && !['running', 'ready', ''].includes(ea)) continue;
      push(portNo, row.mt5_login, row.folder_path, 'bot_instance', {
        locked: true,
        running: true
      });
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

/** ส่งคำสั่งปิด MT5 ไป Agent (1 คำสั่งต่อ folder — ไม่ยิง port 1+101 และ force+stop ซ้ำ) */
async function queueForceStopMt5(systemVpsId, portNo, folderPath, reason = 'force_stop') {
  const vpsId = Number(systemVpsId || 0);
  const no = Number(portNo || 0);
  if (!vpsId || !no) return false;

  const folder = String(folderPath || '').trim();
  const why = String(reason || 'force_stop').trim() || 'force_stop';
  const { normalizeSystemFolderPortNo } = require('./mt5ReservedPortNo');
  const systemPort = normalizeSystemFolderPortNo(no);
  const slot = adminPortNoFromSystem(systemPort) || adminPortNoFromSystem(no) || no;

  if (folder) {
    const dup = await query(
      `
      SELECT id
      FROM vps_system.vps_agent_commands
      WHERE (vps_id = $1 OR node_id = $1)
        AND command_type = 'force_stop_mt5'
        AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'processing', 'picked', 'running')
        AND TRIM(COALESCE(payload->>'folder_path', payload->>'folderPath', '')) = $2
        AND created_at > NOW() - INTERVAL '90 seconds'
      LIMIT 1
    `,
      [vpsId, folder]
    ).catch(() => ({ rows: [] }));
    if (dup.rows?.[0]) return false;
  }

  const payload = {
    port: systemPort,
    port_no: systemPort,
    portNumber: systemPort,
    folderPort: systemPort,
    vpsPortNumber: systemPort,
    portSlot: slot,
    folder_path: folder,
    folderPath: folder,
    vpsFolderPath: folder,
    reason: why
  };
  await queueSystemAgentCommand(vpsId, 'force_stop_mt5', payload, null).catch(() => null);
  return true;
}

/** เคลียร์ PORT ทั้ง Agent + DB admin หลังปิด MT5 / ลบบัญชี */
async function releaseUserPortCompletely(opts = {}) {
  const systemVpsId = Number(opts.systemVpsId || 0);
  const adminNodeId = Number(opts.adminNodeId || opts.systemVpsId || 0);
  const portNo = Number(opts.portNo || 0);
  const folderPath = String(opts.folderPath || '').trim();
  const portId = Number(opts.portId || 0);
  const why = String(opts.reason || 'release_port').trim() || 'release_port';

  if (systemVpsId && portNo) {
    await queueForceStopMt5(systemVpsId, portNo, folderPath, why).catch(() => false);
    await clearPortHealthRunning(systemVpsId, portNo).catch(() => {});
  }

  if (adminNodeId && portNo) {
    await reconcilePortIdleWhenAgentFree(adminNodeId, portNo, folderPath, { forceRelease: true }).catch(
      () => {}
    );
  }

  if (portId) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available',
          mt5_login=NULL,
          current_mt5_login=NULL,
          locked_by_user_id=NULL,
          locked_until=NULL,
          process_id=NULL,
          updated_at=NOW()
      WHERE id=$1
    `,
      [portId]
    ).catch(() => {});
  }

  return { ok: true, portNo, systemVpsId };
}

function adminPortNoFromSystem(portNo) {
  const n = Number(portNo || 0);
  if (!n) return 0;
  return n >= 100 ? n % 100 : n;
}

function mergePortMapEntries(a = {}, b = {}) {
  const left = a && typeof a === 'object' ? a : {};
  const right = b && typeof b === 'object' ? b : {};
  if (!Object.keys(left).length) return { ...right };
  if (!Object.keys(right).length) return { ...left };
  const running = !!(left.running || right.running);
  const locked = !!(left.locked || right.locked);
  const pickSource = () => {
    if (right.running && !left.running) return right.source || left.source || 'db';
    if (left.running && !right.running) return left.source || right.source || 'db';
    if (right.source === 'bot_instance') return right.source;
    return left.source || right.source || 'db';
  };
  return {
    ...left,
    ...right,
    running,
    locked,
    mt5_login: left.mt5_login || right.mt5_login || null,
    folder_path: left.folder_path || right.folder_path || null,
    source: pickSource()
  };
}

function lookupMapByPort(map, portNo) {
  const no = Number(portNo || 0);
  if (!no) return {};
  const alt = no >= 100 ? adminPortNoFromSystem(no) : 100 + no;
  return mergePortMapEntries(map[no], map[alt]);
}

function lookupLiveHealth(liveMap, portNo) {
  return lookupMapByPort(liveMap, portNo);
}

function lookupDbUsage(dbUsageMap, portNo) {
  return lookupMapByPort(dbUsageMap, portNo);
}

/** สรุปสถานะ PORT สำหรับ /admin/vps/:id/ports/api/list */
function resolveAdminPortMt5State({ live = {}, dbUse = {}, adminDisabled = false, allocationStatus = '' } = {}) {
  if (adminDisabled) {
    return {
      inUse: false,
      locked: false,
      agentState: false,
      orphanRunning: false,
      mt5Login: null,
      usageSource: 'disabled'
    };
  }

  const agentState = isAgentMt5Running(live);
  const agentRunning = agentState === true;
  const dbRunning = dbUse.running === true;
  const mt5Running = agentRunning || (agentState === null && dbRunning);
  const allocSt = String(allocationStatus || '').trim().toLowerCase();
  const dbLogin = String(dbUse.mt5_login || live?.mt5_login || '').trim() || null;
  const dbLocked =
    dbUse.locked === true
    || ['locked', 'used'].includes(allocSt)
    || (dbLogin && ['connected', 'vps_port', 'allocation', 'bot_instance'].includes(String(dbUse.source || '')));
  const hasReservation = dbLocked || !!dbLogin;

  const inUse = mt5Running && hasReservation;
  const orphanRunning = mt5Running && !hasReservation;
  const locked = hasReservation && !inUse && !orphanRunning;

  let usageSource = 'none';
  if (inUse) {
    usageSource =
      agentRunning ? String(dbUse.source || 'agent') : String(dbUse.source || 'bot_instance');
  } else if (locked) usageSource = String(dbUse.source || 'locked');
  else if (orphanRunning) usageSource = 'orphan';
  else if (mt5Running) usageSource = 'agent_only';

  const mt5Login = inUse || locked || orphanRunning ? dbLogin || live?.mt5_login || null : null;

  return { inUse, locked, agentState, orphanRunning, mt5Login, usageSource };
}

const PORT_LOCK_IDLE_MINUTES = Math.max(1, Number(process.env.MT5_PORT_LOCK_IDLE_MINUTES || 5));

/** PORT ล็อกแต่ไม่มี MT5 / BOT / คำสั่ง login-run ภายในช่วง idle — ถือว่าไม่เคลื่อนไหว */
async function portHasRecentLockActivity({
  systemVpsId = 0,
  adminNodeId = 0,
  portId = 0,
  portNo = 0,
  folderPath = ''
} = {}) {
  const nodeIds = [...new Set([Number(systemVpsId), Number(adminNodeId)].filter((x) => x > 0))];
  const portNos = systemPortNosForAdmin(portNo);
  const idleMin = String(PORT_LOCK_IDLE_MINUTES);
  const folder = String(folderPath || '').trim();

  if (nodeIds.length && portNos.length) {
    const health = await query(
      `
      SELECT 1
      FROM vps_system.vps_port_health
      WHERE node_id = ANY($1::bigint[])
        AND port_number = ANY($2::int[])
        AND running = TRUE
        AND updated_at > NOW() - INTERVAL '2 minutes'
      LIMIT 1
    `,
      [nodeIds, portNos]
    ).catch(() => ({ rows: [] }));
    if (health.rows[0]) return true;
  }

  if (systemVpsId) {
    const bot = await query(
      `
      SELECT 1
      FROM vps_system.bot_instances bi
      WHERE bi.vps_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
          'running', 'pending', 'connecting', 'starting', 'restarting'
        )
        AND (
          ($2::bigint > 0 AND bi.port_id = $2)
          OR ($3 <> '' AND TRIM(COALESCE(bi.folder_path, '')) = $3)
          OR COALESCE(bi.assigned_port_no, 0) = ANY($4::int[])
        )
      LIMIT 1
    `,
      [systemVpsId, Number(portId || 0), folder, portNos]
    ).catch(() => ({ rows: [] }));
    if (bot.rows[0]) return true;

    const att = await query(
      `
      SELECT 1
      FROM vps_system.mt5_connect_attempts
      WHERE vps_id = $1
        AND LOWER(TRIM(COALESCE(status, ''))) IN ('starting', 'checking', 'connecting')
        AND updated_at > NOW() - ($2::text || ' minutes')::interval
        AND COALESCE(port_no, assigned_port_no, 0) = ANY($3::int[])
      LIMIT 1
    `,
      [systemVpsId, idleMin, portNos]
    ).catch(() => ({ rows: [] }));
    if (att.rows[0]) return true;

    const cmd = await query(
      `
      SELECT 1
      FROM vps_system.vps_agent_commands c
      WHERE c.vps_id = $1
        AND (
          ($2::bigint > 0 AND c.port_id = $2)
          OR (
            $3 <> ''
            AND TRIM(COALESCE(
              c.payload->>'vpsFolderPath',
              c.payload->>'folderPath',
              c.payload->>'folder_path',
              ''
            )) = $3
          )
          OR COALESCE(
            NULLIF(TRIM(COALESCE(c.payload->>'portNumber', c.payload->>'port_no', '')), '')::int,
            0
          ) = ANY($4::int[])
        )
        AND LOWER(COALESCE(c.command_type, '')) IN (
          'login_mt5', 'connect_mt5', 'run_mt5_bot', 'run_mt5', 'stop_mt5_bot', 'port_read_file'
        )
        AND (
          LOWER(COALESCE(c.status, '')) IN ('pending', 'processing', 'picked', 'running')
          OR (
            LOWER(COALESCE(c.status, '')) IN ('success', 'done')
            AND COALESCE(c.finished_at, c.updated_at, c.created_at)
                > NOW() - ($5::text || ' minutes')::interval
          )
        )
      LIMIT 1
    `,
      [systemVpsId, Number(portId || 0), folder, portNos, idleMin]
    ).catch(() => ({ rows: [] }));
    if (cmd.rows[0]) return true;
  }

  return false;
}

/** ล็อกค้างไม่เคลื่อนไหว → ว่าง (admin + system DB) */
async function expireStaleLockedPorts(adminNodeId = null, systemVpsIdOpt = null) {
  const idleMin = String(PORT_LOCK_IDLE_MINUTES);
  let scopeAdminId = Number(adminNodeId || 0);
  let scopedSystemId = Number(systemVpsIdOpt || 0);
  if (!scopedSystemId && scopeAdminId) {
    const mapped = await resolveSystemVpsId(scopeAdminId).catch(() => ({ systemVpsId: 0 }));
    scopedSystemId = Number(mapped.systemVpsId || 0);
  }
  if (!scopeAdminId && scopedSystemId) {
    const mapped = await resolveSystemVpsId(scopedSystemId).catch(() => ({ adminNodeId: 0 }));
    scopeAdminId = Number(mapped.adminNodeId || 0);
  }
  let cleared = 0;
  const seen = new Set();

  const portsRes = await query(
    `
    SELECT p.id, p.vps_id, p.port_no, p.folder_path, p.updated_at
    FROM vps_system.vps_ports p
    WHERE (
      LOWER(TRIM(COALESCE(p.status, ''))) = 'locked'
      OR p.locked_by_user_id IS NOT NULL
    )
      AND p.updated_at < NOW() - ($1::text || ' minutes')::interval
      AND ($2::bigint = 0 OR p.vps_id = $2)
    ORDER BY p.updated_at ASC
    LIMIT 80
  `,
    [idleMin, Number(scopedSystemId || 0)]
  ).catch(() => ({ rows: [] }));

  for (const row of portsRes.rows || []) {
    const key = `p:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { adminNodeId: aid, systemVpsId } = await resolveSystemVpsId(row.vps_id).catch(() => ({
      adminNodeId: 0,
      systemVpsId: Number(row.vps_id || 0)
    }));
    const portNo = adminPortNoFromSystem(row.port_no) || Number(row.port_no || 0);
    if (!portNo) continue;

    if (
      await portHasRecentLockActivity({
        systemVpsId,
        adminNodeId: aid,
        portId: row.id,
        portNo,
        folderPath: row.folder_path
      })
    ) {
      continue;
    }

    await releaseUserPortCompletely({
      systemVpsId,
      adminNodeId: aid,
      portNo,
      folderPath: row.folder_path,
      portId: row.id,
      reason: 'stale_lock_idle'
    }).catch(() => {});

    if (systemVpsId && portNo) {
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET status='ready',
            last_login_message='PORT หมดเวลาจอง — เลือก PORT ใหม่ได้',
            last_error=NULL,
            updated_at=NOW()
        WHERE vps_id=$1
          AND LOWER(TRIM(COALESCE(status, ''))) IN ('connected', 'checking', 'connecting', 'starting')
          AND (
            port_id=$2
            OR COALESCE(assigned_port_no, windows_port_no, 0) = ANY($3::int[])
            OR ($4 <> '' AND TRIM(COALESCE(folder_path, '')) = $4)
          )
      `,
        [systemVpsId, row.id, systemPortNosForAdmin(portNo), String(row.folder_path || '').trim()]
      ).catch(() => {});
    }

    cleared += 1;
  }

  await ensureVpsAllocationsAdminColumns().catch(() => {});
  const allocRes = await query(
      `
      SELECT a.id, a.node_id, a.folder_path, a.port_name, a.port_number, a.updated_at
      FROM vps_allocations a
      WHERE LOWER(TRIM(COALESCE(a.status, ''))) = 'locked'
        AND a.updated_at < NOW() - ($1::text || ' minutes')::interval
        AND ($2::bigint = 0 OR a.node_id = $2)
      ORDER BY a.updated_at ASC
      LIMIT 80
    `,
      [idleMin, scopeAdminId]
    ).catch(() => ({ rows: [] }));

    for (const row of allocRes.rows || []) {
      const portNo = parsePortNumber(row);
      const key = `a:${row.node_id}:${portNo}`;
      if (!portNo || seen.has(key)) continue;

      const { systemVpsId } = await resolveSystemVpsId(row.node_id).catch(() => ({
        systemVpsId: 0
      }));
      const folderPath = String(row.folder_path || '').trim();

      let portId = 0;
      if (systemVpsId) {
        const pr = await query(
          `
          SELECT id
          FROM vps_system.vps_ports
          WHERE vps_id=$1
            AND (
              ($2 <> '' AND TRIM(COALESCE(folder_path, '')) = $2)
              OR port_no = ANY($3::int[])
            )
          ORDER BY id ASC
          LIMIT 1
        `,
          [systemVpsId, folderPath, systemPortNosForAdmin(portNo)]
        ).catch(() => ({ rows: [] }));
        portId = Number(pr.rows[0]?.id || 0);
      }

      if (
        await portHasRecentLockActivity({
          systemVpsId,
          adminNodeId: row.node_id,
          portId,
          portNo,
          folderPath
        })
      ) {
        continue;
      }

      seen.add(key);
      await releaseUserPortCompletely({
        systemVpsId,
        adminNodeId: row.node_id,
        portNo,
        folderPath,
        portId: portId || undefined,
        reason: 'stale_alloc_lock_idle'
      }).catch(() => {});
      await setAdminAllocationStatus(row.node_id, portNo, 'free', row.id).catch(() => {});
      cleared += 1;
    }

  return cleared;
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
  queueForceStopMt5,
  releaseUserPortCompletely,
  fetchLiveHealthMap,
  fetchDbMt5UsageMap,
  upsertPortHealthRunning,
  clearPortHealthRunning,
  adminPortNoFromSystem,
  countLiveRunningPorts,
  countLiveUsedLot,
  ensureVpsAllocationsAdminColumns,
  setAdminAllocationStatus,
  syncStaleAdminAllocations,
  expireStaleLockedPorts,
  portHasRecentLockActivity,
  PORT_LOCK_IDLE_MINUTES,
  isPortAdminDisabled,
  hasFreshAgentHealth,
  isAgentMt5Running,
  reconcilePortIdleWhenAgentFree,
  isPortIntentionallyLocked,
  isAdminPortInUse,
  isAdminPortAvailableForLogin,
  isVpsNodeEligibleForLogin,
  lookupLiveHealth,
  lookupDbUsage,
  resolveAdminPortMt5State,
  VPS_ALLOC_PORT_NO_SQL,
  parsePortNumber,
  normalizePortSlot,
  systemPortNosForAdmin,
  adminPortNoFromSystem
};
