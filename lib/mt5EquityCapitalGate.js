'use strict';

const { query } = require('../config/database');

const ACTIVE_BOT_STATUS_SQL = `'running','pending','restarting','connecting','starting'`;

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function fmtMoney(v) {
  return num(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** รวม Equity ทุก login ที่เชื่อมต่อ + เงินทุนที่ BOT กำลังใช้อยู่ */
async function getUserEquityCapitalBudget(userId, { excludeAccountId = null } = {}) {
  const uid = num(userId);
  if (!uid) {
    return { totalEquity: 0, allocatedCapital: 0, remainingCapital: 0, activeBotCount: 0 };
  }

  const eqRow = await query(
    `
    SELECT COALESCE(SUM(
      GREATEST(
        COALESCE(NULLIF(a.last_equity, 0), NULLIF(a.last_balance, 0), 0),
        0
      )
    ), 0) AS total_equity
    FROM vps_system.mt5_accounts a
    WHERE a.user_id = $1
      AND LOWER(TRIM(COALESCE(a.status, ''))) IN ('connected', 'ready')
  `,
    [uid]
  ).catch(() => ({ rows: [{ total_equity: 0 }] }));

  const excludeId = num(excludeAccountId) || null;
  const allocRow = await query(
    `
    SELECT
      COALESCE(SUM(GREATEST(COALESCE(bi.capital_used, 0), 0)), 0) AS allocated,
      COUNT(*)::int AS active_count
    FROM vps_system.bot_instances bi
    WHERE bi.user_id = $1
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_BOT_STATUS_SQL})
      AND bi.stopped_at IS NULL
      AND COALESCE(bi.run_payload->>'userStopped', '') NOT IN ('true', '1', 'yes')
      AND ($2::bigint IS NULL OR bi.mt5_account_id IS DISTINCT FROM $2)
  `,
    [uid, excludeId]
  ).catch(() => ({ rows: [{ allocated: 0, active_count: 0 }] }));

  const totalEquity = num(eqRow.rows?.[0]?.total_equity);
  const allocatedCapital = num(allocRow.rows?.[0]?.allocated);
  const remainingCapital = Math.max(0, totalEquity - allocatedCapital);

  return {
    totalEquity,
    allocatedCapital,
    remainingCapital,
    activeBotCount: num(allocRow.rows?.[0]?.active_count)
  };
}

function validateEquityCapitalBudget(budget, requestCapital, { accountEquity = null } = {}) {
  const cap = num(requestCapital);
  const totalEquity = num(budget?.totalEquity);
  const allocated = num(budget?.allocatedCapital);
  const remaining = num(budget?.remainingCapital);
  const acctEq = num(accountEquity);

  if (cap <= 0) {
    return { ok: false, message: 'กรุณาระบุเงินทุน' };
  }

  if (acctEq > 0 && cap > acctEq + 0.0001) {
    return {
      ok: false,
      message: `เงินทุนเกิน Equity ของ Login นี้ (${fmtMoney(acctEq)} USD)`,
      code: 'account_equity_exceeded',
      totalEquity,
      allocatedCapital: allocated,
      remainingCapital: remaining
    };
  }

  if (totalEquity > 0 && cap > remaining + 0.0001) {
    return {
      ok: false,
      message:
        `เงินทุนรวมเกิน Equity ที่มี — ลงทุนแล้ว ${fmtMoney(allocated)} / ${fmtMoney(totalEquity)} USD ` +
        `เหลือลงทุนได้อีก ${fmtMoney(remaining)} USD`,
      code: 'total_equity_exceeded',
      totalEquity,
      allocatedCapital: allocated,
      remainingCapital: remaining
    };
  }

  return {
    ok: true,
    totalEquity,
    allocatedCapital: allocated,
    remainingCapital: remaining
  };
}

module.exports = {
  getUserEquityCapitalBudget,
  validateEquityCapitalBudget,
  fmtMoney
};
