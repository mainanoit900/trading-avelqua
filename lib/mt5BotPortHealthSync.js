'use strict';

const { query } = require('../config/database');

function normLogin(v) {
  return String(v || '').replace(/\D/g, '').trim();
}

/**
 * เมื่อ MT5 รันบน PORT แล้ว (port-health) แต่ DB ค้าง pending/starting — ยกเป็น running
 */
async function reconcileBotsFromPortHealth(nodeId, ports = []) {
  const nid = Number(nodeId || 0);
  if (!nid || !Array.isArray(ports) || !ports.length) return { updated: 0 };

  let updated = 0;
  for (const p of ports) {
    const portNo = Number(p.port_no || p.portNo || p.port_number || p.portNumber || 0);
    if (!portNo) continue;
    const running = !!(p.running ?? p.is_running ?? p.isRunning);
    if (!running) continue;

    const login = normLogin(p.mt5_login || p.mt5Login);
    if (!login) continue;

    const r = await query(
      `
      UPDATE vps_system.bot_instances bi
      SET status = 'running',
          ea_status = 'running',
          mt5_balance = COALESCE(NULLIF(bi.mt5_balance, 0), a.last_balance, bi.mt5_balance),
          mt5_equity = COALESCE(NULLIF(bi.mt5_equity, 0), a.last_equity, bi.mt5_equity),
          last_agent_ping = GREATEST(COALESCE(bi.last_agent_ping, 'epoch'::timestamptz), NOW()),
          last_heartbeat = NOW(),
          updated_at = NOW(),
          last_error = CASE
            WHEN LOWER(TRIM(COALESCE(bi.last_error, ''))) IN ('', 'superseded_by_newer_run') THEN NULL
            ELSE bi.last_error
          END
      FROM vps_system.mt5_accounts a
      WHERE bi.vps_id = $1
        AND bi.assigned_port_no = $2
        AND a.id = bi.mt5_account_id
        AND regexp_replace(COALESCE(a.mt5_login::text, ''), '\\D', '', 'g') = $3
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN ('pending', 'starting', 'connecting', 'restarting')
        AND bi.stopped_at IS NULL
        AND COALESCE(bi.run_payload->>'userStopped', '') NOT IN ('true', '1', 'yes')
        AND (
          LOWER(TRIM(COALESCE(bi.ea_status, ''))) IN (
            '', 'starting', 'ready', 'attach_required', 'pending', 'stopped'
          )
          OR bi.ea_status IS NULL
        )
      RETURNING bi.id
      `,
      [nid, portNo, login]
    ).catch(() => ({ rows: [] }));

    updated += r.rowCount || 0;
  }

  return { updated };
}

module.exports = { reconcileBotsFromPortHealth, normLogin };
