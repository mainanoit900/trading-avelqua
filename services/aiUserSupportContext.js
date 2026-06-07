'use strict';

const { query } = require('../config/database');
const { fullUrl } = require('./aiSupportKnowledge');

function maskEmail(email) {
  const e = String(email || '').trim();
  const at = e.indexOf('@');
  if (at < 2) return e ? '***' : '';
  return `${e.slice(0, 2)}***${e.slice(at)}`;
}

async function getCurrentSubscription(userId) {
  const result = await query(
    `SELECT s.*, p.name_th, p.name_en, p.group_name
     FROM user_subscriptions s
     LEFT JOIN packages p ON p.id = s.package_id
     WHERE s.user_id = $1
     ORDER BY COALESCE(s.end_at, s.created_at) DESC NULLS LAST, s.id DESC
     LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

async function getMt5Accounts(userId) {
  const result = await query(
    `SELECT id, mt5_login, server_name, status, port_slot, last_error, last_login_message,
            last_balance, last_equity, connect_started_at, updated_at
     FROM vps_system.mt5_accounts
     WHERE user_id = $1
       AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted')
     ORDER BY id DESC
     LIMIT 10`,
    [userId]
  ).catch(() => ({ rows: [] }));
  return (result.rows || []).map((row) => ({
    id: row.id,
    mt5Login: row.mt5_login,
    server: row.server_name,
    status: row.status,
    portSlot: row.port_slot,
    lastError: row.last_error || row.last_login_message || '',
    balance: row.last_balance,
    equity: row.last_equity,
    updatedAt: row.updated_at
  }));
}

async function getLineStatus(userId) {
  const result = await query(
    `SELECT verified, subscribed, email, updated_at
     FROM line_subscribers
     WHERE user_id = $1
     LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0];
  if (!row) {
    return { linked: false, subscribed: false, email: null };
  }
  return {
    linked: !!row.verified,
    subscribed: !!row.subscribed,
    email: maskEmail(row.email),
    updatedAt: row.updated_at
  };
}

async function getPendingPayment(userId) {
  const result = await query(
    `SELECT id, payment_status, final_amount, created_at
     FROM payments
     WHERE user_id = $1
       AND LOWER(COALESCE(payment_status, '')) IN ('pending', 'awaiting', 'processing')
     ORDER BY created_at DESC
     LIMIT 3`,
    [userId]
  ).catch(() => ({ rows: [] }));
  return result.rows || [];
}

async function getUserSupportContext(user) {
  if (!user?.id) {
    return {
      loggedIn: false,
      summary: 'ผู้ใช้ยังไม่ได้เข้าสู่ระบบ — ให้คำแนะนำทั่วไปและส่งลิงก์ /register /login'
    };
  }

  const [subscription, mt5Accounts, lineStatus, pendingPayments, identityRes] = await Promise.all([
    getCurrentSubscription(user.id),
    getMt5Accounts(user.id),
    getLineStatus(user.id),
    getPendingPayment(user.id),
    query(
      `SELECT status, otp_expires_at, verified_at
       FROM user_identity_verifications
       WHERE user_id = $1
       LIMIT 1`,
      [user.id]
    ).catch(() => ({ rows: [] }))
  ]);

  const identity = identityRes.rows[0] || null;
  const emailVerified = !!(user.email_verified === true || user.email_verified === 't' || user.email_verified === 1);
  const identityVerified = !!(
    user.identity_verified === true ||
    user.identity_verified === 't' ||
    user.identity_verified === 1
  );

  const pkgActive =
    subscription &&
    String(subscription.status || '').toLowerCase() === 'active' &&
    (!subscription.end_at || new Date(subscription.end_at).getTime() > Date.now());
  const pkgExpired = subscription?.end_at && new Date(subscription.end_at).getTime() < Date.now();

  const stuckMt5 = mt5Accounts.filter((a) =>
    ['connecting', 'checking', 'starting', 'failed'].includes(String(a.status || '').toLowerCase())
  );

  const blockers = [];
  if (!emailVerified) blockers.push('ยังไม่ยืนยันอีเมล — ตรวจกล่องจดหมายหรือขอส่งอีเมลยืนยันใหม่');
  if (!identityVerified) blockers.push('ยังไม่ยืนยันตัวตน — ไป /app/identity');
  if (!pkgActive || pkgExpired) blockers.push('ไม่มีแพ็กเกจ active — ไป /app/packages');
  if (stuckMt5.length) blockers.push(`MT5 ค้าง/ล้มเหลว ${stuckMt5.length} รายการ — ดูที่ /app/mt5`);

  return {
    loggedIn: true,
    userId: user.id,
    displayName: user.full_name || user.first_name || user.name || maskEmail(user.email),
    email: maskEmail(user.email),
    emailVerified,
    identityVerified,
    identityStatus: identity?.status || (identityVerified ? 'verified' : 'none'),
    otpExpired: identity?.otp_expires_at ? new Date(identity.otp_expires_at).getTime() < Date.now() : null,
    provider: user.provider || 'local',
    scoinBalance: Number(user.scoin_balance || 0),
    package: subscription
      ? {
          name: subscription.name_th || subscription.name_en || subscription.package_name,
          status: subscription.status,
          endAt: subscription.end_at,
          expired: !!pkgExpired
        }
      : null,
    mt5Accounts,
    stuckMt5,
    line: lineStatus,
    pendingPayments: pendingPayments.map((p) => ({
      id: p.id,
      status: p.payment_status,
      amount: p.final_amount
    })),
    blockers,
    helpfulLinks: {
      identity: fullUrl('/app/identity'),
      packages: fullUrl('/app/packages'),
      mt5: fullUrl('/app/mt5'),
      status: fullUrl('/app/status'),
      contact: fullUrl('/contact')
    },
    summary: [
      `เข้าสู่ระบบ: ${maskEmail(user.email)}`,
      emailVerified ? 'อีเมลยืนยันแล้ว' : 'อีเมลยังไม่ยืนยัน',
      identityVerified ? 'ยืนยันตัวตนแล้ว' : 'ยังไม่ยืนยันตัวตน',
      subscription ? `แพ็กเกจ: ${subscription.name_th || subscription.status}` : 'ไม่มีแพ็กเกจ',
      mt5Accounts.length ? `MT5 ${mt5Accounts.length} บัญชี` : 'ยังไม่มี MT5',
      lineStatus.linked ? 'LINE เชื่อมแล้ว' : 'LINE ยังไม่เชื่อม',
      blockers.length ? `ติดขัด: ${blockers.join(' | ')}` : 'ไม่พบตัวบล็อกหลัก'
    ].join(' · ')
  };
}

module.exports = {
  getUserSupportContext,
  maskEmail
};
