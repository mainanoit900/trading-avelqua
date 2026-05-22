'use strict';

const {
  MT5_LOCKED_SERVER,
  MT5_SUCCESS_MSG,
  MT5_EARLY_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOGIN_TIMEOUT_MSG
} = require('./mt5Server');

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
      if (lineMs == null) continue;
      if (lineMs < since) continue;
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

/** title bar บ่งชี้ login ถูกต้อง (ไม่ใช่แค่มีเลข login ปนในข้อความ) */
function windowTitleConfirmsLogin(windowTitle, mt5Login) {
  const login = String(mt5Login || '').trim();
  const title = String(windowTitle || '').trim();
  if (!login || !title) return false;
  if (messageIndicatesLoginFailed(title, login, 0)) return false;
  const hasLogin = title.includes(login) || title.includes(`#${login}`);
  if (!hasLogin) return false;
  const low = title.toLowerCase();
  if (
    /invalid\s+account|invalid\s+password|wrong\s+password|authorization\s+failed|login\s+failed|access\s+denied/i.test(
      low
    )
  ) {
    return false;
  }
  return (
    /mohicans|markets-live|hedge|real account|demo account/i.test(low) ||
    (/\d{5,}/.test(title) && hasLogin)
  );
}

/**
 * แยกข้อความแจ้งผู้ใช้ — แสดง "User ผิด" เฉพาะเมื่อ Journal ยืนยัน authorization failed
 * timeout / ยืนยันไม่ทัน ไม่ถือเป็นรหัสผิด
 */
function resolveLoginFailUserMessage(opts = {}) {
  const login = String(opts.login || opts.mt5Login || '').trim();
  const sinceMs = Number(opts.sinceMs || 0);
  const evidence = String(opts.evidence || opts.journalEvidence || '').trim();
  const raw = String(opts.rawMessage || opts.message || opts.cmdError || opts.error || '').trim();

  if (evidence && login && parseMt5JournalOutcome(evidence, login, undefined, sinceMs) === 'failed') {
    return { message: MT5_FAIL_USER_MSG, authFail: true, journalVerdict: 'failed' };
  }

  const blob = [raw, evidence].filter(Boolean).join('\n');
  if (
    /authorization\s+failed|invalid\s+account|invalid\s+password|wrong\s+password|login\s+failed|not\s+authorized/i.test(
      blob
    ) &&
    (!login || blob.includes(login))
  ) {
    return { message: MT5_FAIL_USER_MSG, authFail: true, journalVerdict: 'failed' };
  }

  if (/ทันเวลา|timeout|ไม่สามารถยืนยัน\s*login/i.test(blob)) {
    return { message: MT5_LOGIN_TIMEOUT_MSG, authFail: false, journalVerdict: 'timeout' };
  }

  if (raw) {
    return { message: raw, authFail: false, journalVerdict: null };
  }

  return { message: MT5_LOGIN_TIMEOUT_MSG, authFail: false, journalVerdict: 'timeout' };
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
  windowTitleConfirmsLogin,
  messageIndicatesLoginFailed,
  MT5_SUCCESS_MSG,
  MT5_EARLY_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOGIN_TIMEOUT_MSG,
  resolveLoginFailUserMessage,
  MT5_LOCKED_SERVER
};
