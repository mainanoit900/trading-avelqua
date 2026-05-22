'use strict';

/**
 * สองชั้นที่ต้องแยกใน UI/API:
 * - packagePortSlot (PORT แพ็กเกจ): ช่องตาม subscription — ใช้จำกัดจำนวนบอท/Login ต่อ user
 * - folderPortNo (FolderPort บน VPS): โฟลเดอร์ MT5 จริง C:\MT5_PORTS\… — เปิด terminal + รัน EA
 * คู่กัน 1:1 โดยทั่วไป (PORT แพ็กเกจ 2 → FolderPort P02)
 */

const { query } = require('../config/database');
const {
  resolveSystemVpsId,
  normalizePortSlot,
  fetchLiveHealthMap,
  fetchDbMt5UsageMap,
  isAdminPortAvailableForLogin,
  parsePortNumber
} = require('./adminVpsBridge');

const VPS_SEEN_MS = Number(process.env.VPS_LOGIN_NODE_SEEN_MS || 10 * 60 * 1000);

function shortVpsLabel(name) {
  const n = String(name || '').trim();
  if (!n) return 'VPS';
  return n.replace(/^VPS[-_\s]*/i, '') || n;
}

function folderStateLabel({ available, running, mt5Login }) {
  if (running && mt5Login) return `MT5 เปิดอยู่ · Login ${mt5Login}`;
  if (running) return 'MT5 เปิดอยู่ (ไม่ว่าง)';
  if (available) return 'ว่าง (พร้อม Login)';
  return 'ไม่ว่าง';
}

/** รายการ VPS จาก /admin/vps + สถานะ Agent */
async function listVpsNodesStatus() {
  const r = await query(
    `
    SELECT
      n.id AS admin_node_id,
      COALESCE(sn.id, n.id) AS system_vps_id,
      COALESCE(n.node_name, '') AS node_name,
      LOWER(COALESCE(n.status, sn.status, 'offline')) AS node_status,
      COALESCE(n.agent_enabled, sn.agent_enabled, TRUE) AS agent_enabled,
      GREATEST(
        COALESCE(n.last_seen_at, n.updated_at, 'epoch'::timestamptz),
        COALESCE(sn.last_seen_at, sn.updated_at, 'epoch'::timestamptz),
        COALESCE(sn.last_heartbeat, 'epoch'::timestamptz)
      ) AS last_seen_at,
      COALESCE(sn.last_heartbeat, sn.last_seen_at) AS last_heartbeat
    FROM vps_nodes n
    LEFT JOIN vps_system.vps_nodes sn
      ON UPPER(TRIM(COALESCE(sn.node_code, ''))) = UPPER(TRIM(COALESCE(n.node_name, '')))
    WHERE COALESCE(n.agent_enabled, TRUE) = TRUE
    ORDER BY n.id ASC
    `,
    []
  ).catch(() => ({ rows: [] }));

  const now = Date.now();
  return (r.rows || []).map((row) => {
    const last = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    const ageMs = last ? now - last : Number.MAX_SAFE_INTEGER;
    const agentOnline = ageMs <= VPS_SEEN_MS;
    const st = String(row.node_status || '').toLowerCase();
    return {
      adminNodeId: Number(row.admin_node_id),
      systemVpsId: Number(row.system_vps_id),
      nodeName: String(row.node_name || '').trim() || `VPS-${row.admin_node_id}`,
      nodeStatus: st,
      agentOnline,
      agentEnabled: row.agent_enabled !== false,
      lastSeenAt: row.last_seen_at,
      lastSeenSec: ageMs < Number.MAX_SAFE_INTEGER ? Math.floor(ageMs / 1000) : null,
      adminUrl: `/admin/vps/${row.admin_node_id}/ports`,
      label: agentOnline ? 'Agent ทำงาน' : 'Agent ไม่ตอบสนอง'
    };
  });
}

/** โฟลเดอร์ PORT ทุกตัวบน VPS ที่ online (เหมือน /admin/vps/:id/ports ย่อ) */
async function listFolderPortsOnNode(adminNodeId) {
  const nid = Number(adminNodeId || 0);
  if (!nid) return [];

  const r = await query(
    `
    SELECT
      p.id AS allocation_id,
      p.port_name,
      p.port_number,
      COALESCE(NULLIF(TRIM(p.folder_path), ''), '') AS folder_path,
      LOWER(COALESCE(p.status, 'free')) AS port_status,
      COALESCE(p.is_active, TRUE) AS is_active
    FROM vps_allocations p
    WHERE p.node_id = $1
      AND LOWER(COALESCE(p.status, '')) NOT IN ('disabled', 'off', 'deleted', 'inactive')
    ORDER BY
      COALESCE(
        NULLIF((regexp_match(COALESCE(p.port_name, ''), '(?i)PORT[-_ ]*([0-9]+)$'))[1], '')::int,
        NULLIF(NULLIF(regexp_replace(COALESCE(p.port_number::text, ''), '[^0-9]', '', 'g'), ''), '')::int,
        0
      ) ASC
    `,
    [nid]
  ).catch(() => ({ rows: [] }));

  const liveMap = await fetchLiveHealthMap(nid).catch(() => ({}));
  const dbMap = await fetchDbMt5UsageMap(nid).catch(() => ({}));
  const { nodeName } = await resolveSystemVpsId(nid);

  return (r.rows || []).map((row) => {
    const portNo = parsePortNumber(row);
    const live = liveMap[portNo] || liveMap[normalizePortSlot(portNo)] || {};
    const db = dbMap[portNo] || {};
    const running = live.running === true || db.running === true;
    const mt5Login = String(live.mt5_login || db.mt5_login || '').trim() || null;
    const folderPath =
      String(row.folder_path || live.folder_path || db.folder_path || '').trim() ||
      `C:\\MT5_PORTS\\${row.port_name || 'PORT-' + String(portNo).padStart(2, '0')}`;
    let available = isAdminPortAvailableForLogin(row, liveMap, dbMap);
    if (running) available = false;
    return {
      adminNodeId: nid,
      nodeName,
      portNumber: portNo,
      portName: row.port_name,
      folderPath,
      running,
      mt5Login,
      available,
      folderState: folderStateLabel({ available, running, mt5Login }),
      adminPortsUrl: `/admin/vps/${nid}/ports`
    };
  });
}

/** รวม Folder PORT จาก VPS ที่พร้อม Login */
async function listAllFolderPortsForConnect() {
  const nodes = await listVpsNodesStatus();
  const out = [];
  for (const node of nodes) {
    if (!node.agentEnabled) continue;
    const rows = await listFolderPortsOnNode(node.adminNodeId);
    for (const fp of rows) {
      out.push({ ...fp, vpsOnline: node.agentOnline, vpsLabel: node.label });
    }
  }
  return { nodes, folderPorts: out };
}

/**
 * Folder PORT ต้องตรง package slot เท่านั้น (PORT 2 → P02 / PORT-02)
 * ไม่ fallback ไป P01 — กันภาพ "ซ้อน folder"
 */
function pickFolderPortForSlot(folderPorts, slot, nodes) {
  const s = Number(slot || 0);
  if (!s) return null;
  const onlineIds = new Set(
    (nodes || []).filter((n) => n.agentOnline).map((n) => n.adminNodeId)
  );
  const rows = (folderPorts || []).filter(
    (fp) => fp.portNumber === s && onlineIds.has(fp.adminNodeId)
  );
  if (!rows.length) return null;
  rows.sort((a, b) => (a.available === b.available ? 0 : a.available ? -1 : 1));
  return rows[0];
}

/** เสริมข้อมูลให้แต่ละ package port slot บนหน้า /app/mt5 */
async function enrichPackagePortsForUi(ports, accounts) {
  const { nodes, folderPorts } = await listAllFolderPortsForConnect();
  const onlineCount = nodes.filter((n) => n.agentOnline).length;

  return {
    vpsNodes: nodes,
    vpsOnlineCount: onlineCount,
    vpsTotalCount: nodes.length,
    folderPorts,
    ports: (ports || []).map((p) => {
      const slot = Number(p.slot || 0);
      const acc = (accounts || []).find((a) => Number(a.port_slot) === slot);
      const folder = pickFolderPortForSlot(folderPorts, slot, nodes);
      const accFolder = acc?.folder_path || folder?.folderPath || null;
      const sublabel = p.sublabel || (p.accountId ? `Login ${p.mt5_login || acc?.mt5_login || '—'}` : 'ยังไม่เชื่อมต่อ');
      const canPick =
        !p.accountId &&
        p.canPick !== false &&
        (!folder || folder.available !== false) &&
        (folder ? folder.vpsOnline !== false : onlineCount > 0);
      return {
        ...p,
        sublabel,
        canPick,
        canLogin: canPick,
        packagePortSlot: slot,
        folderPortNo: folder ? folder.portNumber : null,
        folderPath: folder?.folderPath || accFolder || null,
        folderMismatch: folder && folder.portNumber !== slot,
        vpsNodeName: folder?.nodeName || null,
        vpsOnline: folder?.vpsOnline ?? (onlineCount > 0),
        folderRunning: folder?.running ?? false,
        folderMt5Login: folder?.mt5Login ?? null,
        folderAvailable:
          folder?.running === true ? false : folder?.available ?? null,
        folderState: folder?.folderState || (onlineCount ? 'รอเลือก' : 'ไม่มี VPS online'),
        adminPortsUrl: folder?.adminPortsUrl || null
      };
    })
  };
}

module.exports = {
  listVpsNodesStatus,
  listFolderPortsOnNode,
  listAllFolderPortsForConnect,
  pickFolderPortForSlot,
  enrichPackagePortsForUi,
  folderStateLabel,
  shortVpsLabel
};
