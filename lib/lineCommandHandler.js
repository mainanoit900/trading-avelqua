'use strict';

const { query } = require('../config/database');
const { pushText } = require('../services/lineService');
const {
  fetchUserAccounts,
  formatAccountSummary,
  fmtMoney
} = require('./linePnlReport');

const ACTIVE_BOT_SQL = `'running','pending','restarting','connecting','starting'`;

async function getUserIdFromLine(lineUserId) {
  const r = await query(
    `
    SELECT user_id
    FROM line_subscribers
    WHERE line_user_id = $1
      AND verified = TRUE
      AND subscribed = TRUE
    LIMIT 1
  `,
    [lineUserId]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0]?.user_id || null;
}

async function fetchRunningBots(userId) {
  const r = await query(
    `
    SELECT bi.status, bi.port_used, bi.assigned_port_no, bi.capital_used,
           a.mt5_login,
           COALESCE(bc.display_name, bc.bot_name, bc.bot_code, bi.run_payload->>'botCode', 'BOT') AS bot_name
    FROM vps_system.bot_instances bi
    JOIN vps_system.mt5_accounts a ON a.id = bi.mt5_account_id
    LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
    WHERE bi.user_id = $1
      AND bi.stopped_at IS NULL
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_BOT_SQL})
    ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
  `,
    [userId]
  ).catch(() => ({ rows: [] }));
  return r.rows || [];
}

function helpText() {
  return [
    '📖 คำสั่งที่ใช้ได้:',
    '• register your@email.com — ลงทะเบียน',
    '• สถานะ / status — ดูบัญชีทั้งหมด',
    '• กำไร / สรุป / pnl — ดู P&L',
    '• บอท / bot — ดูบอทที่กำลังทำงาน',
    '• login XXXXXX — ดูรายละเอียด login',
    '• unsubscribe — ยกเลิกแจ้งเตือน'
  ].join('\n');
}

async function handleCommand(lineUserId, text) {
  const userId = await getUserIdFromLine(lineUserId);
  if (!userId) {
    await pushText(
      lineUserId,
      '⚠️ กรุณาลงทะเบียนก่อน\nพิมพ์: register your@email.com\n(ใช้ email เดียวกับที่สมัครเว็บ Avelqua)'
    );
    return;
  }

  const cmd = String(text || '').trim().toLowerCase();

  if (cmd === 'help' || cmd === 'ช่วย' || cmd === 'คำสั่ง') {
    await pushText(lineUserId, helpText());
    return;
  }

  if (cmd === 'unsubscribe' || cmd === 'ยกเลิก' || cmd === 'ยกเลิกแจ้งเตือน') {
    await query(
      `UPDATE line_subscribers SET subscribed = FALSE, updated_at = NOW() WHERE line_user_id = $1`,
      [lineUserId]
    ).catch(() => {});
    await pushText(lineUserId, '✅ ยกเลิกการแจ้งเตือนแล้ว\nพิมพ์ register อีกครั้งเพื่อเปิดใหม่');
    return;
  }

  if (cmd === 'สถานะ' || cmd === 'status') {
    const accounts = await fetchUserAccounts(userId);
    await pushText(lineUserId, formatAccountSummary(accounts));
    return;
  }

  if (cmd === 'กำไร' || cmd === 'สรุป' || cmd === 'pnl') {
    const accounts = await fetchUserAccounts(userId);
    await pushText(lineUserId, formatAccountSummary(accounts, { title: '📈 สรุป P&L' }));
    return;
  }

  if (cmd === 'บอท' || cmd === 'bot') {
    const bots = await fetchRunningBots(userId);
    if (!bots.length) {
      await pushText(lineUserId, '🤖 ไม่มีบอทที่กำลังทำงาน');
      return;
    }
    const msg = bots
      .map((b) => {
        const port = b.assigned_port_no || b.port_used || '-';
        const cap = b.capital_used != null ? ` | ทุน ${fmtMoney(b.capital_used).replace('+', '')}` : '';
        return `🤖 ${b.bot_name}\n   Login ${b.mt5_login} | Port ${port}${cap}\n   ${b.status}`;
      })
      .join('\n\n');
    await pushText(lineUserId, `🤖 บอทที่กำลังทำงาน\n${'─'.repeat(28)}\n${msg}`);
    return;
  }

  const loginMatch = cmd.match(/^(?:login|ล็อกอิน)\s*(\d+)$/);
  if (loginMatch) {
    const mt5Login = loginMatch[1];
    const r = await query(
      `
      SELECT id, mt5_login, account_name, last_balance, last_equity, status, server_name, port_slot
      FROM vps_system.mt5_accounts
      WHERE user_id = $1
        AND TRIM(COALESCE(mt5_login, '')) = $2
        AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
      LIMIT 1
    `,
      [userId, mt5Login]
    ).catch(() => ({ rows: [] }));
    const acc = r.rows?.[0];
    if (!acc) {
      await pushText(lineUserId, `❌ ไม่พบ Login: ${mt5Login}`);
      return;
    }
    const bal = Number(acc.last_balance || 0);
    const eq = Number(acc.last_equity || 0);
    const pnl = eq - bal;
    await pushText(
      lineUserId,
      [
        `📋 Login: ${acc.mt5_login}`,
        `Balance: ${fmtMoney(bal).replace('+', '')}`,
        `Equity:  ${fmtMoney(eq).replace('+', '')}`,
        `P&L:     ${fmtMoney(pnl)}`,
        `Status:  ${acc.status}`,
        `Server:  ${acc.server_name || 'MH Markets'}`,
        `PORT:    ${acc.port_slot || '-'}`
      ].join('\n')
    );
    return;
  }

  await pushText(lineUserId, helpText());
}

module.exports = { handleCommand, getUserIdFromLine, helpText };
