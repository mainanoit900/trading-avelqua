'use strict';

const { query } = require('../config/database');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function fmtMoney(v) {
  const n = num(v);
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function fetchUserAccounts(userId) {
  const r = await query(
    `
    SELECT id, mt5_login, account_name, last_balance, last_equity,
           status, server_name, port_slot, assigned_port_no
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    ORDER BY port_slot ASC NULLS LAST, id ASC
  `,
    [userId]
  ).catch(() => ({ rows: [] }));
  return r.rows || [];
}

async function getYesterdayEquity(userId, accountId) {
  const r = await query(
    `
    SELECT equity
    FROM daily_pnl_log
    WHERE user_id = $1
      AND account_id = $2
      AND snapshot_date = CURRENT_DATE - INTERVAL '1 day'
    LIMIT 1
  `,
    [userId, accountId]
  ).catch(() => ({ rows: [] }));
  const eq = num(r.rows?.[0]?.equity, NaN);
  return Number.isFinite(eq) ? eq : null;
}

function formatAccountSummary(accounts, { title = '📊 สรุปบัญชี MT5' } = {}) {
  if (!accounts.length) return '❌ ไม่พบบัญชี MT5';
  const lines = accounts.map((a) => {
    const bal = num(a.last_balance);
    const eq = num(a.last_equity);
    const pnl = eq - bal;
    const icon = pnl >= 0 ? '🟢' : '🔴';
    return [
      `${icon} Login: ${a.mt5_login || '-'}`,
      `   Balance: ${fmtMoney(bal).replace('+', '')}`,
      `   Equity:  ${fmtMoney(eq).replace('+', '')}`,
      `   P&L:     ${fmtMoney(pnl)}`,
      `   Status:  ${a.status || '-'}`
    ].join('\n');
  });
  return `${title}\n${'─'.repeat(28)}\n${lines.join('\n\n')}`;
}

async function buildDailyReportMessage(userId) {
  const { fetchActivePorts } = require('./linePortfolio');
  const accounts = await fetchActivePorts(userId);
  if (!accounts.length) return null;

  const dateStr = new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let totalBalance = 0;
  let totalEquity = 0;
  let totalPnlDay = 0;
  const lines = [];

  for (const a of accounts) {
    const bal = num(a.last_balance);
    const eq = num(a.last_equity);
    const yesterdayEq = await getYesterdayEquity(userId, a.id);
    const pnlDay = yesterdayEq != null ? eq - yesterdayEq : eq - bal;
    totalBalance += bal;
    totalEquity += eq;
    totalPnlDay += pnlDay;
    const icon = pnlDay >= 0 ? '🟢' : '🔴';
    lines.push(`${icon} ${a.mt5_login}: ${fmtMoney(pnlDay)}`);
  }

  const totalIcon = totalPnlDay >= 0 ? '📈' : '📉';
  return [
    `🌅 สรุปกำไร/ขาดทุน ${dateStr}`,
    '─'.repeat(28),
    ...lines,
    '─'.repeat(28),
    `${totalIcon} รวม P&L วันนี้: ${fmtMoney(totalPnlDay)}`,
    `💰 Balance รวม: ${fmtMoney(totalBalance).replace('+', '')}`,
    `📊 Equity รวม:  ${fmtMoney(totalEquity).replace('+', '')}`,
    '',
    'กด "เช็คพอร์ต" เพื่อดูรายละเอียด'
  ].join('\n');
}

async function saveDailySnapshots(userId, accounts) {
  for (const a of accounts || []) {
    const bal = num(a.last_balance);
    const eq = num(a.last_equity);
    const yesterdayEq = await getYesterdayEquity(userId, a.id);
    const pnlDay = yesterdayEq != null ? eq - yesterdayEq : eq - bal;
    await query(
      `
      INSERT INTO daily_pnl_log
        (user_id, account_id, mt5_login, snapshot_date, balance, equity, pnl_day)
      VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6)
      ON CONFLICT (user_id, account_id, snapshot_date)
      DO UPDATE SET
        mt5_login = EXCLUDED.mt5_login,
        balance = EXCLUDED.balance,
        equity = EXCLUDED.equity,
        pnl_day = EXCLUDED.pnl_day,
        created_at = NOW()
    `,
      [userId, a.id, a.mt5_login, bal, eq, pnlDay]
    ).catch(() => {});
  }
}

module.exports = {
  fetchUserAccounts,
  formatAccountSummary,
  buildDailyReportMessage,
  saveDailySnapshots,
  fmtMoney,
  num
};
