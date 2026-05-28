'use strict';

const { query } = require('../config/database');

/** จำนวน login ที่กำลังทำงานต่อ vps_id (ใช้เลือก VPS ที่โหลดน้อยกว่าเมื่อ user หลายคน login พร้อมกัน) */
async function fetchVpsActiveLoginLoadMap() {
  const r = await query(
    `
    SELECT vps_id::bigint AS vps_id, COUNT(*)::int AS load
    FROM (
      SELECT vps_id
      FROM vps_system.mt5_connect_attempts
      WHERE vps_id IS NOT NULL
        AND LOWER(COALESCE(status, '')) IN ('starting', 'checking')
        AND created_at > NOW() - INTERVAL '20 minutes'
      UNION ALL
      SELECT vps_id
      FROM vps_system.vps_agent_commands
      WHERE vps_id IS NOT NULL
        AND LOWER(COALESCE(command_type, '')) IN ('login_mt5', 'connect_mt5')
        AND LOWER(COALESCE(status, '')) IN ('pending', 'processing')
        AND created_at > NOW() - INTERVAL '20 minutes'
    ) active
    GROUP BY vps_id
    `
  ).catch(() => ({ rows: [] }));

  const map = Object.create(null);
  for (const row of r.rows || []) {
    const id = Number(row.vps_id || 0);
    if (id > 0) map[id] = Number(row.load || 0);
  }
  return map;
}

function loginLoadFor(map, vpsId) {
  const id = Number(vpsId || 0);
  if (!id) return 0;
  return Number(map[id] || 0);
}

module.exports = {
  fetchVpsActiveLoginLoadMap,
  loginLoadFor
};
