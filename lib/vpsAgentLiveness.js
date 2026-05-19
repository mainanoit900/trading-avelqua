'use strict';

const { query } = require('../config/database');

const VPS_AGENT_LIVE_MS = Number(process.env.VPS_AGENT_LIVE_MS || 5 * 60 * 1000);

/**
 * ตรวจว่า Python Agent บน VPS ยัง heartbeat / port-health อยู่หรือไม่
 */
async function checkVpsAgentLiveness(vpsId) {
  const nid = Number(vpsId || 0);
  if (!nid) {
    return { ok: false, message: 'ไม่พบ VPS สำหรับเชื่อมต่อ' };
  }

  const r = await query(
    `
    SELECT id, node_code, status, agent_enabled, last_seen_at, last_heartbeat, agent_version
    FROM vps_system.vps_nodes
    WHERE id = $1
    LIMIT 1
  `,
    [nid]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row) {
    return { ok: false, message: 'ไม่พบ Windows VPS ในระบบ' };
  }
  if (row.agent_enabled === false) {
    return { ok: false, message: 'VPS Agent ถูกปิดใช้งาน — ติดต่อแอดมิน' };
  }

  const seenTs = row.last_seen_at
    ? new Date(row.last_seen_at).getTime()
    : row.last_heartbeat
      ? new Date(row.last_heartbeat).getTime()
      : 0;

  if (seenTs && Date.now() - seenTs <= VPS_AGENT_LIVE_MS) {
    return { ok: true, node: row, ageMs: Date.now() - seenTs };
  }

  const ph = await query(
    `
    SELECT MAX(updated_at) AS last_health
    FROM vps_system.vps_port_health
    WHERE node_id = $1
    `,
    [nid]
  ).catch(() => ({ rows: [] }));

  const healthTs = ph.rows?.[0]?.last_health
    ? new Date(ph.rows[0].last_health).getTime()
    : 0;
  if (healthTs && Date.now() - healthTs <= VPS_AGENT_LIVE_MS) {
    return { ok: true, node: row, ageMs: Date.now() - healthTs, source: 'port_health' };
  }

  const ageMin = seenTs ? Math.max(1, Math.round((Date.now() - seenTs) / 60000)) : null;
  const hint = ageMin
    ? ` (ไม่ตอบสนอง ~${ageMin} นาที)`
    : '';
  return {
    ok: false,
    message:
      `VPS Agent ไม่ตอบสนอง${hint} — รอ 1–3 นาทีแล้วลองใหม่ หรือ restart service AvelquaPythonAgent บน VPS`,
    node: row,
    staleMs: seenTs ? Date.now() - seenTs : null
  };
}

module.exports = {
  checkVpsAgentLiveness,
  VPS_AGENT_LIVE_MS
};
