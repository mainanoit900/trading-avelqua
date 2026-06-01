'use strict';

const { pushText, pushFlex, replyMessage } = require('../services/lineService');
const {
  getSubscriber,
  setPendingAction,
  registerLineUser,
  isEmailText
} = require('./lineRegister');
const { buildPortfolioFlex } = require('./linePortfolio');
const {
  buildManualFlex,
  buildEmailAskFlex,
  buildRegisterSuccessFlex,
  buildAlreadyRegisteredFlex,
  buildReportActiveFlex,
  buildErrorFlex,
  buildSimpleNoticeFlex
} = require('./lineFlexUi');

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

const PACKAGE_KEYS = new Set([
  'เช็คแพ็กเกจปัจจุบัน',
  'เช็คแพ็คเกจปัจจุบัน',
  'เช็คแพ็เกจปัจจุบัน',
  'แพ็กเกจปัจจุบัน',
  'แพ็คเกจปัจจุบัน',
  'แพ็เกจปัจจุบัน',
  'current package',
  'package',
  'action=package'
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
  return buildManualFlex().altText;
}

async function sendFlex(lineUserId, replyToken, altText, contents) {
  const msg = { type: 'flex', altText, contents };
  if (replyToken) {
    await replyMessage(replyToken, msg).catch(() => pushFlex(lineUserId, altText, contents));
  } else {
    await pushFlex(lineUserId, altText, contents);
  }
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
  const flex = buildEmailAskFlex(reason);
  await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
}

async function confirmRegistration(lineUserId, replyToken, email) {
  const flex = buildRegisterSuccessFlex(email);
  await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
}

async function handleReportSummary(lineUserId, replyToken) {
  const sub = await getSubscriber(lineUserId);
  if (sub?.verified && sub?.subscribed && sub?.user_id) {
    const flex = await buildReportActiveFlex(sub.email, sub.user_id);
    await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
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
    const flex = buildSimpleNoticeFlex(
      '⚠️ ยังไม่ได้ลงทะเบียน',
      '',
      'กดปุ่ม "แจ้งสรุปผล" หรือ "ลงทะเบียน" แล้วระบุ Email ที่สมัครเว็บ',
      { headerBg: '#8b6914' }
    );
    await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
    return;
  }
  const flex = await buildPortfolioFlex(sub.user_id);
  if (!flex) {
    const notice = buildSimpleNoticeFlex(
      '❌ ยังไม่มีพอร์ต',
      '',
      'กรุณา Login MT5 ที่เว็บ trading.avelqua.com ก่อน'
    );
    await sendFlex(lineUserId, replyToken, notice.altText, notice.contents);
    return;
  }
  await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
}

function formatThaiDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('th-TH', {
    timeZone: process.env.TZ || 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatRemainingTime(endAt) {
  const endMs = new Date(endAt).getTime();
  if (!Number.isFinite(endMs)) return '-';
  const ms = endMs - Date.now();
  if (ms <= 0) return 'หมดอายุแล้ว';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} วัน ${hours} ชั่วโมง ${minutes} นาที`;
  if (hours > 0) return `${hours} ชั่วโมง ${minutes} นาที`;
  return `${minutes} นาที`;
}

async function handleCurrentPackageCheck(lineUserId, replyToken) {
  const sub = await getSubscriber(lineUserId);
  if (!sub?.verified || !sub?.user_id) {
    const flex = buildSimpleNoticeFlex(
      '⚠️ ยังไม่ได้ลงทะเบียน',
      '',
      'กรุณากด "ลงทะเบียน" แล้วยืนยัน Email ที่สมัครเว็บก่อนเช็คแพ็กเกจ',
      { headerBg: '#8b6914' }
    );
    await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
    return;
  }

  const { query } = require('../config/database');
  const pkgRes = await query(
    `
    SELECT
      us.id AS subscription_id,
      us.status,
      us.package_name_snapshot,
      us.start_at,
      us.end_at,
      COALESCE(us.ports_max, p.ports_max, 0) AS ports_max,
      COALESCE(us.lot_min, p.lot_min, 0) AS lot_min,
      COALESCE(us.lot_max, p.lot_max, 0) AS lot_max,
      COALESCE(us.package_id, p.id) AS package_id,
      p.name_th,
      p.name_en,
      p.group_name,
      p.days
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id = $1
      AND LOWER(TRIM(COALESCE(us.status, ''))) = 'active'
      AND (us.end_at IS NULL OR us.end_at > NOW())
    ORDER BY us.end_at DESC NULLS LAST, us.id DESC
    LIMIT 1
  `,
    [sub.user_id]
  ).catch(() => ({ rows: [] }));

  const pkg = pkgRes.rows?.[0];
  if (!pkg) {
    const flex = buildSimpleNoticeFlex(
      '📦 แพ็กเกจปัจจุบัน',
      '',
      'ยังไม่มีแพ็กเกจที่ใช้งานอยู่ในขณะนี้ กรุณาต่ออายุที่ /app/packages',
      { headerBg: '#8b3a3a' }
    );
    await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
    return;
  }

  const packageName = String(pkg.package_name_snapshot || pkg.name_th || pkg.name_en || `Package #${pkg.package_id || '-'}`).trim();
  const lotMin = Number(pkg.lot_min || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lotMax = Number(pkg.lot_max || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const portMax = Number(pkg.ports_max || 0).toLocaleString('th-TH');
  const expiryText = formatThaiDateTime(pkg.end_at);
  const remainText = pkg.end_at ? formatRemainingTime(pkg.end_at) : 'ไม่กำหนด';

  const message = [
    `แพ็กเกจ: ${packageName}`,
    `สถานะ: active`,
    `สิทธิ์ Lot: ${lotMin} - ${lotMax}`,
    `สิทธิ์พอร์ตสูงสุด: ${portMax}`,
    `หมดอายุ: ${expiryText}`,
    `คงเหลือประมาณ: ${remainText}`
  ].join('\n');

  const flex = buildSimpleNoticeFlex('📦 แพ็กเกจปัจจุบัน', '', message, { headerBg: '#1f4f8a' });
  await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
}

async function handleEmailInput(lineUserId, email, replyToken) {
  const result = await registerLineUser(lineUserId, email);
  if (!result.ok) {
    if (result.error === 'email_not_found') {
      const flex = buildErrorFlex(
        '❌ ไม่พบ Email',
        `ไม่พบ ${result.email} ในระบบ\nกรุณาใช้ Email ที่สมัครเว็บ Avelqua แล้วลองใหม่`
      );
      await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
      return;
    }
    const flex = buildErrorFlex('❌ Email ไม่ถูกต้อง', 'กรุณาตรวจสอบรูปแบบ Email แล้วลองใหม่');
    await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
    return;
  }
  await confirmRegistration(lineUserId, replyToken, result.email);
}

async function handleLineInput(lineUserId, text, replyToken = null) {
  const raw = String(text || '').trim();
  if (!raw) return;

  const lower = normalizeKey(raw);
  const sub = await getSubscriber(lineUserId);

  // register email@... inline
  const inlineRegister = raw.match(/^(?:register|ลงทะเบียน)\s+(\S+@\S+\.\S+)$/i);
  if (inlineRegister) {
    await handleEmailInput(lineUserId, inlineRegister[1], replyToken);
    return;
  }

  // plain email when awaiting or anytime
  const emailOnly = isEmailText(raw);
  if (emailOnly && sub?.pending_action === 'await_email') {
    await handleEmailInput(lineUserId, emailOnly, replyToken);
    return;
  }

  if (
    HELP_KEYS.has(raw) ||
    HELP_KEYS.has(lower) ||
    raw.includes('วิธีใช้งาน') ||
    raw.includes('ช่วยเหลือ')
  ) {
    const flex = buildManualFlex();
    await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
    return;
  }

  if (REGISTER_KEYS.has(raw) || REGISTER_KEYS.has(lower) || raw.includes('ลงทะเบียน')) {
    if (sub?.verified && sub?.user_id) {
      const flex = buildAlreadyRegisteredFlex(sub.email);
      await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
      return;
    }
    await askForEmail(lineUserId, replyToken, 'register');
    return;
  }

  if (REPORT_KEYS.has(raw) || REPORT_KEYS.has(lower) || raw.includes('แจ้งสรุปผล')) {
    await handleReportSummary(lineUserId, replyToken);
    return;
  }

  if (PORTFOLIO_KEYS.has(raw) || PORTFOLIO_KEYS.has(lower) || raw.includes('เช็คพอร์ต')) {
    await handlePortfolioCheck(lineUserId, replyToken);
    return;
  }

  if (
    PACKAGE_KEYS.has(raw) ||
    PACKAGE_KEYS.has(lower) ||
    raw.includes('แพ็กเกจปัจจุบัน') ||
    raw.includes('แพ็คเกจปัจจุบัน') ||
    raw.includes('แพ็เกจปัจจุบัน')
  ) {
    await handleCurrentPackageCheck(lineUserId, replyToken);
    return;
  }
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
    await handlePortfolioCheck(lineUserId, replyToken);
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

  const flex = buildManualFlex();
  await sendFlex(lineUserId, replyToken, flex.altText, flex.contents);
}

function postbackToText(data) {
  const d = String(data || '').trim();
  if (!d) return '';
  if (d.startsWith('action=')) return d;
  const map = {
    report: 'แจ้งสรุปผล',
    portfolio: 'เช็คพอร์ต',
    register: 'ลงทะเบียน',
    help: 'วิธีใช้งาน',
    package: 'เช็คแพ็กเกจปัจจุบัน'
  };
  return map[d.toLowerCase()] || d;
}

module.exports = {
  handleLineInput,
  postbackToText,
  manualText,
  handlePortfolioCheck,
  handleReportSummary,
  handleCurrentPackageCheck
};
