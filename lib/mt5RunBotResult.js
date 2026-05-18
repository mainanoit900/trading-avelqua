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

let botInstanceColumnsChecked = false;

/** ตรวจว่ามีคอลัมน์ run-bot แล้ว (ไม่ ALTER จาก app — ใช้ migration โดย postgres) */
async function ensureBotInstanceRunColumns() {
  if (botInstanceColumnsChecked) return;
  botInstanceColumnsChecked = true;
  try {
    const r = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'vps_system'
        AND table_name = 'bot_instances'
        AND column_name = 'lot'
      LIMIT 1
    `);
    if (!r.rows?.[0]) {
      console.warn(
        '[ensureBotInstanceRunColumns] column lot missing — run ALTER as postgres owner'
      );
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * อัปเดต bot_instances หลัง Agent callback run_bot / restart_ea
 */
async function applyRunBotCommandResult({ pl, result, ok, message }) {

  const instanceId = num(pl?.instanceId ?? pl?.instance_id ?? result?.instanceId ?? result?.instance_id);
  if (!instanceId) return;

  const balance = positiveMoney(result?.balance ?? result?.mt5_balance ?? result?.mt5Balance);
  const equity = positiveMoney(result?.equity ?? result?.mt5_equity ?? result?.mt5Equity);
  let profit = num(result?.profit);
  if (profit == null && balance != null && equity != null) {
    profit = Math.round((equity - balance) * 100) / 100;
  }

  const eaStatus = String(result?.eaStatus ?? result?.ea_status ?? '').trim();
  const errText = String(message || result?.message || result?.error || '').trim();

  if (ok) {
    const eaFinal = eaStatus || 'ready';
    await query(
      `
      UPDATE vps_system.bot_instances
      SET status = 'running',
          ea_status = COALESCE(NULLIF($2::text, ''), 'ready'),
          mt5_balance = COALESCE($3::numeric, mt5_balance),
          mt5_equity = COALESCE($4::numeric, mt5_equity),
          profit = COALESCE($5::numeric, profit),
          last_error = NULL,
          last_agent_ping = NOW(),
          last_heartbeat = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
      [instanceId, eaFinal, balance, equity, profit]
    ).catch(() => {});
  } else {
    const failMsg = errText || 'run_bot failed';
    await query(
      `
      UPDATE vps_system.bot_instances
      SET status = 'failed',
          ea_status = 'error',
          last_error = $2,
          last_agent_ping = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
      [instanceId, failMsg]
    ).catch(() => {});
  }

  const accountId = num(pl?.accountId ?? pl?.account_id);
  if (accountId && (balance != null || equity != null)) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET last_balance = COALESCE($2::numeric, last_balance),
          last_equity = COALESCE($3::numeric, last_equity),
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
      [accountId, balance, equity]
    ).catch(() => {});
  }
}

module.exports = {
  ensureBotInstanceRunColumns,
  applyRunBotCommandResult
};
