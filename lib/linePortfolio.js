'use strict';

const { query } = require('../config/database');
const { fmtMoney, num } = require('./linePnlReport');

const ACTIVE_BOT_SQL = `'running','pending','restarting','connecting','starting'`;

async function fetchActivePorts(userId) {
  const r = await query(
    `
    SELECT id, mt5_login, account_name, last_balance, last_equity,
           status, server_name, port_slot, assigned_port_no
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
      AND (port_slot IS NOT NULL OR assigned_port_no IS NOT NULL OR NULLIF(TRIM(COALESCE(mt5_login, '')), '') IS NOT NULL)
    ORDER BY port_slot ASC NULLS LAST, assigned_port_no ASC NULLS LAST, id ASC
  `,
    [userId]
  ).catch(() => ({ rows: [] }));
  return r.rows || [];
}

async function fetchBotsByAccount(userId) {
  const r = await query(
    `
    SELECT DISTINCT ON (bi.mt5_account_id)
           bi.mt5_account_id,
           bi.status,
           COALESCE(bc.display_name, bc.bot_name, bc.bot_code, bi.run_payload->>'botCode', 'BOT') AS bot_name
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
    WHERE bi.user_id = $1
      AND bi.stopped_at IS NULL
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_BOT_SQL})
    ORDER BY bi.mt5_account_id, bi.started_at DESC NULLS LAST, bi.id DESC
  `,
    [userId]
  ).catch(() => ({ rows: [] }));
  const map = new Map();
  for (const row of r.rows || []) {
    map.set(Number(row.mt5_account_id), row);
  }
  return map;
}

function botStatusLabel(bot) {
  if (!bot) return '⚪ บอทหยุด';
  const st = String(bot.status || '').toLowerCase();
  if (st === 'running') return `🟢 บอท ${bot.bot_name} — ใช้งานอยู่`;
  return `🟡 บอท ${bot.bot_name} — ${bot.status}`;
}

function mt5StatusLabel(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'running' || st === 'connected') return '🟢 MT5 เปิดอยู่';
  if (st === 'connecting' || st === 'starting') return '🟡 MT5 กำลังเชื่อมต่อ';
  return `⚪ MT5 ${status || 'พร้อม'}`;
}

async function buildPortfolioReport(userId) {
  const accounts = await fetchActivePorts(userId);
  if (!accounts.length) {
    return '❌ ยังไม่มีพอร์ตที่เปิดใช้งาน\nกรุณา Login MT5 ที่เว็บ Avelqua ก่อน';
  }

  const bots = await fetchBotsByAccount(userId);
  const nowStr = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  let totalPnl = 0;
  const lines = accounts.map((a) => {
    const bal = num(a.last_balance);
    const eq = num(a.last_equity);
    const pnl = eq - bal;
    totalPnl += pnl;
    const port = a.assigned_port_no || a.port_slot || '-';
    const bot = bots.get(Number(a.id));
    const pnlIcon = pnl >= 0 ? '🟢' : '🔴';
    return [
      `${pnlIcon} PORT ${port} | Login ${a.mt5_login || '-'}`,
      `   P&L: ${fmtMoney(pnl)} | Equity ${fmtMoney(eq).replace('+', '')}`,
      `   ${mt5StatusLabel(a.status)}`,
      `   ${botStatusLabel(bot)}`
    ].join('\n');
  });

  const totalIcon = totalPnl >= 0 ? '📈' : '📉';
  return [
    `💼 เช็คพอร์ต — ${nowStr}`,
    '─'.repeat(28),
    ...lines,
    '─'.repeat(28),
    `${totalIcon} รวม P&L: ${fmtMoney(totalPnl)}`
  ].join('\n\n');
}

module.exports = {
  fetchActivePorts,
  buildPortfolioReport
};
