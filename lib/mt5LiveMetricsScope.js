'use strict';

/**
 * Bind live metrics updates to a single account/instance (never by port alone).
 */
function resolveLiveMetricsTarget(body = {}) {
  const instanceId = Number(body.instanceId || body.instance_id || 0) || null;
  const accountId = Number(body.accountId || body.account_id || 0) || null;
  const userId = Number(body.userId || body.user_id || 0) || null;
  const port = Number(body.port || body.portNumber || body.port_no || body.portSlot || 0) || null;
  return { instanceId, accountId, userId, port };
}

function instanceWhereSql(alias = 'bi', startParam = 1) {
  const p = (n) => `$${startParam + n - 1}`;
  return {
    sql: `
      (
        ${p(1)}::bigint IS NOT NULL AND ${alias}.id = ${p(1)}::bigint
      )
      OR (
        ${p(2)}::bigint IS NOT NULL
        AND ${alias}.mt5_account_id = ${p(2)}::bigint
      )
      OR (
        ${p(3)}::bigint IS NOT NULL
        AND ${p(4)}::int IS NOT NULL
        AND ${alias}.user_id = ${p(3)}::bigint
        AND ${alias}.assigned_port_no = ${p(4)}::int
        AND (
          ${p(2)}::bigint IS NULL
          OR ${alias}.mt5_account_id = ${p(2)}::bigint
        )
      )
    `,
    params: (target) => [target.instanceId, target.accountId, target.userId, target.port]
  };
}

function accountFromInstanceWhereSql(startParam = 1) {
  const p = (n) => `$${startParam + n - 1}`;
  return {
    sql: `
      EXISTS (
        SELECT 1 FROM vps_system.bot_instances bi
        WHERE bi.mt5_account_id = a.id
          AND (
            (${p(1)}::bigint IS NOT NULL AND bi.id = ${p(1)}::bigint)
            OR (${p(2)}::bigint IS NOT NULL AND bi.mt5_account_id = ${p(2)}::bigint)
            OR (
              ${p(3)}::bigint IS NOT NULL
              AND ${p(4)}::int IS NOT NULL
              AND bi.user_id = ${p(3)}::bigint
              AND bi.assigned_port_no = ${p(4)}::int
              AND (${p(2)}::bigint IS NULL OR bi.mt5_account_id = ${p(2)}::bigint)
            )
          )
      )
    `,
    params: (target) => [target.instanceId, target.accountId, target.userId, target.port]
  };
}

function validateLiveMetricsTarget(target) {
  if (target.instanceId || target.accountId) return null;
  if (target.userId && target.port) return null;
  return 'instanceId, accountId, or userId+port required';
}

const ACTIVE_METRICS_STATUS_SQL = `'running', 'pending', 'restarting', 'connecting', 'starting'`;

/**
 * อัปเดต metrics แค่ 1 instance (รอบล่าสุดที่ยัง active) — ไม่แตะประวัติ stopped
 */
async function resolveMetricsInstanceId(target, { query }) {
  const instanceId = Number(target.instanceId || 0) || null;
  if (instanceId) return instanceId;

  const accountId = Number(target.accountId || 0) || null;
  const userId = Number(target.userId || 0) || null;
  const port = Number(target.port || 0) || null;

  const r = await query(
    `
    SELECT bi.id
    FROM vps_system.bot_instances bi
    WHERE LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_METRICS_STATUS_SQL})
      AND bi.stopped_at IS NULL
      AND (
        ($1::bigint IS NOT NULL AND bi.id = $1::bigint)
        OR ($2::bigint IS NOT NULL AND bi.mt5_account_id = $2)
        OR (
          $3::bigint IS NOT NULL AND $4::int IS NOT NULL
          AND bi.user_id = $3 AND bi.assigned_port_no = $4
        )
      )
    ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
    LIMIT 1
    `,
    [instanceId, accountId, userId, port]
  ).catch(() => ({ rows: [] }));

  return r.rows?.[0]?.id || null;
}

module.exports = {
  resolveLiveMetricsTarget,
  instanceWhereSql,
  accountFromInstanceWhereSql,
  validateLiveMetricsTarget,
  resolveMetricsInstanceId,
  ACTIVE_METRICS_STATUS_SQL
};
