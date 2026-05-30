'use strict';

const { query, getClient } = require('../config/database');
const { reserveAdminPortForLogin } = require('./adminVpsPortPicker');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function vpsPortFolderRegexForSlot(slot) {
  const s = Math.max(1, num(slot));
  return `-PORT-${String(s).padStart(2, '0')}([^0-9]|$)`;
}

async function reserveMt5PortFallback(userId) {
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

    const portRes = await client.query(`
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
            AND a.assigned_port_no = p.port_no
            AND LOWER(COALESCE(a.status, '')) IN ('connecting', 'checking', 'connected', 'ready', 'starting')
        )
      ORDER BY COALESCE(n.cpu_percent, 0) ASC, COALESCE(n.ping_ms, 0) ASC, p.port_no ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `);

    const port = portRes.rows[0];
    if (!port) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        message: adminReserve.message || 'ไม่มี PORT ว่างในขณะนี้ — ตรวจสอบ /admin/vps'
      };
    }

    await client.query(`
      UPDATE vps_system.vps_ports
      SET status='locked', locked_by_user_id=$1, locked_until=NOW() + INTERVAL '3 minutes', updated_at=NOW()
      WHERE id=$2
    `, [userId, port.port_id]);

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

/** จอง Folder PORT บน VPS — จับคู่ package slot (1→PORT-01 / port_no 101) */
async function reserveVpsPortForConnect(userId, existingPortId, portSlot = 0) {
  const pid = num(existingPortId);
  if (pid > 0) {
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
    if (port && String(port.folder_path || '').trim()) {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='locked', locked_by_user_id=$2, locked_until=NOW() + INTERVAL '3 minutes', updated_at=NOW()
        WHERE id=$1
      `,
        [port.port_id, userId]
      ).catch(() => {});
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
  }

  const slot = num(portSlot);
  if (slot > 0) {
    const preferred = await query(
      `
      SELECT p.id AS port_id, p.vps_id, p.port_no, p.folder_path, n.node_name
      FROM vps_system.vps_ports p
      INNER JOIN vps_system.vps_nodes n ON n.id = p.vps_id
      WHERE LOWER(COALESCE(p.status, '')) IN ('available', 'free', 'idle')
        AND LOWER(COALESCE(p.status, '')) NOT IN ('disabled', 'off', 'deleted')
        AND COALESCE(n.agent_enabled, TRUE) = TRUE
        AND LOWER(TRIM(COALESCE(n.status, ''))) IN ('online', 'available', 'active', 'connected')
        AND COALESCE(TRIM(p.folder_path), '') <> ''
        AND (
          p.port_no = $1
          OR p.port_no = (100 + $1)
          OR p.folder_path ~* $2
        )
      ORDER BY
        CASE WHEN p.port_no = (100 + $1) THEN 0 WHEN p.port_no = $1 THEN 1 ELSE 2 END,
        COALESCE(n.cpu_percent, 0) ASC,
        COALESCE(n.ping_ms, 0) ASC,
        p.port_no ASC
      LIMIT 1
      FOR UPDATE OF p SKIP LOCKED
    `,
      [slot, vpsPortFolderRegexForSlot(slot)]
    ).catch(() => ({ rows: [] }));

    const pick = preferred.rows?.[0];
    if (pick) {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='locked', locked_by_user_id=$2, locked_until=NOW() + INTERVAL '3 minutes', updated_at=NOW()
        WHERE id=$1
      `,
        [pick.port_id, userId]
      ).catch(() => {});
      return {
        ok: true,
        port: {
          port_id: pick.port_id,
          vps_id: pick.vps_id,
          port_number: pick.port_no,
          port_no: pick.port_no,
          folder_path: pick.folder_path,
          node_name: pick.node_name
        },
        reused: false,
        matchedSlot: true
      };
    }
  }

  return reserveMt5PortFallback(userId);
}

module.exports = {
  reserveVpsPortForConnect,
  vpsPortFolderRegexForSlot
};
