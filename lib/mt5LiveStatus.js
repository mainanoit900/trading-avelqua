'use strict';

const { query } = require('../config/database');
const {
  resolveLiveMetricsTarget,
  validateLiveMetricsTarget,
  resolveMetricsInstanceId
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

function clean(v) {
  return String(v || '').trim();
}

/**
 * อัปเดต bot_instances จาก Agent (run_bot / live heartbeat) — เฉพาะ instance เดียว
 */
async function applyMt5LiveStatus(body = {}) {
  const target = resolveLiveMetricsTarget(body);
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

  const metricsInstanceId = await resolveMetricsInstanceId(target, { query });
  if (!metricsInstanceId) {
    return { ok: true, skipped: true, reason: 'no_active_instance' };
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

  const stApply = String(statusToApply || '').trim().toLowerCase();
  const allowStoppedWrite = ['stopped', 'failed', 'error', 'trading_halted'].includes(stApply)
    || ['stopped', 'failed', 'error', 'trading_halted'].includes(String(eaToApply || '').trim().toLowerCase());

  await query(
    `
    UPDATE vps_system.bot_instances bi
    SET status = COALESCE(NULLIF($2::text, ''), bi.status),
        ea_status = COALESCE(NULLIF($3::text, ''), bi.ea_status),
        mt5_balance = COALESCE($4::numeric, bi.mt5_balance),
        mt5_equity = COALESCE($5::numeric, bi.mt5_equity),
        profit = COALESCE($6::numeric, bi.profit),
        last_error = CASE
          WHEN $7::text IS NOT NULL THEN NULLIF(TRIM($7::text), '')
          ELSE bi.last_error
        END,
        last_agent_ping = NOW(),
        last_heartbeat = NOW(),
        updated_at = NOW()
    WHERE bi.id = $1
      AND (
        $8::boolean = TRUE
        OR LOWER(TRIM(COALESCE(bi.status, ''))) NOT IN ('stopped', 'failed', 'deleted')
      )
      AND (
        $8::boolean = TRUE
        OR bi.stopped_at IS NULL
      )
  `,
    [
      metricsInstanceId,
      statusToApply,
      eaToApply,
      balVal,
      eqVal,
      profitVal,
      errSql,
      allowStoppedWrite
    ]
  );

  const accountId = Number(target.accountId || 0) || null;
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
    await query(
      `
      UPDATE vps_system.mt5_accounts a
      SET last_balance = COALESCE($2::numeric, a.last_balance),
          last_equity = COALESCE($3::numeric, a.last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      FROM vps_system.bot_instances bi
      WHERE bi.id = $1
        AND a.id = bi.mt5_account_id
    `,
      [metricsInstanceId, balVal, eqVal]
    ).catch(() => {});
  }

  if (metricsInstanceId && eqVal != null) {
    const { seedInstanceLiveMetrics } = require('./mt5EquityChart');
    await seedInstanceLiveMetrics(metricsInstanceId, balVal, eqVal).catch(() => {});
  }

  const stFinal = String(statusToApply || '').trim().toLowerCase();
  if (stFinal === 'running') {
    const acctId =
      Number(target.accountId || 0)
      || (
        await query(
          `SELECT mt5_account_id FROM vps_system.bot_instances WHERE id = $1 LIMIT 1`,
          [metricsInstanceId]
        ).catch(() => ({ rows: [] }))
      ).rows?.[0]?.mt5_account_id;
    if (acctId) {
      await query(
        `
        UPDATE vps_system.mt5_accounts
        SET status = 'connected',
            login_verified = TRUE,
            metrics_ready = TRUE,
            last_login_message = 'BOT กำลังรัน',
            last_error = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND LOWER(COALESCE(status, '')) IN ('connecting', 'checking', 'starting')
        `,
        [Number(acctId)]
      ).catch(() => {});
    }
    const instRow = await query(
      `SELECT run_payload FROM vps_system.bot_instances WHERE id = $1 LIMIT 1`,
      [metricsInstanceId]
    ).catch(() => ({ rows: [] }));
    let runPayload = instRow.rows?.[0]?.run_payload;
    if (typeof runPayload === 'string') {
      try {
        runPayload = JSON.parse(runPayload);
      } catch {
        runPayload = null;
      }
    }
    const attemptId = clean(runPayload?.attemptId);
    if (attemptId) {
      await query(
        `
        UPDATE vps_system.mt5_connect_attempts
        SET status = 'connected',
            terminal = TRUE,
            metrics_ready = TRUE,
            login_verified = TRUE,
            balance = COALESCE($2::numeric, balance),
            equity = COALESCE($3::numeric, equity),
            last_message = 'Phase 2: BOT กำลังรัน',
            finished_at = COALESCE(finished_at, NOW()),
            updated_at = NOW()
        WHERE attempt_id = $1
          AND LOWER(COALESCE(status, '')) NOT IN ('failed', 'cancelled', 'expired')
        `,
        [attemptId, balVal, eqVal]
      ).catch(() => {});
    }
  }

  return { ok: true, instanceId: metricsInstanceId };
}

const { recordEquityLog: recordEquitySnapshot } = require('./mt5EquityChart');

async function recordEquityLog(instanceId, equity) {
  return recordEquitySnapshot(instanceId, equity);
}

module.exports = { applyMt5LiveStatus, positiveMoney, profitMoney, recordEquityLog };
