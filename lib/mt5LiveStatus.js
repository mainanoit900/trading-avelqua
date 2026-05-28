'use strict';

const { query } = require('../config/database');

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
  const {
    instanceId,
    accountId,
    port,
    status,
    eaStatus,
    balance,
    equity,
    profit
  } = body;

  if (!instanceId && !port && !accountId) {
    return { ok: false, message: 'instanceId, port or accountId required' };
  }

  const errRaw =
    body.errorText != null
      ? body.errorText
      : body.error != null
        ? body.error
        : body.error_text != null
          ? body.error_text
          : null;

  const st = String(status || '').toLowerCase();
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

  await query(
    `
    UPDATE vps_system.bot_instances
    SET status = COALESCE(NULLIF($2::text, ''), status),
        ea_status = COALESCE(NULLIF($3::text, ''), ea_status),
        mt5_balance = COALESCE($4::numeric, mt5_balance),
        mt5_equity = COALESCE($5::numeric, mt5_equity),
        profit = COALESCE($6::numeric, profit),
        last_error = CASE
          WHEN $7::text IS NOT NULL THEN NULLIF(TRIM($7::text), '')
          ELSE last_error
        END,
        last_agent_ping = NOW(),
        last_heartbeat = NOW(),
        updated_at = NOW()
    WHERE (
      ($1::bigint IS NOT NULL AND id = $1)
      OR (
        $1::bigint IS NULL
        AND $8::int IS NOT NULL
        AND assigned_port_no = $8
      )
    )
  `,
    [
      instanceId || null,
      status || null,
      eaStatus || null,
      balVal,
      eqVal,
      profitVal,
      errSql,
      port || null
    ]
  );

  if (accountId) {
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
  }

  if (port || instanceId) {
    await query(
      `
      UPDATE vps_system.mt5_accounts a
      SET last_balance = COALESCE($2::numeric, a.last_balance),
          last_equity = COALESCE($3::numeric, a.last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      FROM vps_system.bot_instances bi
      WHERE bi.mt5_account_id = a.id
        AND (
          ($1::bigint IS NOT NULL AND bi.id = $1)
          OR (
            $1::bigint IS NULL
            AND $4::int IS NOT NULL
            AND bi.assigned_port_no = $4
          )
        )
    `,
      [instanceId || null, balVal, eqVal, port || null]
    ).catch(() => {});
  }

  if (instanceId && eqVal != null) {
    await recordEquityLog(instanceId, eqVal).catch(() => {});
  }

  return { ok: true };
}

const { recordEquityLog: recordEquitySnapshot } = require('./mt5EquityChart');

async function recordEquityLog(instanceId, equity) {
  return recordEquitySnapshot(instanceId, equity);
}

module.exports = { applyMt5LiveStatus, positiveMoney, profitMoney, recordEquityLog };
