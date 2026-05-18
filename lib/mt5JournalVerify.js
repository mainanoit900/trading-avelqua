'use strict';

const { MT5_LOCKED_SERVER, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('./mt5Server');

/** แปลงเวลาในบรรทัด Journal MT5: 2026.05.18 17:37:54.602 */
function parseMt5JournalLineTimeMs(line) {
  const m = String(line).match(
    /^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/
  );
  if (!m) return null;
  const ms = m[7] ? Number(String(m[7]).padEnd(3, '0').slice(0, 3)) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

/**
 * Parse MT5 Journal — ยืนยันเฉพาะ Server MohicansMarkets-Live
 * สำเร็จ: '12345': authorized on MohicansMarkets-Live through ...
 * ล้มเหลว: '12345': authorization on MohicansMarkets-Live failed ...
 * @param {number} [sinceMs] — ใช้เฉพาะบรรทัดหลังเวลาเริ่ม connect รอบนี้ (กัน journal รอบก่อน)
 */
function parseMt5JournalOutcome(text, mt5Login, serverName, sinceMs) {
  const login = String(mt5Login || '').trim();
  const server = String(serverName || MT5_LOCKED_SERVER).trim();
  if (!login || !text || !server) return null;

  const since = Number(sinceMs || 0) > 0 ? Number(sinceMs) - 5000 : 0;

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

    if (since > 0) {
      const lineMs = parseMt5JournalLineTimeMs(line);
      if (lineMs != null && lineMs < since) continue;
    }

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

/** ข้อความ/title/journal บ่งชี้ login ล้มเหลว — ต้องตรง login นี้เท่านั้น */
function messageIndicatesLoginFailed(text, loginHint, sinceMs) {
  const login = String(loginHint || '').trim();
  if (!login) return false;
  const blob = String(text || '');
  if (!blob.trim()) return false;
  return parseMt5JournalOutcome(blob, login, MT5_LOCKED_SERVER, sinceMs) === 'failed';
}

module.exports = {
  parseMt5JournalOutcome,
  parseMt5JournalLineTimeMs,
  messageIndicatesLoginFailed,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOCKED_SERVER
};
