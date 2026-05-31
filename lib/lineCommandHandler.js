'use strict';

const { pushText, replyMessage } = require('../services/lineService');
const {
  getSubscriber,
  setPendingAction,
  registerLineUser,
  isEmailText
} = require('./lineRegister');
const { buildPortfolioReport } = require('./linePortfolio');
const { buildDailyReportMessage } = require('./linePnlReport');

const REPORT_KEYS = new Set([
  'แจ้งสรุปผล',
  'รายงานผลงาน',
  'สรุปผล',
  'report',
  'action=report'
]);

const PORTFOLIO_KEYS = new Set([
  'เช็คพอร์ต',
  'ดูกำไร/ขาดทุน',
  'เช็คพอร์',
  'portfolio',
  'action=portfolio'
]);

const REGISTER_KEYS = new Set([
  'ลงทะเบียน',
  'สมัครใช้งาน',
  'register',
  'action=register'
]);

const HELP_KEYS = new Set([
  'วิธีใช้งาน',
  'อ่านก่อน',
  'help',
  'ช่วย',
  'ช่วยเหลือ',
  'คำสั่ง',
  'action=help'
]);

function normalizeKey(text) {
  return String(text || '').trim().toLowerCase();
}

function matchKey(text, keys) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  if (keys.has(raw) || keys.has(lower)) return true;
  const registerMatch = lower.match(/^(?:register|ลงทะเบียน)\s+(\S+@\S+\.\S+)$/i);
  return !!registerMatch;
}

function manualText() {
  return [
    '📌 วิธีใช้งาน Avelqua Trading',
    '━'.repeat(18),
    '',
    '1️⃣ สมัครสมาชิกและยืนยันตัวตน',
    '→ สมัครที่ trading.avelqua.com',
    '→ ยืนยัน Email ที่ใช้สมัคร',
    '',
    '2️⃣ เปิดรับการแจ้งเตือนผลเทรด',
    '→ กดปุ่ม "แจ้งสรุปผล" ในเมนู',
    '→ แจ้ง Email ที่ลงทะเบียนไว้',
    '→ ระบบจะผูกบัญชีกับ LINE ของคุณ',
    '✅ จากนั้นจะได้รับสรุปผล อัตโนมัติ',
    '    ทุกวัน เวลา 07:00 น.',
    '    (เฉพาะวันจันทร์–ศุกร์)',
    '    ครอบคลุมทุก Port ที่เปิดใช้งาน',
    '',
    '3️⃣ เช็คพอร์ตและกำไร/ขาดทุน',
    '→ กดปุ่ม "เช็คพอร์ต" ในเมนู',
    '→ ระบบแสดงทุก Port ที่ใช้งานอยู่',
    '→ พร้อมยอดกำไร/ขาดทุน ณ ขณะนั้น',
    '→ และสถานะบอทของแต่ละ Port',
    '',
    '━'.repeat(18),
    '💬 พิมพ์ "ช่วยเหลือ" เพื่อดูเมนูนี้อีกครั้ง'
  ].join('\n');
}

async function send(lineUserId, replyToken, text) {
  if (replyToken) {
    await replyMessage(replyToken, { type: 'text', text }).catch(() =>
      pushText(lineUserId, text)
    );
  } else {
    await pushText(lineUserId, text);
  }
}

async function askForEmail(lineUserId, replyToken, reason = 'report') {
  await setPendingAction(lineUserId, 'await_email');
  const intro =
    reason === 'register'
      ? '📝 ลงทะเบียนใช้งาน LINE Notify'
      : '📊 แจ้งสรุปผลการเทรด';
  await send(
    lineUserId,
    replyToken,
    [
      intro,
      '─'.repeat(28),
      'กรุณาระบุ Email ที่ลงทะเบียนไว้กับ Avelqua',
      '(Email ที่ใช้สมัครเว็บ trading.avelqua.com)',
      '',
      'ตัวอย่าง: yourname@gmail.com'
    ].join('\n')
  );
}

async function confirmRegistration(lineUserId, replyToken, email) {
  await send(
    lineUserId,
    replyToken,
    [
      '✅ ลงทะเบียนสำเร็จ!',
      `Email: ${email}`,
      '',
      '🌅 จะได้รับสรุปกำไร/ขาดทุนทุกวัน',
      '   เวลา 07:00 น. (จันทร์–ศุกร์)',
      '   ของทุกพอร์ตที่เปิดใช้งาน',
      '',
      'กด "เช็คพอร์ต" เพื่อดูผลล่าสุดได้ทันที'
    ].join('\n')
  );
}

async function handleReportSummary(lineUserId, replyToken) {
  const sub = await getSubscriber(lineUserId);
  if (sub?.verified && sub?.subscribed && sub?.user_id) {
    const preview = await buildDailyReportMessage(sub.user_id);
    if (preview) {
      await send(
        lineUserId,
        replyToken,
        [
          '✅ คุณลงทะเบียนแจ้งสรุปผลแล้ว',
          `Email: ${sub.email || '-'}`,
          '',
          '🌅 ระบบจะส่งสรุปอัตโนมัติทุกวัน 07:00 น.',
          '   (จันทร์–ศุกร์)',
          '',
          '📋 ตัวอย่างสรุปล่าสุด:',
          preview
        ].join('\n')
      );
      return;
    }
    await send(
      lineUserId,
      replyToken,
      '✅ ลงทะเบียนแล้ว แต่ยังไม่มีพอร์ตที่เปิดใช้งาน\nกรุณา Login MT5 ที่เว็บก่อน'
    );
    return;
  }

  if (sub?.verified && !sub?.subscribed) {
    await queryResubscribe(lineUserId);
    await confirmRegistration(lineUserId, replyToken, sub.email);
    return;
  }

  await askForEmail(lineUserId, replyToken, 'report');
}

async function queryResubscribe(lineUserId) {
  const { query } = require('../config/database');
  await query(
    `UPDATE line_subscribers SET subscribed = TRUE, pending_action = NULL, updated_at = NOW() WHERE line_user_id = $1`,
    [lineUserId]
  ).catch(() => {});
}

async function handlePortfolioCheck(lineUserId, replyToken) {
  const sub = await getSubscriber(lineUserId);
  if (!sub?.verified || !sub?.user_id) {
    await send(
      lineUserId,
      replyToken,
      '⚠️ กรุณาลงทะเบียนก่อน\nกดปุ่ม "แจ้งสรุปผล" หรือ "ลงทะเบียน" แล้วระบุ Email'
    );
    return;
  }
  const msg = await buildPortfolioReport(sub.user_id);
  await send(lineUserId, replyToken, msg);
}

async function handleEmailInput(lineUserId, email, replyToken) {
  const result = await registerLineUser(lineUserId, email);
  if (!result.ok) {
    if (result.error === 'email_not_found') {
      await send(
        lineUserId,
        replyToken,
        [
          `❌ ไม่พบ Email: ${result.email}`,
          'กรุณาใช้ Email ที่สมัครเว็บ Avelqua',
          'แล้วลองใหม่อีกครั้ง'
        ].join('\n')
      );
      return;
    }
    await send(lineUserId, replyToken, '❌ Email ไม่ถูกต้อง กรุณาลองใหม่');
    return;
  }
  await confirmRegistration(lineUserId, replyToken, result.email);
}

async function handleLineInput(lineUserId, text, replyToken = null) {
  const raw = String(text || '').trim();
  if (!raw) return;

  const lower = normalizeKey(raw);

  // register email@... inline
  const inlineRegister = raw.match(/^(?:register|ลงทะเบียน)\s+(\S+@\S+\.\S+)$/i);
  if (inlineRegister) {
    await handleEmailInput(lineUserId, inlineRegister[1], replyToken);
    return;
  }

  // plain email when awaiting or anytime
  const emailOnly = isEmailText(raw);
  const sub = await getSubscriber(lineUserId);
  if (emailOnly && (!sub?.verified || sub?.pending_action === 'await_email')) {
    await handleEmailInput(lineUserId, emailOnly, replyToken);
    return;
  }

  if (HELP_KEYS.has(raw) || HELP_KEYS.has(lower)) {
    await send(lineUserId, replyToken, manualText());
    return;
  }

  if (REGISTER_KEYS.has(raw) || REGISTER_KEYS.has(lower)) {
    if (sub?.verified && sub?.user_id) {
      await send(
        lineUserId,
        replyToken,
        `✅ ลงทะเบียนแล้ว\nEmail: ${sub.email || '-'}\n\nกด "เช็คพอร์ต" เพื่อดูผลล่าสุด`
      );
      return;
    }
    await askForEmail(lineUserId, replyToken, 'register');
    return;
  }

  if (REPORT_KEYS.has(raw) || REPORT_KEYS.has(lower)) {
    await handleReportSummary(lineUserId, replyToken);
    return;
  }

  if (PORTFOLIO_KEYS.has(raw) || PORTFOLIO_KEYS.has(lower)) {
    await handlePortfolioCheck(lineUserId, replyToken);
    return;
  }

  if (sub?.pending_action === 'await_email' && emailOnly) {
    await handleEmailInput(lineUserId, emailOnly, replyToken);
    return;
  }

  if (!sub?.verified) {
    await send(
      lineUserId,
      replyToken,
      '⚠️ กรุณากดปุ่ม "แจ้งสรุปผล" หรือ "ลงทะเบียน" แล้วระบุ Email ที่สมัครเว็บ'
    );
    return;
  }

  // legacy text commands
  await handleLegacyCommand(lineUserId, sub.user_id, lower, replyToken);
}

async function handleLegacyCommand(lineUserId, userId, cmd, replyToken) {
  const { query } = require('../config/database');
  const { fetchUserAccounts, formatAccountSummary, fmtMoney } = require('./linePnlReport');

  if (cmd === 'unsubscribe' || cmd === 'ยกเลิก' || cmd === 'ยกเลิกแจ้งเตือน') {
    await query(
      `UPDATE line_subscribers SET subscribed = FALSE, updated_at = NOW() WHERE line_user_id = $1`,
      [lineUserId]
    ).catch(() => {});
    await send(lineUserId, replyToken, '✅ ยกเลิกการแจ้งเตือนแล้ว\nกด "แจ้งสรุปผล" อีกครั้งเพื่อเปิดใหม่');
    return;
  }

  if (cmd === 'สถานะ' || cmd === 'status') {
    const accounts = await fetchUserAccounts(userId);
    await send(lineUserId, replyToken, formatAccountSummary(accounts));
    return;
  }

  if (cmd === 'กำไร' || cmd === 'สรุป' || cmd === 'pnl') {
    await handlePortfolioCheck(lineUserId, replyToken);
    return;
  }

  if (cmd === 'บอท' || cmd === 'bot') {
    const msg = await buildPortfolioReport(userId);
    await send(lineUserId, replyToken, msg);
    return;
  }

  const loginMatch = cmd.match(/^(?:login|ล็อกอิน)\s*(\d+)$/);
  if (loginMatch) {
    const r = await query(
      `
      SELECT mt5_login, last_balance, last_equity, status, server_name, port_slot
      FROM vps_system.mt5_accounts
      WHERE user_id = $1 AND TRIM(COALESCE(mt5_login,'')) = $2
        AND LOWER(TRIM(COALESCE(status,''))) NOT IN ('deleted','expired')
      LIMIT 1
    `,
      [userId, loginMatch[1]]
    ).catch(() => ({ rows: [] }));
    const acc = r.rows?.[0];
    if (!acc) {
      await send(lineUserId, replyToken, `❌ ไม่พบ Login: ${loginMatch[1]}`);
      return;
    }
    const pnl = Number(acc.last_equity || 0) - Number(acc.last_balance || 0);
    await send(
      lineUserId,
      replyToken,
      [
        `📋 Login: ${acc.mt5_login}`,
        `P&L: ${fmtMoney(pnl)}`,
        `Status: ${acc.status}`,
        `PORT: ${acc.port_slot || '-'}`
      ].join('\n')
    );
    return;
  }

  await send(lineUserId, replyToken, manualText());
}

function postbackToText(data) {
  const d = String(data || '').trim();
  if (!d) return '';
  if (d.startsWith('action=')) return d;
  const map = {
    report: 'แจ้งสรุปผล',
    portfolio: 'เช็คพอร์ต',
    register: 'ลงทะเบียน',
    help: 'วิธีใช้งาน'
  };
  return map[d.toLowerCase()] || d;
}

module.exports = {
  handleLineInput,
  postbackToText,
  manualText,
  handlePortfolioCheck,
  handleReportSummary
};
