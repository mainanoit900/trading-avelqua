'use strict';

const { query } = require('../config/database');
const {
  resolveLiveMetricsTarget,
  instanceWhereSql,
  accountFromInstanceWhereSql,
  validateLiveMetricsTarget
} = require('./mt5LiveMetricsScope');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positiveMoney(v) {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

function profitMoney(v) {
  const n = num(v);
  return n != null ? n : null;
}

/**
 * อัปเดต bot_instances จาก Agent (run_bot / live heartbeat)
 */
async function applyMt5LiveStatus(body = {}) {
  const target = resolveLiveMetricsTarget(body);
  const { instanceId, accountId, port } = target;
  const {
    status,
    eaStatus,
    balance,
    equity,
    profit
  } = body;

  const targetErr = validateLiveMetricsTarget(target);
  if (targetErr) {
    return { ok: false, message: targetErr };
  }

  const errRaw =
    body.errorText != null
      ? body.errorText
      : body.error != null
        ? body.error
        : body.error_text != null
          ? body.error_text
          : null;

  const st = String(status || '').trim().toLowerCase();
  const ea = String(eaStatus || '').trim().toLowerCase();
  const balValEarly = positiveMoney(balance);
  const eqValEarly = positiveMoney(equity);
  const hasLiveMoney = balValEarly != null || eqValEarly != null;

  let statusToApply = status || null;
  let eaToApply = eaStatus || null;
  if (st === 'running' && ea !== 'running' && !['active', 'trading', 'started'].includes(ea)) {
    if (hasLiveMoney && (ea === 'ready' || ea === 'starting' || !ea)) {
      statusToApply = 'running';
      eaToApply = 'running';
    } else {
      statusToApply = 'pending';
      eaToApply = ea || 'starting';
    }
  } else if (st === 'starting') {
    if (hasLiveMoney) {
      statusToApply = 'running';
      eaToApply = 'running';
    } else {
      statusToApply = 'pending';
      eaToApply = ea || 'starting';
    }
  }

  let errSql = null;
  if (errRaw != null) {
    errSql = String(errRaw);
  } else if (st === 'running' || st === 'restarting' || st === 'starting') {
    errSql = '';
  }

  const balVal = positiveMoney(balance);
  const eqVal = positiveMoney(equity);
  const profitVal =
    profit != null && profit !== '' && Number.isFinite(Number(profit))
      ? profitMoney(profit)
      : balVal != null && eqVal != null
        ? Math.round((eqVal - balVal) * 100) / 100
        : null;

  const instWhere = instanceWhereSql('bi', 7);
  await query(
    `
    UPDATE vps_system.bot_instances bi
    SET status = COALESCE(NULLIF($1::text, ''), bi.status),
        ea_status = COALESCE(NULLIF($2::text, ''), bi.ea_status),
        mt5_balance = COALESCE($3::numeric, bi.mt5_balance),
        mt5_equity = COALESCE($4::numeric, bi.mt5_equity),
        profit = COALESCE($5::numeric, bi.profit),
        last_error = CASE
          WHEN $6::text IS NOT NULL THEN NULLIF(TRIM($6::text), '')
          ELSE bi.last_error
        END,
        last_agent_ping = NOW(),
        last_heartbeat = NOW(),
        updated_at = NOW()
    WHERE ${instWhere.sql}
  `,
    [
      statusToApply,
      eaToApply,
      balVal,
      eqVal,
      profitVal,
      errSql,
      ...instWhere.params(target)
    ]
  );

  if (accountId && (balVal != null || eqVal != null)) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET last_balance = COALESCE($2::numeric, last_balance),
          last_equity = COALESCE($3::numeric, last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
      [accountId, balVal, eqVal]
    ).catch(() => {});
  } else if (balVal != null || eqVal != null) {
    const accWhere = accountFromInstanceWhereSql(4);
    await query(
      `
      UPDATE vps_system.mt5_accounts a
      SET last_balance = COALESCE($2::numeric, a.last_balance),
          last_equity = COALESCE($3::numeric, a.last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE ${accWhere.sql}
    `,
      [balVal, eqVal, ...accWhere.params(target)]
    ).catch(() => {});
  }

  let metricsInstanceId = instanceId;
  if (!metricsInstanceId && (accountId || (target.userId && port))) {
    const instRow = await query(
      `
      SELECT id FROM vps_system.bot_instances bi
      WHERE ${instWhere.sql}
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
      ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
      LIMIT 1
      `,
      instWhere.params(target)
    ).catch(() => ({ rows: [] }));
    metricsInstanceId = instRow.rows?.[0]?.id || null;
  }

  if (metricsInstanceId && eqVal != null) {
    const { seedInstanceLiveMetrics } = require('./mt5EquityChart');
    await seedInstanceLiveMetrics(metricsInstanceId, balVal, eqVal).catch(() => {});
  }

  return { ok: true };
}

const { recordEquityLog: recordEquitySnapshot } = require('./mt5EquityChart');

async function recordEquityLog(instanceId, equity) {
  return recordEquitySnapshot(instanceId, equity);
}

module.exports = { applyMt5LiveStatus, positiveMoney, profitMoney, recordEquityLog };
