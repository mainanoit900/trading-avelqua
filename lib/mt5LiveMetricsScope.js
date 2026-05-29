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

module.exports = {
  resolveLiveMetricsTarget,
  instanceWhereSql,
  accountFromInstanceWhereSql,
  validateLiveMetricsTarget
};
