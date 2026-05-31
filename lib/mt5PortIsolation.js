'use strict';

const { query } = require('../config/database');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Ports ที่ user นี้มีบน VPS (assigned) + ports ที่ควรคง MT5 ไว้ (บอท active + port เป้าหมาย)
 */
async function loadUserPortIsolationContext(userId, vpsId, targetPortNo = 0) {
  const uid = num(userId);
  const vid = num(vpsId);
  const target = num(targetPortNo);
  if (!uid || !vid) {
    return { userPortNumbers: [], keepOpenPorts: target > 0 ? [target] : [] };
  }

  const [accountRows, botRows] = await Promise.all([
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
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'starting', 'connecting')
    `,
      [uid, vid]
    ).catch(() => ({ rows: [] }))
  ]);

  const userPortNumbers = [
    ...new Set(
      (accountRows.rows || [])
        .map((r) => num(r.port_no))
        .filter((n) => n > 0)
    )
  ];

  const keepOpenPorts = new Set(
    (botRows.rows || [])
      .map((r) => num(r.port_no))
      .filter((n) => n > 0)
  );
  if (target > 0) keepOpenPorts.add(target);

  return {
    userPortNumbers,
    keepOpenPorts: [...keepOpenPorts]
  };
}

function attachPortIsolationFields(payload, ctx) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const userPortNumbers = Array.isArray(ctx?.userPortNumbers) ? ctx.userPortNumbers : [];
  const keepOpenPorts = Array.isArray(ctx?.keepOpenPorts) ? ctx.keepOpenPorts : [];
  return {
    ...base,
    userPortNumbers,
    user_port_numbers: userPortNumbers,
    keepOpenPorts,
    keep_open_ports: keepOpenPorts
  };
}

module.exports = {
  attachPortIsolationFields,
  loadUserPortIsolationContext
};
