'use strict';

const { query } = require('../config/database');
const { notifyVpsAgentCommandQueued } = require('./vpsAgentCommandNotify');

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Cancel stale auxiliary commands that block login/bot on a VPS node.
 */
async function cleanupStuckVpsAgentQueue(vpsId, opts = {}) {
  const nid = num(vpsId);
  if (!nid) throw new Error('vpsId required');

  const stuckProcessingMin = Math.max(5, num(opts.stuckProcessingMin, 12));
  const cancelPurposes = opts.cancelPurposes !== false;

  const results = {
    vpsId: nid,
    cancelledPending: 0,
    resetProcessing: 0,
    agentVersion: null
  };

  if (cancelPurposes) {
    const cancel = await query(
      `
      UPDATE vps_system.vps_agent_commands
      SET status = 'cancelled',
          finished_at = COALESCE(finished_at, NOW()),
          updated_at = NOW(),
          result_message = COALESCE(result_message, 'cancelled_queue_cleanup')
      WHERE (vps_id = $1 OR node_id = $1)
        AND LOWER(COALESCE(status, '')) = 'pending'
        AND (
          command_type IN ('stop_mt5', 'force_stop_mt5', 'kill_mt5', 'port_read_file', 'read_file')
          OR (
            command_type IN ('account_snapshot', 'sync_mt5_account', 'read_account_metrics')
            AND COALESCE(payload->>'purpose', '') ~* 'login_equity|verify_mt5|attempt_verify'
          )
        )
      RETURNING id
    `,
      [nid]
    ).catch(() => ({ rows: [] }));
    results.cancelledPending = cancel.rows?.length || 0;
  }

  const reset = await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'failed',
        finished_at = COALESCE(finished_at, NOW()),
        updated_at = NOW(),
        result_message = COALESCE(result_message, 'reset_stuck_processing_cleanup')
    WHERE (vps_id = $1 OR node_id = $1)
      AND LOWER(COALESCE(status, '')) IN ('processing', 'picked', 'running')
      AND COALESCE(started_at, picked_at, created_at) < NOW() - (($2::text || ' minutes')::interval)
      AND command_type NOT IN ('deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent')
    RETURNING id
  `,
    [nid, String(stuckProcessingMin)]
  ).catch(() => ({ rows: [] }));
  results.resetProcessing = reset.rows?.length || 0;

  const hb = await query(
    `
    SELECT agent_version, last_seen_at, status
    FROM vps_system.vps_nodes
    WHERE id = $1
    LIMIT 1
  `,
    [nid]
  ).catch(() => ({ rows: [] }));
  const node = hb.rows?.[0];
  if (node) {
    results.agentVersion = node.agent_version || null;
    results.agentStatus = node.status || null;
    results.lastSeenAt = node.last_seen_at || null;
  }

  notifyVpsAgentCommandQueued({ vpsId: nid, commandId: 0, commandType: 'queue_cleanup' }).catch(() => {});
  return results;
}

module.exports = {
  cleanupStuckVpsAgentQueue
};
