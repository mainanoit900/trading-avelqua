'use strict';

const { MT5_LOCKED_SERVER, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('./mt5Server');

function escapeRx(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse MT5 Journal — ยืนยันเฉพาะ Server MohicansMarkets-Live
 * สำเร็จ: authorized on / previous successful authorization
 * ล้มเหลว: authorization on ... failed (ต้องมี login + server ตรง)
 */
function parseMt5JournalOutcome(text, mt5Login, serverName) {
  const login = String(mt5Login || '').trim();
  const server = String(serverName || MT5_LOCKED_SERVER).trim();
  if (!login || !text || !server) return null;

  const failedWords = [
    'authorization failed',
    'failed (invalid account)',
    'failed [invalid account]',
    'invalid account',
    'invalid password',
    'wrong password',
    'login failed',
    'not authorized'
  ];

  const loginEsc = escapeRx(login);
  const serverEsc = escapeRx(server);
  const failRx = new RegExp(
    `(?:'|")?${loginEsc}(?:'|")?\\s*:\\s*authorization on\\s+${serverEsc}\\s+failed\\b`,
    'i'
  );
  const okRxAuthorized = new RegExp(
    `(?:'|")?${loginEsc}(?:'|")?\\s*:\\s*authorized on\\s+${serverEsc}(?:\\s+through)?\\b`,
    'i'
  );
  const okRxPrevious = new RegExp(
    `(?:'|")?${loginEsc}(?:'|")?\\s*:\\s*previous successful authorization`,
    'i'
  );

  // ใช้บรรทัดล่าสุดของ login นี้เท่านั้น (กัน journal เก่าของบัญชีอื่นบน PORT เดิม)
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const low = line.toLowerCase();
    if (!low.includes(login.toLowerCase())) continue;
    if (!low.includes(server.toLowerCase()) && !okRxPrevious.test(line)) continue;

    if (failRx.test(line) || failedWords.some((w) => low.includes(w))) {
      return 'failed';
    }
    if (low.includes('authorization on') && low.includes('failed')) {
      return 'failed';
    }
    if (okRxAuthorized.test(line) || okRxPrevious.test(line)) {
      return 'success';
    }
  }
  return null;
}

/** แจ้ง login ผิดเฉพาะเมื่อ journal มีหลักฐาน authorization failed ชัดเจน */
function messageIndicatesLoginFailed(text, mt5Login) {
  const blob = String(text || '').trim();
  const login = String(mt5Login || '').trim();
  if (!blob || !login) return false;

  if (/ทันเวลา|timeout|ไม่สามารถยืนยัน|กำลังเปิด|กำลังตรวจ|รอหน้าต่าง|previous successful authorization/i.test(blob)) {
    const verdictOnly = parseMt5JournalOutcome(blob, login);
    if (verdictOnly !== 'failed') return false;
  }

  return parseMt5JournalOutcome(blob, login) === 'failed';
}

function windowTitleIndicatesLoginSuccess(windowTitle, mt5Login) {
  const title = String(windowTitle || '').trim();
  const login = String(mt5Login || '').trim();
  if (!title || !login) return false;
  if (!(title.includes(login) || title.includes(`#${login}`))) return false;
  const low = title.toLowerCase();
  return (
    low.includes('mohicansmarkets-live') ||
    low.includes('mohicans markets') ||
    low.includes('demo account') ||
    low.includes('real account') ||
    low.includes('hedge')
  );
}

module.exports = {
  parseMt5JournalOutcome,
  messageIndicatesLoginFailed,
  windowTitleIndicatesLoginSuccess,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOCKED_SERVER
};
