'use strict';

const { query } = require('../config/database');
const { toJsonbParam } = require('./pgSanitize');

function dbQuery(client) {
  return client?.query
    ? (sql, params) => client.query(sql, params)
    : (sql, params) => query(sql, params);
}

/**
 * Unique index idx_vac_no_dup_pending: one pending row per (port_id, command_type).
 * Cancel older pending before inserting a new command on the same port.
 */
async function supersedePendingPortCommand(portId, commandType, vpsId = null, client = null) {
  const pid = Number(portId || 0);
  const ct = String(commandType || '').trim();
  if (!pid || !ct) return 0;

  const run = dbQuery(client);
  const r = await run(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'cancelled',
        error = COALESCE(error, 'superseded'),
        result_message = COALESCE(result_message, 'superseded by newer command'),
        finished_at = COALESCE(finished_at, NOW()),
        updated_at = NOW()
    WHERE LOWER(COALESCE(status, '')) = 'pending'
      AND port_id = $1
      AND command_type = $2
      AND ($3::bigint IS NULL OR vps_id = $3 OR node_id = $3)
    RETURNING id
  `,
    [pid, ct, vpsId ? Number(vpsId) : null]
  ).catch(() => ({ rows: [] }));

  return r.rows?.length || 0;
}

function isDupPendingConstraint(err) {
  if (!err || err.code !== '23505') return false;
  const msg = String(err.message || err.detail || '');
  return msg.includes('idx_vac_no_dup_pending') || msg.includes('vps_agent_commands');
}

/**
 * Insert pending command; safe for port-scoped types (login_mt5, run_mt5_bot, …).
 */
async function insertPendingAgentCommand({
  vpsId,
  nodeId = null,
  portId = null,
  commandType,
  payload = {},
  client = null
}) {
  const nid = Number(nodeId || vpsId || 0);
  const ct = String(commandType || '').trim();
  if (!nid || !ct) throw new Error('insertPendingAgentCommand: missing vpsId or commandType');

  const run = dbQuery(client);
  const pid = portId != null && portId !== '' ? Number(portId) : null;
  if (pid) {
    await supersedePendingPortCommand(pid, ct, nid, client);
  }

  const body = typeof payload === 'string' ? payload : toJsonbParam(payload || {});

  try {
    const r = await run(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1, $1, $2, $3, $4::jsonb, 'pending', NOW(), NOW())
      RETURNING id
    `,
      [nid, pid, ct, body]
    );
    return { id: Number(r.rows?.[0]?.id || 0), superseded: false };
  } catch (err) {
    if (pid && isDupPendingConstraint(err)) {
      await supersedePendingPortCommand(pid, ct, nid, client);
      const r2 = await run(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1, $1, $2, $3, $4::jsonb, 'pending', NOW(), NOW())
        RETURNING id
      `,
        [nid, pid, ct, body]
      );
      return { id: Number(r2.rows?.[0]?.id || 0), superseded: true };
    }
    throw err;
  }
}

/** ยกเลิกคำสั่งค้างที่ผูก accountId (หลังลบ PORT / บัญชี deleted) */
async function cancelAgentCommandsForAccount(accountId, vpsId = null) {
  const aid = String(accountId || '').trim();
  if (!aid) return 0;
  const r = await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'cancelled',
        error = COALESCE(error, 'cancelled: account removed'),
        result_message = COALESCE(result_message, 'cancelled: account removed'),
        finished_at = COALESCE(finished_at, NOW()),
        updated_at = NOW()
    WHERE COALESCE(payload->>'accountId', '') = $1
      AND ($2::bigint IS NULL OR vps_id = $2 OR node_id = $2)
      AND LOWER(COALESCE(status, '')) IN (
        'pending', 'queued', 'picked', 'processing', 'running', 'in_progress'
      )
    RETURNING id
  `,
    [aid, vpsId ? Number(vpsId) : null]
  ).catch(() => ({ rows: [] }));
  return r.rows?.length || 0;
}

module.exports = {
  supersedePendingPortCommand,
  insertPendingAgentCommand,
  isDupPendingConstraint,
  cancelAgentCommandsForAccount
};
