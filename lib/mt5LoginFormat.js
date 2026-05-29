'use strict';

/** แจ้งทันทีเมื่อเลข Login ไม่ขึ้นต้น 2 (จริง) หรือ 8 (ทดลอง) */
const MT5_LOGIN_USER_WRONG_MSG = 'User ผิด';

/** บัญชีจริง (เงินจริง): ขึ้นต้น 2 จำนวน 9 หลัก เช่น 201200244 */
const MT5_LOGIN_LIVE_RX = /^2\d{8}$/;
/** บัญชีทดลอง: ขึ้นต้น 8 จำนวน 8 หลัก เช่น 89610453 */
const MT5_LOGIN_DEMO_RX = /^8\d{7}$/;

const MT5_LOGIN_FORMAT_HINT =
  'เว็บตรวจรูปแบบเร็ว (จริง 2·9หลัก / ทดลอง 8·8หลัก) — รหัสผ่านยืนยันจาก MT5 บน VPS';

function normalizeMt5LoginInput(login) {
  return String(login || '')
    .trim()
    .replace(/\s/g, '');
}

function classifyMt5Login(login) {
  const s = normalizeMt5LoginInput(login);
  if (!s) return { type: null, ok: false };
  if (MT5_LOGIN_LIVE_RX.test(s)) return { type: 'live', ok: true };
  if (MT5_LOGIN_DEMO_RX.test(s)) return { type: 'demo', ok: true };
  return { type: 'invalid', ok: false };
}

/**
 * ตรวจรูปแบบ Login ก่อนส่ง VPS / อ่าน Journal — รูปแบบผิด = User ผิดทันที
 */
function validateMt5LoginFormat(login) {
  const normalized = normalizeMt5LoginInput(login);
  if (!normalized) {
    return { ok: false, normalized, type: null, message: 'กรุณากรอก Login MT5' };
  }
  if (!/^\d+$/.test(normalized)) {
    return {
      ok: false,
      normalized,
      type: 'invalid',
      message: MT5_LOGIN_USER_WRONG_MSG,
      hint: MT5_LOGIN_FORMAT_HINT
    };
  }
  const kind = classifyMt5Login(normalized);
  if (kind.ok) {
    return { ok: true, normalized, type: kind.type, message: '' };
  }
  return {
    ok: false,
    normalized,
    type: 'invalid',
    message: MT5_LOGIN_USER_WRONG_MSG,
    hint: MT5_LOGIN_FORMAT_HINT
  };
}

module.exports = {
  MT5_LOGIN_USER_WRONG_MSG,
  MT5_LOGIN_LIVE_RX,
  MT5_LOGIN_DEMO_RX,
  MT5_LOGIN_FORMAT_HINT,
  normalizeMt5LoginInput,
  classifyMt5Login,
  validateMt5LoginFormat
};
