'use strict';

const { query } = require('../config/database');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** system 101 ↔ folder 1 */
function portNoVariants(portNo) {
  const n = num(portNo);
  if (n <= 0) return [];
  if (n >= 100) return [...new Set([n, n % 100])].filter((x) => x > 0);
  return [...new Set([n, 100 + n])].filter((x) => x > 0);
}

/**
 * FolderPort บน VPS ที่มี MT5/บอท active จาก user ใดก็ตาม — ห้าม kill / ห้ามจองทับ
 */
async function loadVpsProtectedPorts(vpsId) {
  const vid = num(vpsId);
  if (!vid) return [];

  const r = await query(
    `
    SELECT DISTINCT port_no FROM (
      SELECT bi.assigned_port_no AS port_no
      FROM vps_system.bot_instances bi
      WHERE bi.vps_id = $1
        AND bi.assigned_port_no IS NOT NULL
        AND bi.stopped_at IS NULL
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
          'running', 'pending', 'starting', 'connecting', 'restarting'
        )
      UNION
      SELECT a.assigned_port_no AS port_no
      FROM vps_system.mt5_accounts a
      WHERE a.vps_id = $1
        AND a.assigned_port_no IS NOT NULL
        AND LOWER(TRIM(COALESCE(a.status, ''))) IN (
          'connected', 'connecting', 'checking', 'starting', 'ready'
        )
      UNION
      SELECT h.port_number AS port_no
      FROM vps_system.vps_port_health h
      WHERE h.node_id = $1
        AND COALESCE(h.running, FALSE) = TRUE
        AND h.port_number IS NOT NULL
    ) x
    WHERE port_no IS NOT NULL AND port_no > 0
    `,
    [vid]
  ).catch(() => ({ rows: [] }));

  return [
    ...new Set(
      (r.rows || [])
        .flatMap((row) => portNoVariants(row.port_no))
        .filter((n) => n > 0)
    )
  ];
}

/**
 * Ports ที่ user นี้มีบน VPS + ports ที่ต้องคง MT5 ไว้ (บอท active ทุก user + port เป้าหมาย)
 */
async function loadUserPortIsolationContext(userId, vpsId, targetPortNo = 0) {
  const uid = num(userId);
  const vid = num(vpsId);
  const target = num(targetPortNo);
  if (!uid || !vid) {
    const fallback = target > 0 ? portNoVariants(target) : [];
    return {
      userPortNumbers: [],
      keepOpenPorts: fallback,
      protectedPorts: fallback,
      vpsProtectedPorts: fallback
    };
  }

  const [accountRows, botRows, vpsProtectedPorts] = await Promise.all([
    query(
      `
      SELECT DISTINCT assigned_port_no AS port_no
      FROM vps_system.mt5_accounts
      WHERE user_id = $1
        AND vps_id = $2
        AND assigned_port_no IS NOT NULL
        AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    `,
      [uid, vid]
    ).catch(() => ({ rows: [] })),
    query(
      `
      SELECT DISTINCT bi.assigned_port_no AS port_no
      FROM vps_system.bot_instances bi
      WHERE bi.user_id = $1
        AND bi.vps_id = $2
        AND bi.assigned_port_no IS NOT NULL
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (
          'running', 'pending', 'starting', 'connecting', 'restarting'
        )
        AND bi.stopped_at IS NULL
    `,
      [uid, vid]
    ).catch(() => ({ rows: [] })),
    loadVpsProtectedPorts(vid)
  ]);

  const userPortNumbers = [
    ...new Set(
      (accountRows.rows || [])
        .flatMap((r) => portNoVariants(r.port_no))
        .filter((n) => n > 0)
    )
  ];

  const keepOpenPorts = new Set([
    ...(botRows.rows || []).flatMap((r) => portNoVariants(r.port_no)),
    ...vpsProtectedPorts
  ]);
  if (target > 0) portNoVariants(target).forEach((n) => keepOpenPorts.add(n));

  return {
    userPortNumbers,
    keepOpenPorts: [...keepOpenPorts],
    protectedPorts: vpsProtectedPorts,
    vpsProtectedPorts
  };
}

function attachPortIsolationFields(payload, ctx) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const userPortNumbers = Array.isArray(ctx?.userPortNumbers) ? ctx.userPortNumbers : [];
  const keepOpenPorts = Array.isArray(ctx?.keepOpenPorts) ? ctx.keepOpenPorts : [];
  const protectedPorts = Array.isArray(ctx?.protectedPorts)
    ? ctx.protectedPorts
    : Array.isArray(ctx?.vpsProtectedPorts)
      ? ctx.vpsProtectedPorts
      : [];
  return {
    ...base,
    userPortNumbers,
    user_port_numbers: userPortNumbers,
    keepOpenPorts,
    keep_open_ports: keepOpenPorts,
    protectedPorts,
    protected_ports: protectedPorts,
    vpsProtectedPorts: protectedPorts,
    vps_protected_ports: protectedPorts
  };
}

module.exports = {
  attachPortIsolationFields,
  loadUserPortIsolationContext,
  loadVpsProtectedPorts,
  portNoVariants
};
