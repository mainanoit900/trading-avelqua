'use strict';

const { MT5_LOCKED_SERVER, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('./mt5Server');

/**
 * Parse MT5 Journal — ยืนยันเฉพาะ Server MohicansMarkets-Live
 * สำเร็จ: '12345': authorized on MohicansMarkets-Live through ...
 * ล้มเหลว: '12345': authorization on MohicansMarkets-Live failed ...
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

  const loginEsc = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const serverEsc = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const failRx = new RegExp(
    `(?:'|")?${loginEsc}(?:'|")?\\s*:\\s*authorization on\\s+${serverEsc}\\s+failed\\b`,
    'i'
  );
  const okRx = new RegExp(
    `(?:'|")?${loginEsc}(?:'|")?\\s*:\\s*authorized on\\s+${serverEsc}(?:\\s+through)?\\b`,
    'i'
  );

  const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const low = line.toLowerCase();
    if (!low.includes(login.toLowerCase())) continue;
    if (!low.includes(server.toLowerCase())) continue;

    if (failRx.test(line) || failedWords.some((w) => low.includes(w))) {
      return 'failed';
    }
    if (low.includes('authorization on') && low.includes('failed')) {
      return 'failed';
    }
    if (okRx.test(line)) {
      return 'success';
    }
  }
  return null;
}

/** ข้อความ/title/journal บ่งชี้ login ล้มเหลว (ใช้ใน connect-result + poll) */
function messageIndicatesLoginFailed(text, loginHint) {
  const blob = String(text || '');
  const low = blob.toLowerCase();
  if (!low.trim()) return false;

  const login = String(loginHint || '').trim();
  if (login) {
    const verdict = parseMt5JournalOutcome(blob, login);
    if (verdict === 'failed') return true;
    if (low.includes(login.toLowerCase())) {
      if (low.includes('authorization on') && low.includes('failed')) return true;
      if (/invalid\s+account|invalid\s+password|wrong\s+password/.test(low)) return true;
    }
  }

  return /authorization\s+on\b[\s\S]{0,120}\bfailed\b|authorization\s+failed|invalid\s+account|invalid\s+password|wrong\s+password|login\s+failed|not\s+authorized|account\s+disabled/i.test(
    low
  );
}

module.exports = {
  parseMt5JournalOutcome,
  messageIndicatesLoginFailed,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOCKED_SERVER
};
