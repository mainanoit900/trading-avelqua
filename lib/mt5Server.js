'use strict';

const { classifyMt5Login } = require('./mt5LoginFormat');

const MT5_LIVE_SERVER = process.env.MT5_DEFAULT_SERVER || 'MohicansMarkets-Live';
const MT5_DEMO_SERVER = process.env.MT5_DEMO_SERVER || 'MohicansMarkets-Demo';
/** @deprecated ใช้ MT5_LIVE_SERVER — คงชื่อเดิมให้โค้ดเก่า */
const MT5_LOCKED_SERVER = MT5_LIVE_SERVER;
const MT5_LOCKED_COMPANY = 'Mohicans Markets Ltd';
const MT5_SUCCESS_MSG = 'เชื่อมต่อสำเร็จ';
const MT5_EARLY_SUCCESS_MSG = 'เชื่อมต่อสำเร็จ — กำลังเปิดหน้าจอ MT5...';
const MT5_FAIL_USER_MSG = 'User หรือ รหัส ไม่ถูกต้อง';
const MT5_LOGIN_TIMEOUT_MSG =
  'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่อีกครั้ง';

const ALLOWED_SERVERS = new Set([MT5_LIVE_SERVER, MT5_DEMO_SERVER]);

/** Server สำหรับเชื่อมต่อ MT5 — โบรกเกอร์ใช้ MohicansMarkets-Live (ไม่สลับ Demo ตามเลข 8 หลัก) */
function resolveServerForLogin(mt5Login) {
  void mt5Login;
  void classifyMt5Login;
  if (String(process.env.MT5_AUTO_DEMO_SERVER || '0') === '1') {
    const kind = classifyMt5Login(mt5Login);
    if (kind.type === 'demo') return MT5_DEMO_SERVER;
  }
  return MT5_LIVE_SERVER;
}

function normalizeLockedServer(serverName, mt5Login) {
  if (mt5Login) return resolveServerForLogin(mt5Login);
  const s = String(serverName || '').trim();
  if (ALLOWED_SERVERS.has(s)) return s;
  return MT5_LIVE_SERVER;
}

module.exports = {
  MT5_LIVE_SERVER,
  MT5_DEMO_SERVER,
  MT5_LOCKED_SERVER,
  MT5_LOCKED_COMPANY,
  MT5_SUCCESS_MSG,
  MT5_EARLY_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOGIN_TIMEOUT_MSG,
  ALLOWED_SERVERS,
  resolveServerForLogin,
  normalizeLockedServer
};
