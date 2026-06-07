'use strict';

const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const { sendMailSafe } = require('./mailService');
const { abortConnectForRemovedAccount } = require('../lib/vpsAgentCommandQueue');
const { fullUrl } = require('./aiSupportKnowledge');

function appBaseUrl() {
  return process.env.APP_BASE_URL || process.env.BASE_URL || 'https://trading.avelqua.com';
}

function buildVerifyUrl(token) {
  return `${appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function resendEmailVerification(user) {
  if (!user?.id || !user.email) {
    return { ok: false, message: 'ไม่พบบัญชีผู้ใช้' };
  }
  if (user.email_verified === true || user.email_verified === 't' || user.email_verified === 1) {
    return { ok: true, message: 'อีเมลยืนยันแล้ว สามารถเข้าสู่ระบบได้เลย', alreadyVerified: true };
  }
  if (String(user.provider || 'local') !== 'local' && String(user.provider) !== 'web') {
    return { ok: false, message: 'บัญชีนี้เข้าผ่าน Google/LINE ไม่ต้องยืนยันอีเมลแยก' };
  }

  const verifyToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await query(
    `UPDATE users SET verify_token = $1, verify_token_expires_at = $2, updated_at = NOW() WHERE id = $3`,
    [verifyToken, verifyExpiresAt, user.id]
  );

  await sendMailSafe({
    to: user.email,
    subject: 'ยืนยันอีเมลก่อนเข้าใช้งาน TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7">
        <h2>ยืนยันอีเมลของคุณ</h2>
        <p>กรุณากดลิงก์ด้านล่างเพื่อยืนยันอีเมล (อายุ 24 ชม.)</p>
        <p><a href="${buildVerifyUrl(verifyToken)}">ยืนยันอีเมล</a></p>
      </div>
    `
  });

  return {
    ok: true,
    message: `ส่งอีเมลยืนยันไปที่ ${user.email} แล้ว กรุณาตรวจสอบกล่องจดหมายและ Spam`
  };
}

async function resendIdentityOtp(user) {
  if (!user?.id) return { ok: false, message: 'ต้องเข้าสู่ระบบก่อน' };

  const identityRes = await query(
    `SELECT * FROM user_identity_verifications WHERE user_id = $1 LIMIT 1`,
    [user.id]
  );
  const row = identityRes.rows[0];
  if (!row?.verify_email) {
    return {
      ok: false,
      message: 'ยังไม่มีข้อมูลยืนยันตัวตน กรุณาไปกรอกที่ /app/identity ก่อน',
      link: fullUrl('/app/identity')
    };
  }

  const otpCode = generateOtpCode();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await query(
    `UPDATE user_identity_verifications
     SET otp_code = $2, otp_expires_at = $3, status = 'pending', updated_at = NOW()
     WHERE user_id = $1`,
    [user.id, otpCode, otpExpiresAt]
  );

  await sendMailSafe({
    to: row.verify_email,
    subject: 'รหัสยืนยันตัวตน TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif">
        <p>รหัส OTP ยืนยันตัวตนของคุณ: <strong>${otpCode}</strong></p>
        <p>อายุ 10 นาที — กรอกที่ ${fullUrl('/app/identity')}</p>
      </div>
    `
  });

  return {
    ok: true,
    message: `ส่ง OTP ใหม่ไปที่อีเมลยืนยันตัวตนแล้ว กรุณากรอกที่ ${fullUrl('/app/identity')}`,
    link: fullUrl('/app/identity')
  };
}

async function resetStuckMt5Account(user, accountId) {
  if (!user?.id) return { ok: false, message: 'ต้องเข้าสู่ระบบก่อน' };
  const id = Number(accountId);
  if (!id) return { ok: false, message: 'ระบุ accountId ไม่ถูกต้อง' };

  const accRes = await query(
    `SELECT id, status, vps_id, port_id, port_slot, assigned_port_no
     FROM vps_system.mt5_accounts
     WHERE id = $1 AND user_id = $2
       AND LOWER(TRIM(COALESCE(status,''))) NOT IN ('deleted')
     LIMIT 1`,
    [id, user.id]
  );
  const acc = accRes.rows[0];
  if (!acc) return { ok: false, message: 'ไม่พบบัญชี MT5 ของคุณ' };

  const status = String(acc.status || '').toLowerCase();
  const resettable = ['failed', 'connecting', 'checking', 'starting', 'cancelled'].includes(status);
  if (!resettable) {
    return {
      ok: false,
      message: `บัญชีอยู่สถานะ "${acc.status}" ไม่จำเป็นต้องรีเซ็ต — ลองเชื่อมต่อใหม่ที่ ${fullUrl('/app/mt5')}`
    };
  }

  await abortConnectForRemovedAccount(id, {
    vpsId: acc.vps_id || null,
    portId: acc.port_id || null,
    message: 'รีเซ็ตโดย AI Support เพื่อให้เชื่อมต่อใหม่'
  }).catch(() => {});

  await query(
    `UPDATE vps_system.mt5_accounts
     SET status = 'ready',
         last_error = NULL,
         last_login_message = NULL,
         connect_started_at = NULL,
         assigned_port_no = NULL,
         windows_port_no = NULL,
         vps_id = NULL,
         port_id = NULL,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, user.id]
  );

  return {
    ok: true,
    message: `รีเซ็ต PORT ${acc.port_slot || id} แล้ว กรุณาไป ${fullUrl('/app/mt5')} เชื่อมต่อใหม่ด้วย Login/Password ที่ถูกต้อง`,
    link: fullUrl('/app/mt5')
  };
}

async function performSupportAction(user, action, params = {}) {
  const name = String(action || '').trim().toLowerCase();

  switch (name) {
    case 'resend_email_verification':
      return resendEmailVerification(user);
    case 'resend_identity_otp':
      return resendIdentityOtp(user);
    case 'reset_stuck_mt5':
      return resetStuckMt5Account(user, params.accountId || params.account_id);
    default:
      return { ok: false, message: `ไม่รองรับ action: ${action}` };
  }
}

module.exports = {
  performSupportAction,
  resendEmailVerification,
  resendIdentityOtp,
  resetStuckMt5Account
};
