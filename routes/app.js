const express = require('express');
const { requireLogin } = require('../middleware/requireAuth');
const { query, getClient } = require('../config/database');
const { sendMailSafe } = require('../services/mailService');
const bcrypt = require('bcryptjs');
const {
  createKbankPaymentForScoin,
  createKbankPaymentForPackage,
  verifyKbankWebhook,
  isMockMode
} = require('../services/kbankService');
const {
  ensureUserReferralCode,
  ensureUserWallet,
  findUserByWalletCode,
  getScoinSettings,
  transferScoinByWalletCode,
  markMarketOrderPaid,
  approveBuyOrderAndCredit,
  distributeScoinEconomy,
  debitScoin,
  lockScoinForOrder,
  finalizeSellLock,
  releaseSellLock
} = require('../services/scoinService');
const {
  buildFreeCouponPackageName,
  formatSubscriptionDisplayLabel,
  formatPackagePaymentDisplayLabel,
  formatSubscriptionSourceLabel,
  formatSubscriptionDateTime
} = require('../lib/subscriptionPackage');
const { isIdentityVerified, requireIdentityVerified } = require('../middleware/requireIdentity');
const { fetchCalendarPerformance, fetchMt5LoginPortfolio } = require('../lib/mt5CalendarPerformance');
const { fetchForecastForAccount } = require('../lib/mt5MarketForecast');
const { SNAPSHOT_INTERVAL_SEC: MT5_CALENDAR_REFRESH_SEC } = require('../lib/mt5EquityChart');

const router = express.Router();
router.use(requireLogin);
router.use(requireIdentityVerified);

function flash(req) {
  const out = { success: req.session.success || '', error: req.session.error || '' };
  req.session.success = '';
  req.session.error = '';
  return out;
}

/** Match admin/DB values: is_free flag and/or coupon_type (case-insensitive). */
function isFreePackageCoupon(coupon) {
  if (!coupon) return false;
  const isFreeFlag =
    coupon.is_free === true ||
    coupon.is_free === 't' ||
    coupon.is_free === 1 ||
    coupon.is_free === '1' ||
    String(coupon.is_free || '').toLowerCase() === 'true';
  const typeNorm = String(coupon.coupon_type || '').trim().toLowerCase();
  return isFreeFlag || typeNorm === 'free';
}

/** Free-coupon preview only (session). Returns error string or null on success. */
async function applyFreeCouponPreviewFromCode(req, base, payment, couponCode) {
  const code = String(couponCode || '').trim().toUpperCase();
  if (!code) return 'กรุณากรอกโค้ดคูปองฟรี';
  if (String(payment.payment_status || '').toLowerCase() !== 'pending') {
    return 'รายการนี้ไม่อยู่ในสถานะรอชำระ';
  }

  const couponRes = await query(
    `SELECT *
     FROM coupons
     WHERE UPPER(coupon_code) = $1
       AND is_active = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [code]
  );
  const coupon = couponRes.rows[0];
  if (!coupon) return 'คูปองไม่ถูกต้อง หรือหมดอายุแล้ว';

  const alreadyUsed = await query(
    `SELECT id
     FROM coupon_usages
     WHERE coupon_id = $1
       AND user_id = $2
     LIMIT 1`,
    [coupon.id, base.user.id]
  ).catch(() => ({ rows: [] }));

  if (alreadyUsed.rows.length > 0) {
    const lastUsed = await query(
      `SELECT
          cu.used_at AS created_at,
          COALESCE(NULLIF(TRIM(p.display_id), ''), NULLIF(TRIM(p.order_no), ''), p.id::text) AS payment_code
       FROM coupon_usages cu
       LEFT JOIN payments p
         ON p.id = cu.payment_id
       WHERE cu.coupon_id = $1
         AND cu.user_id = $2
       ORDER BY cu.used_at DESC
       LIMIT 1`,
      [coupon.id, base.user.id]
    ).catch(() => ({ rows: [] }));

    let usedMessage = 'คูปองนี้ถูกใช้งานแล้ว';
    if (lastUsed.rows.length > 0) {
      const used = lastUsed.rows[0];
      const usedDate = used.created_at
        ? new Date(used.created_at).toLocaleString('th-TH')
        : '-';
      usedMessage =
        `คูปองนี้ถูกใช้งานแล้ว เมื่อ ${usedDate}` +
        (used.payment_code ? ` อ้างอิง ${used.payment_code}` : '');
    }
    return usedMessage;
  }

  if (!isFreePackageCoupon(coupon)) {
    return 'คูปองนี้ไม่ใช่คูปองแพ็กเกจฟรี กรุณาใช้ช่องใส่โค้ดบนหน้านี้';
  }

  const freeDays = Number(coupon.free_days || 0);
  const freeGroup = String(coupon.free_package_group || '').trim().toUpperCase();
  if (freeDays <= 0) return 'คูปองฟรีนี้ยังไม่ได้กำหนดจำนวนวัน';
  if (!['BASIC', 'PRO', 'ADVANCED'].includes(freeGroup)) return 'คูปองฟรีนี้ยังไม่ได้กำหนดประเภทแพ็กเกจ';

  const activeSubRes = await query(
    `SELECT id
     FROM user_subscriptions
     WHERE user_id = $1
       AND status = 'active'
       AND (end_at IS NULL OR end_at > NOW())
     ORDER BY COALESCE(end_at, created_at) DESC NULLS LAST, id DESC
     LIMIT 1`,
    [base.user.id]
  ).catch(() => ({ rows: [] }));

  if (activeSubRes.rows[0]) {
    return 'คุณมีแพ็กเกจใช้อยู่ ไม่สามารถใช้แพ็กเกจฟรีได้';
  }

  if (Number(coupon.usage_limit || 0) > 0 && Number(coupon.used_count || 0) >= Number(coupon.usage_limit || 0)) {
    return 'คูปองฟรีนี้ถูกใช้ครบจำนวนแล้ว';
  }

  const freePkgRes = await query(
    `SELECT *
     FROM packages
     WHERE UPPER(group_name) = $1
       AND is_enabled = TRUE
     ORDER BY days ASC, price ASC, id ASC
     LIMIT 1`,
    [freeGroup]
  );
  const freePkg = freePkgRes.rows[0];
  if (!freePkg) return 'ไม่พบแพ็กเกจสำหรับคูปองฟรีนี้';

  req.session.freeCouponPreview = {
    paymentId: payment.id,
    displayId: payment.display_id || `PM${String(payment.id).padStart(6, '0')}`,
    couponId: coupon.id,
    couponCode: coupon.coupon_code,
    packageId: freePkg.id,
    packageName: buildFreeCouponPackageName(freeGroup, freeDays),
    packageGroup: freeGroup,
    freeDays,
    detail: coupon.description || coupon.print_note || coupon.coupon_name || 'คูปองแพ็กเกจฟรี',
    createdAt: Date.now()
  };

  return null;
}

/** Create pending free-coupon payment + session preview (packages page flow). */
async function finalizeFreeCouponFromPackagesPage(req, base, couponCode) {
  const code = String(couponCode || '').trim().toUpperCase();
  if (!code) return { error: 'กรุณากรอกโค้ดคูปองฟรี' };

  const activeSubRes = await query(
    `SELECT id FROM user_subscriptions WHERE user_id=$1 AND status='active' AND (end_at IS NULL OR end_at > NOW()) LIMIT 1`,
    [base.user.id]
  ).catch(() => ({ rows: [] }));
  if (activeSubRes.rows[0]) {
    return { error: 'คุณมีแพ็กเกจใช้อยู่ ไม่สามารถใช้แพ็กเกจฟรีได้' };
  }

  const couponRes = await query(
    `SELECT * FROM coupons WHERE UPPER(coupon_code)=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
    [code]
  );
  const coupon = couponRes.rows[0];
  if (!coupon || !isFreePackageCoupon(coupon)) {
    return { error: 'คูปองฟรีไม่ถูกต้อง หรือหมดอายุแล้ว' };
  }

  const alreadyUsed = await query(
    `SELECT id FROM coupon_usages WHERE coupon_id = $1 AND user_id = $2 LIMIT 1`,
    [coupon.id, base.user.id]
  ).catch(() => ({ rows: [] }));
  if (alreadyUsed.rows.length > 0) {
    const lastUsed = await query(
      `SELECT
          cu.used_at AS created_at,
          COALESCE(NULLIF(TRIM(p.display_id), ''), NULLIF(TRIM(p.order_no), ''), p.id::text) AS payment_code
       FROM coupon_usages cu
       LEFT JOIN payments p ON p.id = cu.payment_id
       WHERE cu.coupon_id = $1 AND cu.user_id = $2
       ORDER BY cu.used_at DESC
       LIMIT 1`,
      [coupon.id, base.user.id]
    ).catch(() => ({ rows: [] }));
    let usedMessage = 'คูปองนี้ถูกใช้งานแล้ว';
    if (lastUsed.rows.length > 0) {
      const used = lastUsed.rows[0];
      const usedDate = used.created_at ? new Date(used.created_at).toLocaleString('th-TH') : '-';
      usedMessage =
        `คูปองนี้ถูกใช้งานแล้ว เมื่อ ${usedDate}` +
        (used.payment_code ? ` อ้างอิง ${used.payment_code}` : '');
    }
    return { error: usedMessage };
  }

  const freeDays = Number(coupon.free_days || 0);
  const freeGroup = String(coupon.free_package_group || '').trim().toUpperCase();
  if (freeDays <= 0) return { error: 'คูปองฟรีนี้ยังไม่ได้กำหนดจำนวนวัน' };
  if (!['BASIC', 'PRO', 'ADVANCED'].includes(freeGroup)) {
    return { error: 'คูปองฟรีนี้ยังไม่ได้กำหนดประเภทแพ็กเกจ' };
  }
  if (Number(coupon.usage_limit || 0) > 0 && Number(coupon.used_count || 0) >= Number(coupon.usage_limit || 0)) {
    return { error: 'คูปองฟรีนี้ถูกใช้ครบจำนวนแล้ว' };
  }

  const freePkgRes = await query(
    `SELECT * FROM packages WHERE UPPER(group_name)=$1 AND is_enabled=TRUE ORDER BY days ASC, price ASC, id ASC LIMIT 1`,
    [freeGroup]
  );
  const freePkg = freePkgRes.rows[0];
  if (!freePkg) return { error: 'ไม่พบแพ็กเกจสำหรับคูปองฟรีนี้' };

  const packageName = buildFreeCouponPackageName(freeGroup, freeDays);
  const paymentRes = await query(
    `INSERT INTO payments (user_id, package_id, payer_name, payer_email, package_name_snapshot, amount, discount_amount, final_amount, currency_code, payment_method, payment_status, coupon_id, coupon_code_snapshot, raw_payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,0,0,0,'THB','free_coupon','pending',$6,$7,$8::jsonb,NOW(),NOW()) RETURNING id`,
    [
      base.user.id,
      freePkg.id,
      base.user.full_name || base.user.email || '',
      base.user.email || '',
      packageName,
      coupon.id,
      coupon.coupon_code,
      JSON.stringify({
        source: 'app_packages_free_coupon_box',
        coupon: { id: coupon.id, code: coupon.coupon_code, type: 'free', free_days: freeDays, free_package_group: freeGroup }
      })
    ]
  );
  const paymentId = paymentRes.rows[0].id;
  req.session.freeCouponPreview = {
    paymentId,
    displayId: `PM${String(paymentId).padStart(6, '0')}`,
    couponId: coupon.id,
    couponCode: coupon.coupon_code,
    packageId: freePkg.id,
    packageName,
    packageGroup: freeGroup,
    freeDays,
    detail: coupon.description || coupon.print_note || coupon.coupon_name || 'คูปองแพ็กเกจฟรี',
    createdAt: Date.now()
  };
  return { paymentId };
}

async function activatePackagePayment(paymentId, webhookPayload = {}) {
  const client = await getClient();
  let paymentRow = null;

  try {
    await client.query('BEGIN');
    const paymentRes = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    paymentRow = paymentRes.rows[0];
    if (!paymentRow) throw new Error('payment not found');

    if (String(paymentRow.payment_status || '') === 'paid') {
      await client.query('ROLLBACK');
      return paymentRow;
    }

    await client.query(
      `UPDATE payments
       SET payment_status='paid', paid_at=COALESCE(paid_at,NOW()), auto_confirmed_at=NOW(),
           auto_confirm_note='KBank webhook auto confirm', updated_at=NOW(),
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
       WHERE id=$1`,
      [paymentRow.id, JSON.stringify({ kbank_webhook: webhookPayload })]
    );

    if (paymentRow.package_id) {
      const pkgRes = await client.query(`SELECT * FROM packages WHERE id=$1 LIMIT 1`, [paymentRow.package_id]);
      const pkg = pkgRes.rows[0];
      if (pkg) {
        const subRes = await client.query(`SELECT * FROM user_subscriptions WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [paymentRow.user_id]);
        const oldSub = subRes.rows[0];
        const now = new Date();
        let startDate = now;
        let endDate = new Date();
        if (oldSub && oldSub.end_at && new Date(oldSub.end_at) > now) {
          startDate = new Date(oldSub.start_at || now);
          endDate = new Date(oldSub.end_at);
        }
        endDate.setDate(endDate.getDate() + Number(pkg.days || 0));
        if (oldSub) {
          await client.query(
            `UPDATE user_subscriptions
             SET package_id=$1,
                 package_name_snapshot=$2,
                 start_at=$3,
                 end_at=$4,
                 status='active',
                 updated_at=NOW()
             WHERE id=$5`,
            [pkg.id, pkg.name_th || pkg.name_en || pkg.name, startDate, endDate, oldSub.id]
          );
        } else {
          await client.query(
            `INSERT INTO user_subscriptions
             (user_id, package_id, package_name_snapshot, start_at, end_at, status, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'active',NOW(),NOW())`,
            [paymentRow.user_id, pkg.id, pkg.name_th || pkg.name_en || pkg.name, startDate, endDate]
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (paymentRow && paymentRow.package_id) {
    await distributeScoinEconomy({
      userId: paymentRow.user_id,
      paymentId: paymentRow.id,
      packageId: paymentRow.package_id,
      amountThb: Number(paymentRow.final_amount ?? paymentRow.amount ?? 0)
    });
  }
  return paymentRow;
}

async function activatePackageAfterPaid({ client, paymentRow }) {
  if (!paymentRow || !paymentRow.package_id) return null;
  const pkgRes = await client.query(`SELECT * FROM packages WHERE id=$1 LIMIT 1`, [paymentRow.package_id]);
  const pkg = pkgRes.rows[0];
  if (!pkg) return null;

  const subRes = await client.query(`SELECT * FROM user_subscriptions WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [paymentRow.user_id]);
  const oldSub = subRes.rows[0];
  const now = new Date();
  let startDate = now;
  let endDate = new Date();
  if (oldSub && oldSub.end_at && new Date(oldSub.end_at) > now) {
    startDate = new Date(oldSub.start_at || now);
    endDate = new Date(oldSub.end_at);
  }
  endDate.setDate(endDate.getDate() + Number(pkg.days || 0));

  if (oldSub) {
    await client.query(
      `UPDATE user_subscriptions
       SET package_id=$1,
           package_name_snapshot=$2,
           start_at=$3,
           end_at=$4,
           status='active',
           updated_at=NOW()
       WHERE id=$5`,
      [pkg.id, pkg.name_th || pkg.name_en || pkg.name, startDate, endDate, oldSub.id]
    );
  } else {
    await client.query(
      `INSERT INTO user_subscriptions
       (user_id, package_id, package_name_snapshot, start_at, end_at, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',NOW(),NOW())`,
      [paymentRow.user_id, pkg.id, pkg.name_th || pkg.name_en || pkg.name, startDate, endDate]
    );
  }
  return { package: pkg, startDate, endDate };
}

async function payPackageWithScoin({ userId, paymentId }) {
  const settings = await getScoinSettings();
  const scoinPriceThb = Number(settings.current_price_thb || 0);
  if (!settings.is_enabled) throw new Error('ระบบ Scoin ถูกปิดใช้งานชั่วคราว');
  if (!Number.isFinite(scoinPriceThb) || scoinPriceThb <= 0) throw new Error('ยังไม่ได้ตั้งราคา Scoin ตลาด');

  const client = await getClient();
  let paidPayment = null;
  let scoinRequired = 0;
  try {
    await client.query('BEGIN');
    const paymentRes = await client.query(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND package_id IS NOT NULL FOR UPDATE`, [paymentId, userId]);
    const payment = paymentRes.rows[0];
    if (!payment) throw new Error('ไม่พบรายการชำระเงิน');
    if (String(payment.payment_status || '').toLowerCase() !== 'pending') throw new Error('รายการนี้ไม่อยู่ในสถานะรอชำระ');
    if (payment.created_at && (Date.now() - new Date(payment.created_at).getTime()) > 20 * 60 * 1000) {
      await client.query(`UPDATE payments SET payment_status='cancelled', updated_at=NOW() WHERE id=$1`, [payment.id]);
      throw new Error('รายการนี้หมดอายุแล้ว');
    }

    const finalAmountThb = Number(payment.final_amount || payment.amount || 0);
    if (!Number.isFinite(finalAmountThb) || finalAmountThb <= 0) throw new Error('ยอดชำระไม่ถูกต้อง');
    scoinRequired = Number((finalAmountThb / scoinPriceThb).toFixed(4));

    const userRes = await client.query(`SELECT id, scoin_balance FROM users WHERE id=$1 FOR UPDATE`, [userId]);
    const user = userRes.rows[0];
    if (!user) throw new Error('ไม่พบผู้ใช้งาน');
    const beforeBalance = Number(user.scoin_balance || 0);
    if (beforeBalance < scoinRequired) throw new Error(`Scoin ไม่พอ ต้องใช้ ${scoinRequired.toLocaleString('th-TH')} Scoin`);

    await debitScoin({
      userId,
      amount: scoinRequired,
      txType: 'package_purchase_scoin',
      refPaymentId: payment.id,
      refPackageId: payment.package_id,
      idempotencyKey: `package-scoin-${payment.id}`,
      meta: {
        source: 'app_package_payment',
        final_amount_thb: finalAmountThb,
        scoin_price_thb: scoinPriceThb,
        note: 'ชำระแพ็กเกจด้วย Scoin อนุมัติทันที'
      }
    }, client);

    const paidRes = await client.query(`UPDATE payments SET payment_status='paid', payment_method='scoin', paid_at=NOW(), auto_confirmed_at=NOW(), auto_confirm_note='Scoin instant package payment', payment_ref=$2, raw_payload=COALESCE(raw_payload, '{}'::jsonb) || $3::jsonb, updated_at=NOW() WHERE id=$1 RETURNING *`, [payment.id, `SCOIN-PKG-${payment.id}-${Date.now()}`, JSON.stringify({ scoin_payment:{ scoin_amount:scoinRequired, scoin_price_thb:scoinPriceThb, final_amount_thb:finalAmountThb, instant_approved:true } })]);
    paidPayment = paidRes.rows[0];
    await activatePackageAfterPaid({ client, paymentRow: paidPayment });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (paidPayment) {
    await distributeScoinEconomy({ userId: paidPayment.user_id, paymentId: paidPayment.id, packageId: paidPayment.package_id, amountThb: Number(paidPayment.final_amount || paidPayment.amount || 0) });
  }
  return { payment: paidPayment, scoinRequired, scoinPriceThb };
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d]/g, '').trim();
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function appBaseUrl() {
  return process.env.APP_BASE_URL || process.env.BASE_URL || 'https://trading.avelqua.com';
}

async function sendIdentityOtpEmail({ email, fullName, code }) {
  const pageUrl = `${appBaseUrl()}/app/identity`;

  await sendMailSafe({
    to: email,
    subject: 'รหัสยืนยันตัวตน TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#e5eefc;background:#071120;padding:24px">
        <div style="max-width:640px;margin:0 auto;background:linear-gradient(180deg,#0b1730 0%,#08111f 100%);border:1px solid rgba(120,160,255,.18);border-radius:20px;padding:28px">
          <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7aa2ff;margin-bottom:8px">TRADING AVELQUA</div>
          <h2 style="margin:0 0 12px;color:#ffffff">ยืนยันตัวตน</h2>
          <p style="margin:0 0 16px;color:#d7e3ff">สวัสดี ${fullName || email}</p>
          <p style="margin:0 0 10px;color:#d7e3ff">รหัส OTP สำหรับยืนยันตัวตนของคุณคือ</p>
          <div style="display:inline-block;padding:14px 18px;border-radius:16px;background:linear-gradient(135deg,#3456ff 0%,#6d3dff 100%);color:#ffffff;font-size:34px;font-weight:800;letter-spacing:8px">
            ${code}
          </div>
          <p style="margin:18px 0 8px;color:#9fb4df">รหัสนี้มีอายุ 10 นาที</p>
          <p style="margin:0;color:#9fb4df">กลับไปกรอกรหัสได้ที่</p>
          <p style="margin:8px 0 0"><a href="${pageUrl}" style="color:#8cb6ff">${pageUrl}</a></p>
        </div>
      </div>
    `
  });
}

async function sendBankOtpEmail({ email, accountName, code }) {
  const pageUrl = `${appBaseUrl()}/app/bank-accounts`;

  await sendMailSafe({
    to: email,
    subject: 'รหัส OTP ยืนยันบัญชีรับเงิน TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#e5eefc;background:#071120;padding:24px">
        <div style="max-width:640px;margin:0 auto;background:linear-gradient(180deg,#0b1730 0%,#08111f 100%);border:1px solid rgba(120,160,255,.18);border-radius:20px;padding:28px">
          <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#7aa2ff;margin-bottom:8px">TRADING AVELQUA</div>
          <h2 style="margin:0 0 12px;color:#ffffff">ยืนยันบัญชีรับเงิน</h2>
          <p style="margin:0 0 16px;color:#d7e3ff">สวัสดี ${accountName || email}</p>
          <p style="margin:0 0 10px;color:#d7e3ff">รหัส OTP สำหรับยืนยันบัญชีรับเงินของคุณคือ</p>
          <div style="display:inline-block;padding:14px 18px;border-radius:16px;background:linear-gradient(135deg,#3456ff 0%,#6d3dff 100%);color:#ffffff;font-size:34px;font-weight:800;letter-spacing:8px">
            ${code}
          </div>
          <p style="margin:18px 0 8px;color:#9fb4df">รหัสนี้มีอายุ 10 นาที</p>
          <p style="margin:0;color:#9fb4df">กลับไปกรอกรหัสได้ที่</p>
          <p style="margin:8px 0 0"><a href="${pageUrl}" style="color:#8cb6ff">${pageUrl}</a></p>
        </div>
      </div>
    `
  });
}

function maskAccountNumber(accountNumber) {
  const raw = String(accountNumber || '').replace(/\s+/g, '');
  if (!raw) return '';
  if (raw.length <= 4) return raw;
  const last4 = raw.slice(-4);
  return `xxx-x-x${last4}-x`;
}

async function getCurrentSubscription(userId) {
  const result = await query(
    `SELECT s.*,
            p.name_th,
            p.name_en,
            p.group_name,
            p.days,
            pay.payment_method,
            c.free_days AS coupon_free_days,
            c.free_package_group AS coupon_free_package_group
     FROM user_subscriptions s
     LEFT JOIN packages p ON p.id = s.package_id
     LEFT JOIN payments pay ON pay.id = CASE
       WHEN s.source_channel ~ '^(free_coupon|payment):[0-9]+$'
         THEN NULLIF(regexp_replace(s.source_channel, '^(free_coupon|payment):', ''), '')::int
       ELSE NULL
     END
     LEFT JOIN coupon_usages cu ON cu.payment_id = pay.id AND cu.user_id = s.user_id
     LEFT JOIN coupons c ON c.id = cu.coupon_id
     WHERE s.user_id = $1
     ORDER BY COALESCE(s.end_at, s.created_at) DESC NULLS LAST, s.id DESC
     LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

function normalizePackageRow(row) {
  if (!row) return null;
  const lotMin = Number(row.lot_min || 0);
  const lotMax = Number(row.lot_max || 0);
  const portsMin = Number(row.ports_min || 0);
  const portsMax = Number(row.ports_max || 0);
  const profitMin = row.profit_min === null || row.profit_min === undefined ? null : Number(row.profit_min || 0);
  const profitMax = row.profit_max === null || row.profit_max === undefined ? null : Number(row.profit_max || 0);
  return {
    ...row,
    group_key: String(row.group_name || 'BASIC').toLowerCase(),
    lot_range: `${lotMin.toLocaleString('th-TH')} - ${lotMax.toLocaleString('th-TH')}`,
    port_range: `${portsMin.toLocaleString('th-TH')} - ${portsMax.toLocaleString('th-TH')}`,
    profit_range_th: row.profit_label_th || (profitMin !== null || profitMax !== null ? `${Number(profitMin || 0).toLocaleString('th-TH')}% - ${Number(profitMax || 0).toLocaleString('th-TH')}%` : '-'),
    profit_range_en: row.profit_label_en || (profitMin !== null || profitMax !== null ? `${Number(profitMin || 0).toLocaleString('en-US')}% - ${Number(profitMax || 0).toLocaleString('en-US')}%` : '-')
  };
}

async function getEnabledPackagesForApp() {
  const result = await query(
    `SELECT * FROM packages WHERE is_enabled = TRUE ORDER BY group_name ASC, sort_order ASC, days ASC, id ASC`
  ).catch(() => ({ rows: [] }));
  const packages = result.rows.map(normalizePackageRow).filter(Boolean);
  const groupedPackages = { basic: [], pro: [], advanced: [] };
  packages.forEach((pkg) => {
    const key = groupedPackages[pkg.group_key] ? pkg.group_key : 'basic';
    groupedPackages[key].push(pkg);
  });
  return { packages, groupedPackages };
}

async function getFreshUser(userId) {
  const result = await query(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));

  return result.rows[0] || null;
}

async function getBaseData(req) {
  const sessionUser = req.user || req.session.user;
  const freshUser = await getFreshUser(sessionUser.id);
  const user = freshUser || sessionUser;

  if (user) {
    req.session.user = user;
  }

  const subscription = await getCurrentSubscription(user.id);
  const appLang = req.lang || req.session?.lang || 'th';
  const currentPackageLabel = formatSubscriptionDisplayLabel(subscription);
  const subscriptionSourceLabel = formatSubscriptionSourceLabel(subscription, appLang);
  const subscriptionStartAt = formatSubscriptionDateTime(subscription?.start_at, appLang);
  const subscriptionEndAt = formatSubscriptionDateTime(subscription?.end_at, appLang);
  const brokerAccountsRes = await query(
    `SELECT * FROM user_broker_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.id]
  ).catch(() => ({ rows: [] }));
  const sessionsRes = await query(
    `SELECT bs.*, uba.broker_name, uba.account_login, vn.node_name
     FROM bot_sessions bs
     LEFT JOIN user_broker_accounts uba ON uba.id = bs.broker_account_id
     LEFT JOIN vps_nodes vn ON vn.id = bs.node_id
     WHERE bs.user_id = $1
     ORDER BY bs.created_at DESC`,
    [user.id]
  ).catch(() => ({ rows: [] }));

  const identityRes = await query(
    `SELECT *
     FROM user_identity_verifications
     WHERE user_id = $1
     LIMIT 1`,
    [user.id]
  ).catch(() => ({ rows: [] }));

  const referralCode = await ensureUserReferralCode(user.id);
  const wallet = await ensureUserWallet(user.id);
  const scoinSettings = await getScoinSettings();
  const scoinBalance = Number(user.scoin_balance || 0);
  const scoinLockedBalance = Number(user.scoin_locked_balance || 0);
  const scoinAvailableBalance = Math.max(0, +(scoinBalance - scoinLockedBalance).toFixed(4));
  const scoinValueThb = scoinAvailableBalance * Number(scoinSettings.current_price_thb || 0.10);

  return {
    user,
    subscription,
    currentPackageLabel,
    subscriptionSourceLabel,
    subscriptionStartAt,
    subscriptionEndAt,
    brokerAccounts: brokerAccountsRes.rows,
    botSessions: sessionsRes.rows,
    canChangePassword: ['web', 'local'].includes(String(user.provider || 'local')),
    identity: identityRes.rows[0] || null,
    referralCode,
    wallet,
    scoinSettings,
    scoinBalance,
    scoinLockedBalance,
    scoinAvailableBalance,
    scoinValueThb,
    referralUrl: `${appBaseUrl()}/register?ref=${encodeURIComponent(referralCode || '')}`
  };
}

router.get('/', async (req, res) => {
  const base = await getBaseData(req);

  if (isIdentityVerified(base.user) && String(req.query.showIdentityGate || '') === '1') {
    return res.redirect('/app');
  }

  const paymentsRes = await query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(final_amount),0)::numeric AS total_spent
     FROM payments WHERE user_id = $1 AND payment_status = 'paid'`,
    [base.user.id]
  ).catch(() => ({ rows: [{ total: 0, total_spent: 0 }] }));

  const mt5Portfolio = await fetchMt5LoginPortfolio(base.user.id).catch(() => ({
    ok: false,
    items: [],
    summary: {},
    refreshSec: MT5_CALENDAR_REFRESH_SEC
  }));

  return res.render('app/dashboard', {
    pageTitle: 'Customer Portal',
    pageCss: 'app-dashboard.css',
    currentPath: '/app',
    showIdentityGate: !isIdentityVerified(base.user),
    mt5BrokerAccounts: mt5Portfolio.items || [],
    mt5BrokerSummary: mt5Portfolio.summary || {},
    brokerRefreshSec: mt5Portfolio.refreshSec || MT5_CALENDAR_REFRESH_SEC,
    ...flash(req),
    ...base,
    paymentSummary: paymentsRes.rows[0]
  });
});


router.get('/packages', async (req, res) => {
  if (req.query.clear_free_coupon === '1') {
    delete req.session.packagesFreeCouponPreview;
    return res.redirect('/app/packages');
  }
  if (String(req.query.clear_fc || '') === '1') {
    delete req.session.packagesFreeCouponPreview;
    return res.redirect('/app/packages');
  }

  const base = await getBaseData(req);
  const { packages, groupedPackages } = await getEnabledPackagesForApp();

  await query(`
    UPDATE payments
    SET payment_status = 'cancelled', updated_at = NOW()
    WHERE user_id = $1
      AND package_id IS NOT NULL
      AND payment_status = 'pending'
      AND created_at < NOW() - INTERVAL '20 minutes'
  `, [base.user.id]).catch(() => null);

  const page = Math.max(1, Number(req.query.page || 1));
  const limit = 10;
  const offset = (page - 1) * limit;

  const recentPaymentsRes = await query(
    `SELECT
       p.*,
       pk.group_name,
       pk.days AS package_days,
       c.free_days AS coupon_free_days,
       c.free_package_group AS coupon_free_package_group,
       COALESCE(st.scoin_paid_amount, NULLIF(p.raw_payload->'scoin_payment'->>'scoin_amount', '')::numeric) AS scoin_paid_amount,
       COALESCE(st.scoin_paid_price, NULLIF(p.raw_payload->'scoin_payment'->>'scoin_price_thb', '')::numeric) AS scoin_paid_price
     FROM payments p
     LEFT JOIN packages pk ON pk.id = p.package_id
     LEFT JOIN coupons c ON c.id = p.coupon_id
     LEFT JOIN LATERAL (
       SELECT
         ABS(stx.amount)::numeric AS scoin_paid_amount,
         NULLIF(stx.meta_json->>'scoin_price_thb', '')::numeric AS scoin_paid_price
       FROM scoin_transactions stx
       WHERE stx.ref_payment_id = p.id
         AND stx.tx_type = 'package_purchase_scoin'
       ORDER BY stx.created_at DESC, stx.id DESC
       LIMIT 1
     ) st ON TRUE
     WHERE p.user_id = $1 AND p.package_id IS NOT NULL
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT $2 OFFSET $3`,
    [base.user.id, limit, offset]
  ).catch(() => ({ rows: [] }));

  const countRes = await query(
    `SELECT COUNT(*)::int AS total
     FROM payments
     WHERE user_id = $1 AND package_id IS NOT NULL`,
    [base.user.id]
  ).catch(() => ({ rows: [{ total: 0 }] }));

  const totalPages = Math.max(1, Math.ceil(Number(countRes.rows[0].total || 0) / limit));

  return res.render('app/packages', {
    pageTitle: 'ซื้อแพ็กเกจ',
    currentPath: '/app/packages',
    pageCss: '/css/app-packages.css',
    ...flash(req),
    ...base,
    packages,
    groupedPackages,
    recentPackagePayments: recentPaymentsRes.rows.map((p) => ({
      ...p,
      display_package_label: formatPackagePaymentDisplayLabel(p)
    })),
    paymentPage: page,
    paymentTotalPages: totalPages,
    packagesFreeCouponPreview: req.session.packagesFreeCouponPreview || null
  });
});

router.post('/packages/free-coupon', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const couponCode = String(req.body.coupon_code || '').trim().toUpperCase();

    if (!couponCode) {
      req.session.error = 'กรุณากรอกโค้ดคูปองฟรี';
      return res.redirect('/app/packages');
    }

    const couponRes = await query(`
      SELECT *
      FROM coupons
      WHERE UPPER(coupon_code) = $1
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1
    `, [couponCode]);

    const coupon = couponRes.rows[0];

    if (!coupon || !isFreePackageCoupon(coupon)) {
      req.session.error = 'คูปองฟรีไม่ถูกต้อง หรือหมดอายุแล้ว';
      return res.redirect('/app/packages');
    }

    const alreadyUsed = await query(`
      SELECT id, used_at
      FROM coupon_usages
      WHERE coupon_id = $1 AND user_id = $2
      ORDER BY used_at DESC
      LIMIT 1
    `, [coupon.id, base.user.id]);

    if (alreadyUsed.rows.length) {
      req.session.error = 'คูปองฟรีนี้ถูกใช้งานแล้ว';
      return res.redirect('/app/packages');
    }

    req.session.packagesFreeCouponPreview = {
      couponId: coupon.id,
      couponCode: coupon.coupon_code,
      couponName: coupon.coupon_name || coupon.description || 'คูปองฟรี',
      couponType: 'ฟรี',
      packageGroup: String(coupon.free_package_group || '').toUpperCase(),
      freeDays: Number(coupon.free_days || 0)
    };

    return res.redirect('/app/packages');
  } catch (error) {
    console.error('packages free coupon preview error:', error);
    req.session.error = 'ตรวจสอบคูปองฟรีไม่สำเร็จ';
    return res.redirect('/app/packages');
  }
});

router.post('/packages/free-coupon/confirm', async (req, res) => {
  const client = await getClient();

  try {
    const base = await getBaseData(req);
    const preview = req.session.packagesFreeCouponPreview;

    const couponCode = String(req.body.coupon_code || preview?.couponCode || '')
      .trim()
      .toUpperCase();

    if (!couponCode) {
      req.session.error = 'ไม่พบรหัสคูปองฟรี';
      return res.redirect('/app/packages');
    }

    await client.query('BEGIN');

    const couponRes = await client.query(
      `SELECT *
       FROM coupons
       WHERE UPPER(coupon_code) = $1
         AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1
       FOR UPDATE`,
      [couponCode]
    );

    const coupon = couponRes.rows[0];

    if (!coupon || !isFreePackageCoupon(coupon)) {
      await client.query('ROLLBACK');
      req.session.error = 'คูปองฟรีไม่ถูกต้อง หรือหมดอายุแล้ว';
      return res.redirect('/app/packages');
    }

    const usedRes = await client.query(
      `SELECT id, used_at
       FROM coupon_usages
       WHERE coupon_id = $1
         AND user_id = $2
       ORDER BY used_at DESC
       LIMIT 1`,
      [coupon.id, base.user.id]
    );

    if (usedRes.rows.length > 0) {
      await client.query('ROLLBACK');
      req.session.error = 'คูปองฟรีนี้ถูกใช้งานแล้ว';
      return res.redirect('/app/packages');
    }

    if (Number(coupon.usage_limit || 0) > 0 && Number(coupon.used_count || 0) >= Number(coupon.usage_limit || 0)) {
      await client.query('ROLLBACK');
      req.session.error = 'คูปองฟรีนี้ถูกใช้ครบจำนวนแล้ว';
      return res.redirect('/app/packages');
    }

    const freeDays = Number(coupon.free_days || 0);
    const freeGroup = String(coupon.free_package_group || '').trim().toUpperCase();

    if (freeDays <= 0 || !freeGroup) {
      await client.query('ROLLBACK');
      req.session.error = 'คูปองฟรีนี้ยังไม่ได้กำหนดจำนวนวันหรือระดับแพ็กเกจ';
      return res.redirect('/app/packages');
    }

    const pkgRes = await client.query(
      `SELECT *
       FROM packages
       WHERE UPPER(group_name) = $1
         AND is_enabled = TRUE
       ORDER BY days ASC, price ASC, id ASC
       LIMIT 1`,
      [freeGroup]
    );

    const pkg = pkgRes.rows[0];

    if (!pkg) {
      await client.query('ROLLBACK');
      req.session.error = 'ไม่พบแพ็กเกจสำหรับคูปองฟรีนี้';
      return res.redirect('/app/packages');
    }

    const packageName = buildFreeCouponPackageName(freeGroup, freeDays);
    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + freeDays * 24 * 60 * 60 * 1000);

    const paymentRes = await client.query(
      `INSERT INTO payments (
        user_id,
        package_id,
        payer_name,
        payer_email,
        package_name_snapshot,
        amount,
        discount_amount,
        final_amount,
        currency_code,
        payment_method,
        payment_status,
        paid_at,
        auto_confirmed_at,
        auto_confirm_note,
        payment_ref,
        coupon_id,
        coupon_code_snapshot,
        raw_payload,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,
        0,0,0,
        'THB',
        'free_coupon',
        'paid',
        NOW(),
        NOW(),
        'Free coupon confirmed from packages page',
        $6,
        $7,
        $8,
        $9::jsonb,
        NOW(),
        NOW()
      )
      RETURNING id`,
      [
        base.user.id,
        pkg.id,
        base.user.full_name || base.user.email || '',
        base.user.email || '',
        packageName,
        `FREE-${coupon.id}-${base.user.id}-${Date.now()}`,
        coupon.id,
        coupon.coupon_code,
        JSON.stringify({
          source: 'app_packages_free_coupon_confirm',
          coupon: {
            id: coupon.id,
            code: coupon.coupon_code,
            type: 'free',
            free_days: freeDays,
            free_package_group: freeGroup
          }
        })
      ]
    );

    const paymentId = paymentRes.rows[0].id;

    await client.query(
      `INSERT INTO user_subscriptions (
        user_id,
        package_id,
        package_name_snapshot,
        source_channel,
        status,
        start_at,
        end_at,
        lot_min,
        lot_max,
        ports_min,
        ports_max,
        profit_min,
        profit_max,
        profit_label,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())`,
      [
        base.user.id,
        pkg.id,
        packageName,
        `free_coupon:${paymentId}`,
        startAt,
        endAt,
        Number(pkg.lot_min || 0),
        Number(pkg.lot_max || 0),
        Number(pkg.ports_min || 0),
        Number(pkg.ports_max || 0),
        pkg.profit_min === null || pkg.profit_min === undefined ? null : Number(pkg.profit_min || 0),
        pkg.profit_max === null || pkg.profit_max === undefined ? null : Number(pkg.profit_max || 0),
        pkg.profit_label_th || pkg.profit_label_en || ''
      ]
    );

    await client.query(
      `INSERT INTO coupon_usages (
        coupon_id,
        user_id,
        payment_id,
        used_at,
        note
      )
      VALUES ($1,$2,$3,NOW(),$4)`,
      [
        coupon.id,
        base.user.id,
        paymentId,
        `free_coupon_confirmed:${packageName}:${freeDays}days`
      ]
    );

    await client.query(
      `UPDATE coupons
       SET used_count = COALESCE(used_count, 0) + 1,
           updated_at = NOW(),
           is_active = CASE
             WHEN usage_limit > 0
              AND COALESCE(used_count, 0) + 1 >= usage_limit
             THEN FALSE
             ELSE is_active
           END
       WHERE id = $1`,
      [coupon.id]
    );

    await client.query('COMMIT');

    delete req.session.packagesFreeCouponPreview;
    delete req.session.freeCouponPreview;

    req.session.success = `ใช้คูปองฟรีสำเร็จ เปิดใช้งาน ${packageName} ${freeDays} วันแล้ว`;
    return res.redirect('/app/packages');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    console.error('packages free coupon confirm direct error:', error);
    req.session.error = 'ยืนยันคูปองฟรีไม่สำเร็จ';
    return res.redirect('/app/packages');
  } finally {
    client.release();
  }
});

router.post('/packages/:id/buy', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const packageId = Number(req.params.id || 0);

    await query(`
      UPDATE payments
      SET payment_status = 'cancelled', updated_at = NOW()
      WHERE user_id = $1
        AND package_id IS NOT NULL
        AND payment_status = 'pending'
        AND created_at < NOW() - INTERVAL '20 minutes'
    `, [base.user.id]);

    const pkgRes = await query(
      `SELECT * FROM packages WHERE id = $1 AND is_enabled = TRUE LIMIT 1`,
      [packageId]
    );

    const pkg = pkgRes.rows[0];
    if (!pkg) {
      req.session.error = 'ไม่พบแพ็กเกจ หรือแพ็กเกจนี้ถูกปิดใช้งานแล้ว';
      return res.redirect('/app/packages');
    }

    const existingRes = await query(
      `SELECT id
       FROM payments
       WHERE user_id = $1
         AND package_id = $2
         AND payment_status = 'pending'
         AND created_at >= NOW() - INTERVAL '20 minutes'
       ORDER BY id DESC
       LIMIT 1`,
      [base.user.id, pkg.id]
    );

    if (existingRes.rows.length) {
      return res.redirect(`/app/package-payment/${existingRes.rows[0].id}`);
    }

    const packageName = pkg.name_th || pkg.name_en || `Package #${pkg.id}`;
    const price = Number(pkg.price || 0);

    const paymentRes = await query(
      `INSERT INTO payments (
        user_id, package_id, payer_name, payer_email, package_name_snapshot,
        amount, discount_amount, final_amount, currency_code, payment_method,
        payment_status, raw_payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,0,$6,'THB','kbank','pending',$7::jsonb,NOW(),NOW())
      RETURNING id`,
      [
        base.user.id,
        pkg.id,
        base.user.full_name || base.user.email || '',
        base.user.email || '',
        packageName,
        price,
        JSON.stringify({ source: 'app_packages_page', expires_in_minutes: 20, package_id: pkg.id })
      ]
    );

    return res.redirect(`/app/package-payment/${paymentRes.rows[0].id}`);
  } catch (error) {
    console.error('app package buy error:', error);
    req.session.error = 'ไม่สามารถสร้างรายการซื้อแพ็กเกจได้ กรุณาลองใหม่อีกครั้ง';
    return res.redirect('/app/packages');
  }
});

router.get('/package-payment/free', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const couponCode = String(
      req.query.coupon || req.session.freeCouponPreview?.couponCode || ''
    )
      .trim()
      .toUpperCase();
    if (!couponCode) {
      req.session.error = 'ไม่พบรหัสคูปองฟรี';
      delete req.session.freeCouponPreview;
      return res.redirect('/app/packages');
    }

    const result = await finalizeFreeCouponFromPackagesPage(req, base, couponCode);
    if (result.error) {
      req.session.error = result.error;
      delete req.session.freeCouponPreview;
      return res.redirect('/app/packages');
    }

    req.session.success = 'ตรวจสอบรายละเอียดคูปองฟรี แล้วกดยืนยันเพื่อเปิดใช้งานแพ็กเกจ';
    return res.redirect(`/app/package-payment/${result.paymentId}`);
  } catch (error) {
    console.error('package-payment/free error:', error);
    req.session.error = 'เปิดหน้าชำระเงินคูปองฟรีไม่สำเร็จ';
    delete req.session.freeCouponPreview;
    return res.redirect('/app/packages');
  }
});

router.get('/package-payment/:id', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const rawId = Number(req.params.id || 0);
    const couponFromQuery = String(req.query.coupon || '').trim().toUpperCase();

    let paymentRes = await query(
      `SELECT * FROM payments
       WHERE id = $1 AND user_id = $2 AND package_id IS NOT NULL
       LIMIT 1`,
      [rawId, base.user.id]
    );
    let payment = paymentRes.rows[0];

    if (!payment && couponFromQuery) {
      const pkgRes = await query(
        `SELECT * FROM packages WHERE id = $1 AND is_enabled = TRUE LIMIT 1`,
        [rawId]
      );
      const pkg = pkgRes.rows[0];
      if (pkg) {
        await query(
          `UPDATE payments
           SET payment_status = 'cancelled', updated_at = NOW()
           WHERE user_id = $1
             AND package_id IS NOT NULL
             AND payment_status = 'pending'
             AND created_at < NOW() - INTERVAL '20 minutes'`,
          [base.user.id]
        );

        const existingRes = await query(
          `SELECT id
           FROM payments
           WHERE user_id = $1
             AND package_id = $2
             AND payment_status = 'pending'
             AND created_at >= NOW() - INTERVAL '20 minutes'
           ORDER BY id DESC
           LIMIT 1`,
          [base.user.id, pkg.id]
        );

        let payId;
        if (existingRes.rows.length) {
          payId = existingRes.rows[0].id;
        } else {
          const packageName = pkg.name_th || pkg.name_en || `Package #${pkg.id}`;
          const price = Number(pkg.price || 0);
          const ins = await query(
            `INSERT INTO payments (
              user_id, package_id, payer_name, payer_email, package_name_snapshot,
              amount, discount_amount, final_amount, currency_code, payment_method,
              payment_status, raw_payload, created_at, updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,0,$6,'THB','kbank','pending',$7::jsonb,NOW(),NOW())
            RETURNING id`,
            [
              base.user.id,
              pkg.id,
              base.user.full_name || base.user.email || '',
              base.user.email || '',
              packageName,
              price,
              JSON.stringify({
                source: 'app_packages_free_coupon_modal',
                expires_in_minutes: 20,
                package_id: pkg.id
              })
            ]
          );
          payId = ins.rows[0].id;
        }
        paymentRes = await query(
          `SELECT * FROM payments
           WHERE id = $1 AND user_id = $2 AND package_id IS NOT NULL
           LIMIT 1`,
          [payId, base.user.id]
        );
        payment = paymentRes.rows[0];
      }
    }

    if (!payment) {
      req.session.error = 'ไม่พบรายการชำระเงิน';
      return res.redirect('/app/packages');
    }

    if (payment.payment_status === 'pending' && payment.created_at &&
        (Date.now() - new Date(payment.created_at).getTime()) > 20 * 60 * 1000) {
      await query(
        `UPDATE payments SET payment_status='cancelled', updated_at=NOW() WHERE id=$1`,
        [payment.id]
      );
      req.session.error = 'รายการนี้หมดอายุแล้ว';
      return res.redirect('/app/packages');
    }

    if (couponFromQuery) {
      const previewErr = await applyFreeCouponPreviewFromCode(req, base, payment, couponFromQuery);
      if (previewErr) req.session.error = previewErr;
      else req.session.success = 'ตรวจสอบรายละเอียดคูปองฟรี แล้วกดยืนยันเพื่อเปิดใช้งานแพ็กเกจ';
      return res.redirect(`/app/package-payment/${payment.id}`);
    }

    let kbankPayment = null;
    const freeCouponPreview = req.session.freeCouponPreview && Number(req.session.freeCouponPreview.paymentId) === Number(payment.id) ? req.session.freeCouponPreview : null;
    const scoinPriceThb = Number((base.scoinSettings && base.scoinSettings.current_price_thb) || 0);
    const packageFinalAmount = Number(payment.final_amount ?? payment.amount ?? 0);
    const packageScoinRequired = scoinPriceThb > 0 ? Number((packageFinalAmount / scoinPriceThb).toFixed(4)) : 0;
    const packageScoinPayment = {
      enabled: !!(base.scoinSettings && base.scoinSettings.is_enabled) && packageScoinRequired > 0,
      priceThb: scoinPriceThb,
      required: packageScoinRequired,
      balance: Number(base.scoinBalance || 0),
      enough: Number(base.scoinBalance || 0) >= packageScoinRequired
    };

    if (String(payment.payment_status || '') === 'pending' && !freeCouponPreview) {
      kbankPayment = await createKbankPaymentForPackage(payment);
      await query(
        `UPDATE payments SET payment_ref=$2, updated_at=NOW() WHERE id=$1`,
        [payment.id, kbankPayment.ref]
      ).catch(() => null);
    }

    return res.render('app/package-payment', {
      pageTitle: 'ชำระเงินแพ็กเกจ',
      currentPath: '/app/packages',
      ...flash(req),
      ...base,
      payment,
      freeCouponPreview,
      kbankPayment,
      packageScoinPayment,
      kbankMockMode: isMockMode()
    });
  } catch (error) {
    console.error('package payment page error:', error);
    req.session.error = 'เปิดหน้าชำระเงินไม่สำเร็จ';
    return res.redirect('/app/packages');
  }
});

router.post('/package-payment/:id/apply-coupon', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const paymentId = Number(req.params.id || 0);
    const couponCode = String(req.body.coupon_code || '').trim().toUpperCase();

    if (!couponCode) {
      req.session.error = 'กรุณากรอกโค้ดคูปอง';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const paymentRes = await query(
      `SELECT *
       FROM payments
       WHERE id = $1
         AND user_id = $2
         AND package_id IS NOT NULL
         AND payment_status = 'pending'
       LIMIT 1`,
      [paymentId, base.user.id]
    );

    const payment = paymentRes.rows[0];
    if (!payment) {
      req.session.error = 'ไม่พบรายการ หรือรายการนี้ใช้คูปองไม่ได้';
      return res.redirect('/app/packages');
    }

    const couponRes = await query(
      `SELECT *
       FROM coupons
       WHERE UPPER(coupon_code) = $1
         AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [couponCode]
    );

    const coupon = couponRes.rows[0];
    if (!coupon) {
      req.session.error = 'คูปองไม่ถูกต้อง หรือหมดอายุแล้ว';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const alreadyUsed = await query(
      `SELECT id
       FROM coupon_usages
       WHERE coupon_id = $1
         AND user_id = $2
       LIMIT 1`,
      [coupon.id, base.user.id]
    ).catch(() => ({ rows: [] }));

    if (alreadyUsed.rows.length > 0) {
      const lastUsed = await query(
        `SELECT
            cu.used_at AS created_at,
            COALESCE(NULLIF(TRIM(p.display_id), ''), NULLIF(TRIM(p.order_no), ''), p.id::text) AS payment_code
         FROM coupon_usages cu
         LEFT JOIN payments p
           ON p.id = cu.payment_id
         WHERE cu.coupon_id = $1
           AND cu.user_id = $2
         ORDER BY cu.used_at DESC
         LIMIT 1`,
        [coupon.id, base.user.id]
      ).catch(() => ({ rows: [] }));

      let usedMessage = 'คูปองนี้ถูกใช้งานแล้ว';

      if (lastUsed.rows.length > 0) {
        const used = lastUsed.rows[0];

        const usedDate = used.created_at
          ? new Date(used.created_at).toLocaleString('th-TH')
          : '-';

        usedMessage =
          `คูปองนี้ถูกใช้งานแล้ว เมื่อ ${usedDate}` +
          (used.payment_code
            ? ` อ้างอิง ${used.payment_code}`
            : '');
      }

      req.session.error = usedMessage;

      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const amount = Number(payment.amount || 0);
    let discountAmount = 0;
    let finalAmount = amount;

    if (isFreePackageCoupon(coupon)) {
      const previewErr = await applyFreeCouponPreviewFromCode(req, base, payment, coupon.coupon_code);
      if (previewErr) {
        req.session.error = previewErr;
        return res.redirect(`/app/package-payment/${paymentId}`);
      }
      req.session.success = 'ตรวจสอบรายละเอียดคูปองฟรี แล้วกดยืนยันเพื่อเปิดใช้งานแพ็กเกจ';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const discountPercent = Number(coupon.discount_percent || 0);
    const discountFixed = Number(coupon.discount_amount || 0);

    if (discountPercent > 0) {
      discountAmount = Math.min(amount, amount * discountPercent / 100);
    } else {
      discountAmount = Math.min(amount, discountFixed);
    }

    finalAmount = Math.max(0, amount - discountAmount);

    if (discountAmount <= 0) {
      req.session.error = 'คูปองนี้ไม่มีมูลค่าส่วนลด';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    await query(
      `UPDATE payments
       SET coupon_id = $1,
           coupon_code_snapshot = $2,
           discount_amount = $3,
           final_amount = $4,
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $5::jsonb,
           updated_at = NOW()
       WHERE id = $6`,
      [
        coupon.id,
        coupon.coupon_code,
        discountAmount,
        finalAmount,
        JSON.stringify({
          coupon: {
            id: coupon.id,
            code: coupon.coupon_code,
            type: coupon.coupon_type,
            is_free: coupon.is_free,
            discount_amount: Number(coupon.discount_amount || 0),
            discount_percent: Number(coupon.discount_percent || 0)
          }
        }),
        payment.id
      ]
    );

    if (finalAmount <= 0) {
      await activatePackagePayment(payment.id, {
        source: 'coupon_full_discount',
        coupon_code: coupon.coupon_code
      });

      await query(
        `UPDATE coupons
         SET used_count = COALESCE(used_count, 0) + 1,
             updated_at = NOW(),
             is_active = CASE
               WHEN usage_limit > 0 AND COALESCE(used_count, 0) + 1 >= usage_limit THEN FALSE
               ELSE is_active
             END
         WHERE id = $1`,
        [coupon.id]
      ).catch(() => null);

      await query(
        `INSERT INTO coupon_usages (coupon_id, user_id, payment_id, note)
         VALUES ($1, $2, $3, $4)`,
        [coupon.id, base.user.id, payment.id, 'discount_coupon_full_paid']
      ).catch(() => null);

      req.session.success = 'ใช้คูปองสำเร็จ ยอดชำระเป็น 0 บาท และเปิดใช้งานแพ็กเกจแล้ว';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    await query(
      `INSERT INTO coupon_usages (
         coupon_id,
         user_id,
         payment_id,
         note
       )
       VALUES ($1,$2,$3,$4)`,
      [coupon.id, base.user.id, payment.id, 'discount_coupon_used']
    ).catch(() => null);

    await query(
      `UPDATE coupons
       SET
         used_count = COALESCE(used_count,0) + 1,
         updated_at = NOW(),
         is_active = CASE
           WHEN usage_limit > 0
            AND COALESCE(used_count,0) + 1 >= usage_limit
           THEN FALSE
           ELSE is_active
         END
       WHERE id = $1`,
      [coupon.id]
    ).catch(() => null);

    req.session.success = 'ใช้คูปองส่วนลดสำเร็จ';
    return res.redirect(`/app/package-payment/${paymentId}`);
  } catch (error) {
    console.error('apply package coupon error:', error);
    req.session.error = 'ใช้คูปองไม่สำเร็จ';
    return res.redirect(`/app/package-payment/${req.params.id}`);
  }
});


router.post('/package-payment/:id/confirm-free-coupon', async (req, res) => {
  const paymentId = Number(req.params.id || 0);
  const client = await getClient();

  try {
    const base = await getBaseData(req);
    await client.query('BEGIN');

    const activeSubRes = await client.query(
      `SELECT id
       FROM user_subscriptions
       WHERE user_id = $1
         AND status = 'active'
         AND (end_at IS NULL OR end_at > NOW())
       ORDER BY COALESCE(end_at, created_at) DESC NULLS LAST, id DESC
       LIMIT 1
       FOR UPDATE`,
      [base.user.id]
    );

    if (activeSubRes.rows[0]) {
      await client.query('ROLLBACK');
      req.session.error = 'คุณมีแพ็กเกจใช้อยู่ ไม่สามารถใช้แพ็กเกจฟรีได้';
      delete req.session.freeCouponPreview;
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const paymentRes = await client.query(
      `SELECT *
       FROM payments
       WHERE id = $1
         AND user_id = $2
         AND package_id IS NOT NULL
         AND payment_status = 'pending'
       LIMIT 1
       FOR UPDATE`,
      [paymentId, base.user.id]
    );

    const payment = paymentRes.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      req.session.error = 'ไม่พบรายการ หรือรายการนี้ยืนยันคูปองฟรีไม่ได้';
      delete req.session.freeCouponPreview;
      return res.redirect('/app/packages');
    }

    const previewMatch =
      req.session.freeCouponPreview &&
      Number(req.session.freeCouponPreview.paymentId) === paymentId;
    const couponCode = String(
      req.body.coupon_code ||
        (previewMatch ? req.session.freeCouponPreview.couponCode : '') ||
        payment.coupon_code_snapshot ||
        ''
    )
      .trim()
      .toUpperCase();

    if (!couponCode) {
      await client.query('ROLLBACK');
      req.session.error = 'ไม่พบรหัสคูปองฟรี กรุณาเปิดหน้านี้จากขั้นตอนคูปองฟรีอีกครั้ง';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const couponRes = await client.query(
      `SELECT *
       FROM coupons
       WHERE UPPER(coupon_code) = $1
         AND is_active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1
       FOR UPDATE`,
      [couponCode]
    );

    const coupon = couponRes.rows[0];
    if (!coupon || !isFreePackageCoupon(coupon)) {
      await client.query('ROLLBACK');
      req.session.error = 'คูปองฟรีไม่ถูกต้อง หรือหมดอายุแล้ว';
      delete req.session.freeCouponPreview;
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    if (Number(coupon.usage_limit || 0) > 0 && Number(coupon.used_count || 0) >= Number(coupon.usage_limit || 0)) {
      await client.query('ROLLBACK');
      req.session.error = 'คูปองฟรีนี้ถูกใช้ครบจำนวนแล้ว';
      delete req.session.freeCouponPreview;
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const alreadyUsedRes = await client.query(
      `SELECT id, used_at
       FROM coupon_usages
       WHERE coupon_id = $1
         AND user_id = $2
       ORDER BY used_at DESC
       LIMIT 1`,
      [coupon.id, base.user.id]
    );

    if (alreadyUsedRes.rows.length > 0) {
      await client.query('ROLLBACK');

      const usedAt = alreadyUsedRes.rows[0].used_at
        ? new Date(alreadyUsedRes.rows[0].used_at).toLocaleString('th-TH')
        : '-';

      req.session.error = `คูปองฟรีนี้ถูกใช้งานแล้ว เมื่อ ${usedAt}`;
      delete req.session.freeCouponPreview;

      return res.redirect('/app/packages');
    }

    const freeDays = Number(coupon.free_days || 0);
    const freeGroup = String(coupon.free_package_group || '').trim().toUpperCase();
    if (freeDays <= 0 || !['BASIC', 'PRO', 'ADVANCED'].includes(freeGroup)) {
      await client.query('ROLLBACK');
      req.session.error = 'ข้อมูลคูปองฟรีไม่ครบถ้วน';
      delete req.session.freeCouponPreview;
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const freePkgRes = await client.query(
      `SELECT *
       FROM packages
       WHERE UPPER(group_name) = $1
         AND is_enabled = TRUE
       ORDER BY days ASC, price ASC, id ASC
       LIMIT 1`,
      [freeGroup]
    );
    const freePkg = freePkgRes.rows[0];
    if (!freePkg) {
      await client.query('ROLLBACK');
      req.session.error = 'ไม่พบแพ็กเกจสำหรับคูปองฟรีนี้';
      delete req.session.freeCouponPreview;
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + freeDays * 24 * 60 * 60 * 1000);
    const packageName = buildFreeCouponPackageName(freeGroup, freeDays);
    const paymentRef = `FREE-${payment.id}-${Date.now()}`;

    await client.query(
      `UPDATE payments
       SET package_id = $1,
           package_name_snapshot = $2,
           coupon_id = $3,
           coupon_code_snapshot = $4,
           discount_amount = amount,
           final_amount = 0,
           payment_method = 'free_coupon',
           payment_status = 'paid',
           paid_at = NOW(),
           auto_confirmed_at = NOW(),
           auto_confirm_note = 'Free coupon package confirmed by user',
           payment_ref = $5,
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $6::jsonb,
           updated_at = NOW()
       WHERE id = $7`,
      [freePkg.id, packageName, coupon.id, coupon.coupon_code, paymentRef, JSON.stringify({ coupon: { id: coupon.id, code: coupon.coupon_code, type: 'free', free_days: freeDays, free_package_group: freeGroup, override_package: true, original_package_id: payment.package_id, confirmed_at: new Date().toISOString() } }), payment.id]
    );

    await client.query(
      `INSERT INTO user_subscriptions (
         user_id, package_id, package_name_snapshot, source_channel, status,
         start_at, end_at, lot_min, lot_max, ports_min, ports_max,
         profit_min, profit_max, profit_label, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())`,
      [base.user.id, freePkg.id, packageName, `free_coupon:${payment.id}`, startAt, endAt, Number(freePkg.lot_min || 0), Number(freePkg.lot_max || 0), Number(freePkg.ports_min || 0), Number(freePkg.ports_max || 0), freePkg.profit_min === null || freePkg.profit_min === undefined ? null : Number(freePkg.profit_min || 0), freePkg.profit_max === null || freePkg.profit_max === undefined ? null : Number(freePkg.profit_max || 0), freePkg.profit_label_th || freePkg.profit_label_en || '']
    );

    await client.query(
      `UPDATE coupons
       SET used_count = COALESCE(used_count, 0) + 1,
           updated_at = NOW(),
           is_active = CASE
             WHEN usage_limit > 0 AND COALESCE(used_count, 0) + 1 >= usage_limit THEN FALSE
             ELSE is_active
           END
       WHERE id = $1`,
      [coupon.id]
    );

    await client.query(
      `INSERT INTO coupon_usages (
          coupon_id,
          user_id,
          payment_id,
          used_at,
          note
       )
       VALUES ($1, $2, $3, NOW(), $4)`,
      [
        coupon.id,
        base.user.id,
        payment.id,
        'free_coupon_confirmed'
      ]
    );

    await client.query('COMMIT');
    delete req.session.freeCouponPreview;
    req.session.success = `ยืนยันสำเร็จ เปิดใช้งานแพ็กเกจฟรี ${packageName} ${freeDays} วันแล้ว`;
    return res.redirect(`/app/package-payment/${paymentId}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    console.error('confirm free coupon error:', error);
    req.session.error = 'ยืนยันคูปองฟรีไม่สำเร็จ';
    return res.redirect(`/app/package-payment/${paymentId}`);
  } finally {
    client.release();
  }
});


router.post('/package-payment/:id/pay-scoin', async (req, res) => {
  const paymentId = Number(req.params.id || 0);
  try {
    const base = await getBaseData(req);
    const result = await payPackageWithScoin({ userId: base.user.id, paymentId });

    req.session.success = `ชำระด้วย Scoin สำเร็จ ใช้ ${Number(result.scoinRequired || 0).toLocaleString('th-TH', { minimumFractionDigits: 4 })} Scoin แพ็กเกจเปิดใช้งานทันที`;
    return res.redirect(`/app/package-payment/${paymentId}`);
  } catch (error) {
    console.error('package pay scoin error:', error);
    req.session.error = error.message || 'ชำระด้วย Scoin ไม่สำเร็จ';
    return res.redirect(`/app/package-payment/${paymentId}`);
  }
});

router.post('/package-payment/:id/pay', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const paymentId = Number(req.params.id || 0);
    const paymentMethod = String(req.body.payment_method || 'promptpay_qr').trim().toLowerCase();

    if (!['promptpay_qr', 'credit_card'].includes(paymentMethod)) {
      req.session.error = 'ช่องทางชำระเงินไม่ถูกต้อง';
      return res.redirect(`/app/package-payment/${paymentId}`);
    }

    const paymentRes = await query(
      `SELECT * FROM payments
       WHERE id = $1 AND user_id = $2 AND package_id IS NOT NULL AND payment_status = 'pending'
       LIMIT 1`,
      [paymentId, base.user.id]
    );

    const payment = paymentRes.rows[0];
    if (!payment) {
      req.session.error = 'ไม่พบรายการ หรือรายการนี้ไม่สามารถชำระเงินได้';
      return res.redirect('/app/packages');
    }

    if (payment.created_at && (Date.now() - new Date(payment.created_at).getTime()) > 20 * 60 * 1000) {
      await query(`UPDATE payments SET payment_status='cancelled', updated_at=NOW() WHERE id=$1`, [payment.id]);
      req.session.error = 'รายการนี้หมดอายุแล้ว';
      return res.redirect('/app/packages');
    }

    const kbankPayment = await createKbankPaymentForPackage(payment);

    await query(
      `UPDATE payments
       SET payment_method = $1, payment_ref = $2, updated_at = NOW()
       WHERE id = $3`,
      [paymentMethod, kbankPayment.ref, payment.id]
    );

    if (kbankPayment.payment_url) {
      return res.redirect(kbankPayment.payment_url);
    }

    req.session.success = 'สร้างข้อมูลชำระเงินแล้ว กรุณาชำระตามข้อมูลด้านล่าง';
    return res.redirect(`/app/package-payment/${payment.id}`);
  } catch (error) {
    console.error('package pay error:', error);
    req.session.error = 'ไม่สามารถไปหน้าชำระเงินได้';
    return res.redirect('/app/packages');
  }
});

router.post('/package-payment/:id/cancel', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const paymentId = Number(req.params.id || 0);

    await query(
      `UPDATE payments
       SET payment_status='cancelled', updated_at=NOW()
       WHERE id=$1 AND user_id=$2 AND payment_status='pending'`,
      [paymentId, base.user.id]
    );

    req.session.success = 'ยกเลิกรายการแล้ว';
    return res.redirect('/app/packages');
  } catch (error) {
    console.error('cancel package payment error:', error);
    req.session.error = 'ยกเลิกไม่สำเร็จ';
    return res.redirect('/app/packages');
  }
});

router.get('/identity', async (req, res) => {
  const base = await getBaseData(req);

  return res.render('app/identity', {
    pageTitle: 'Identity Verification',
    currentPath: '/app/identity',
    ...flash(req),
    ...base
  });
});

router.post('/identity/request-code', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const user = base.user;

    if (isIdentityVerified(user)) {
      req.session.error = 'บัญชีนี้ยืนยันตัวตนแล้ว ไม่สามารถขอรหัส OTP ใหม่ได้';
      return res.redirect('/app/identity');
    }

    const fullName = normalizeText(req.body.full_name);
    const addressLine = normalizeText(req.body.address_line);
    const subdistrict = normalizeText(req.body.subdistrict);
    const district = normalizeText(req.body.district);
    const province = normalizeText(req.body.province);
    const postalCode = normalizeText(req.body.postal_code);
    const phone = normalizePhone(req.body.phone);
    const verifyEmail = normalizeEmail(req.body.verify_email || user.email);

    if (!fullName || !addressLine || !subdistrict || !district || !province || !postalCode || !phone || !verifyEmail) {
      req.session.error = 'กรุณากรอกข้อมูลให้ครบก่อนขอรหัสยืนยัน';
      return res.redirect('/app/identity');
    }

    const otpCode = generateOtpCode();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await query(
      `INSERT INTO user_identity_verifications (
        user_id,
        full_name,
        address_line,
        subdistrict,
        district,
        province,
        postal_code,
        phone,
        verify_email,
        otp_code,
        otp_expires_at,
        verified_at,
        status,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,'pending',NOW(),NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        full_name = EXCLUDED.full_name,
        address_line = EXCLUDED.address_line,
        subdistrict = EXCLUDED.subdistrict,
        district = EXCLUDED.district,
        province = EXCLUDED.province,
        postal_code = EXCLUDED.postal_code,
        phone = EXCLUDED.phone,
        verify_email = EXCLUDED.verify_email,
        otp_code = EXCLUDED.otp_code,
        otp_expires_at = EXCLUDED.otp_expires_at,
        verified_at = NULL,
        status = 'pending',
        updated_at = NOW()`,
      [
        user.id,
        fullName,
        addressLine,
        subdistrict,
        district,
        province,
        postalCode,
        phone,
        verifyEmail,
        otpCode,
        otpExpiresAt
      ]
    );

    await sendIdentityOtpEmail({
      email: verifyEmail,
      fullName,
      code: otpCode
    });

    req.session.success = 'ส่งรหัส OTP ไปทางอีเมลแล้ว';
    return res.redirect('/app/identity');
  } catch (error) {
    console.error('identity request code error:', error);
    req.session.error = 'ส่งรหัสยืนยันไม่สำเร็จ';
    return res.redirect('/app/identity');
  }
});

router.post('/identity/verify', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const user = base.user;
    const otpCode = normalizeText(req.body.otp_code);

    if (!otpCode) {
      req.session.error = 'กรุณากรอกรหัส OTP';
      return res.redirect('/app/identity');
    }

    const result = await query(
      `SELECT *
       FROM user_identity_verifications
       WHERE user_id = $1
       LIMIT 1`,
      [user.id]
    );

    const row = result.rows[0];

    if (!row) {
      req.session.error = 'ยังไม่มีข้อมูลยืนยันตัวตน กรุณาขอรหัสก่อน';
      return res.redirect('/app/identity');
    }

    if (!row.otp_code || !row.otp_expires_at) {
      req.session.error = 'ไม่พบรหัส OTP กรุณาขอรหัสใหม่';
      return res.redirect('/app/identity');
    }

    if (new Date(row.otp_expires_at).getTime() < Date.now()) {
      req.session.error = 'รหัส OTP หมดอายุ กรุณาขอรหัสใหม่';
      return res.redirect('/app/identity');
    }

    if (String(row.otp_code) !== String(otpCode)) {
      req.session.error = 'รหัส OTP ไม่ถูกต้อง';
      return res.redirect('/app/identity');
    }

    await query(
      `UPDATE user_identity_verifications
       SET verified_at = NOW(),
           status = 'verified',
           updated_at = NOW()
       WHERE user_id = $1`,
      [user.id]
    );

    const updatedUserRes = await query(
      `UPDATE users
       SET identity_verified = TRUE,
           identity_verified_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [user.id]
    );

    if (updatedUserRes.rows[0]) {
      req.session.user = updatedUserRes.rows[0];
    }

    req.session.success = 'ยืนยันตัวตนสำเร็จแล้ว';
    return res.redirect('/app/identity');
  } catch (error) {
    console.error('identity verify error:', error);
    req.session.error = 'ยืนยันตัวตนไม่สำเร็จ';
    return res.redirect('/app/identity');
  }
});

router.get('/bots', async (req, res) => {
  const base = await getBaseData(req);
  return res.render('app/bots', {
    pageTitle: 'Bot Connection',
    currentPath: '/app/bots',
    ...flash(req),
    ...base
  });
});

router.post('/broker-accounts', async (req, res) => {
  const user = req.user || req.session.user;
  await query(
    `INSERT INTO user_broker_accounts (user_id, broker_name, account_login, account_password_enc, server_name, account_type)
     VALUES ($1, $2, $3, $4, $5, 'mt5')`,
    [
      user.id,
      String(req.body.broker_name || '').trim(),
      String(req.body.account_login || '').trim(),
      String(req.body.account_password || '').trim(),
      String(req.body.server_name || '').trim()
    ]
  );
  req.session.success = 'เพิ่มบัญชีโบรกเกอร์เรียบร้อยแล้ว';
  return res.redirect('/app/broker-accounts');
});

router.post('/broker-accounts/:id/delete', async (req, res) => {
  const user = req.user || req.session.user;
  await query(`DELETE FROM user_broker_accounts WHERE id = $1 AND user_id = $2`, [req.params.id, user.id]);
  req.session.success = 'ลบบัญชีโบรกเกอร์เรียบร้อยแล้ว';
  return res.redirect('/app/broker-accounts');
});

router.get('/broker-accounts/data', async (req, res) => {
  try {
    const data = await fetchMt5LoginPortfolio(req.user.id);
    if (!data.ok) {
      return res.status(400).json(data);
    }
    return res.json(data);
  } catch (e) {
    console.error('[broker-accounts/data]', e);
    return res.status(500).json({ ok: false, message: e.message || 'server_error' });
  }
});

router.get('/broker-accounts', async (req, res) => {
  const base = await getBaseData(req);
  return res.render('app/broker-accounts', {
    pageTitle: 'บัญชีโบรกเกอร์ MT5',
    pageCss: 'app-broker-accounts.css',
    currentPath: '/app/broker-accounts',
    refreshSec: MT5_CALENDAR_REFRESH_SEC,
    ...flash(req),
    ...base
  });
});

router.post('/bots/:accountId/play', async (req, res) => {
  const user = req.user || req.session.user;
  const sub = await getCurrentSubscription(user.id);
  const lot = Number(req.body.lot_in_use || 0);
  const ports = Number(req.body.ports_in_use || 1);

  const result = await query(
    `INSERT INTO bot_sessions (user_id, broker_account_id, session_code, symbol, lot_in_use, ports_in_use, status, started_at)
     VALUES ($1, $2, encode(gen_random_bytes(6), 'hex'), $3, $4, $5, 'running', NOW()) RETURNING id`,
    [
      user.id,
      req.params.accountId,
      String(req.body.symbol || 'XAUUSD'),
      lot || Number(sub?.lot_min || 0),
      ports || Number(sub?.ports_min || 1)
    ]
  );

  req.session.success = `เริ่ม Bot session #${result.rows[0].id} แล้ว`;
  return res.redirect('/app/bots');
});

router.post('/bots/:id/stop', async (req, res) => {
  const user = req.user || req.session.user;
  await query(
    `UPDATE bot_sessions SET status = 'stopped', stopped_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [req.params.id, user.id]
  );
  req.session.success = 'หยุด Bot แล้ว';
  return res.redirect('/app/bots');
});

async function getReferralTree(rootUserId, maxLevel = 5) {
  const tree = [];
  let currentLevelUserIds = [rootUserId];

  for (let level = 1; level <= maxLevel; level += 1) {
    if (!currentLevelUserIds.length) break;

    const result = await query(
      `SELECT
         u.id,
         COALESCE(NULLIF(u.display_id, ''), 'US' || LPAD(u.id::text, 6, '0')) AS display_id,
         u.referred_by_user_id,
         COALESCE(NULLIF(u.full_name, ''), NULLIF(TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email, '-') AS full_name,
         u.email,
         COALESCE(u.scoin_balance, 0) AS scoin_balance,
         u.created_at
       FROM users u
       WHERE u.referred_by_user_id = ANY($1::bigint[])
       ORDER BY u.created_at ASC`,
      [currentLevelUserIds]
    ).catch(() => ({ rows: [] }));

    const rows = result.rows.map((row) => ({
      ...row,
      level_no: level
    }));

    tree.push(...rows);
    currentLevelUserIds = rows.map((row) => row.id);
  }

  return tree;
}

router.get('/scoin-market', async (req, res) => {
  return res.redirect('/app/scoin-wallet');
});

router.post('/scoin-market/order', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const orderType = String(req.body.order_type || '').trim().toLowerCase();
    const paymentMethod = String(req.body.payment_method || '').trim().toLowerCase();
    const scoinAmountInput = Number(req.body.scoin_amount || 0);
    const amountThbInput = Number(req.body.amount_thb || 0);
    const note = String(req.body.note || '').trim();

    const priceThb = Number((base.scoinSettings && base.scoinSettings.current_price_thb) || 1);
    const feePercent = orderType === 'buy'
      ? Number((base.scoinSettings && (base.scoinSettings.buy_fee_percent ?? base.scoinSettings.transfer_fee_percent)) || 3)
      : Number((base.scoinSettings && (base.scoinSettings.sell_fee_percent ?? base.scoinSettings.transfer_fee_percent)) || 3);

    if (!['buy', 'sell'].includes(orderType)) {
      req.session.error = 'ประเภทคำสั่งไม่ถูกต้อง';
      return res.redirect('/app/scoin-wallet');
    }

    let scoinAmount = 0;
    let amountThb = 0;

    if (scoinAmountInput > 0) {
      scoinAmount = scoinAmountInput;
      amountThb = scoinAmount * priceThb;
    } else if (amountThbInput > 0) {
      amountThb = amountThbInput;
      scoinAmount = amountThb / priceThb;
    }

    if (!Number.isFinite(scoinAmount) || scoinAmount <= 0 || !Number.isFinite(amountThb) || amountThb <= 0) {
      req.session.error = 'กรุณากรอกจำนวน Scoin หรือจำนวนเงินบาทให้ถูกต้อง';
      return res.redirect('/app/scoin-wallet');
    }


    if (orderType === 'buy' && !['promptpay_qr', 'credit_card', 'internet_banking'].includes(paymentMethod)) {
      req.session.error = 'กรุณาเลือกช่องทางชำระเงิน';
      return res.redirect('/app/scoin-wallet');
    }

    if (orderType === 'sell' && Number(base.scoinAvailableBalance ?? base.scoinBalance ?? 0) < scoinAmount) {
      req.session.error = 'ยอด Scoin ที่ใช้ได้ไม่พอสำหรับขายคืนโฮส';
      return res.redirect('/app/scoin-wallet');
    }

    let verifiedBank = null;
    if (orderType === 'sell') {
      const bankRes = await query(
        `SELECT *
         FROM user_bank_accounts
         WHERE user_id = $1 AND COALESCE(is_verified, false) = true
         ORDER BY id DESC
         LIMIT 1`,
        [base.user.id]
      ).catch(() => ({ rows: [] }));

      verifiedBank = bankRes.rows[0] || null;

      if (!verifiedBank) {
        req.session.error = 'กรุณาเพิ่มและยืนยันบัญชีรับเงินก่อนขาย Scoin';
        return res.redirect('/app/bank-accounts');
      }
    }

const grossAmountThb = amountThb;
const feeAmountThb = grossAmountThb * feePercent / 100;

const totalPayThb = orderType === 'buy'
  ? grossAmountThb + feeAmountThb
  : grossAmountThb - feeAmountThb;

const netAmountThb = totalPayThb;

    const insertRes = await query(
      `INSERT INTO scoin_market_orders (
        user_id,
        order_type,
        scoin_amount,
        price_thb,
        gross_amount_thb,
        fee_percent,
        fee_amount_thb,
        net_amount_thb,
        payment_method,
        payment_status,
        status,
        note,
        bank_account_id,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,NOW(),NOW()
      )
      RETURNING *`,
      [
        base.user.id,
        orderType,
        scoinAmount,
        priceThb,
        grossAmountThb,
        feePercent,
        feeAmountThb,
        netAmountThb,
        orderType === 'buy' ? paymentMethod : 'bank_transfer',
        orderType === 'buy' ? 'pending' : 'not_required',
        note,
        verifiedBank ? verifiedBank.id : null
      ]
    );

    const order = insertRes.rows[0];

    if (orderType === 'sell') {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await lockScoinForOrder(client, {
          userId: base.user.id,
          amount: scoinAmount,
          orderId: order.id
        });
        await client.query('COMMIT');
      } catch (lockError) {
        await client.query('ROLLBACK');
        await query(`DELETE FROM scoin_market_orders WHERE id = $1`, [order.id]).catch(() => {});
        throw lockError;
      } finally {
        client.release();
      }
    }

if (orderType === 'sell') {
  await notifyAdminSellOrder({
    order,
    user: base.user,
    bank: verifiedBank
  }).catch((err) => {
    console.error('notify admin sell order error:', err);
  });
}

    if (orderType === 'buy') {
      req.session.success = 'สร้างคำสั่งซื้อ Scoin แล้ว กรุณาชำระเงิน';
      return res.redirect(`/app/scoin-market/payment/${order.id}`);
    }

    req.session.success = 'ส่งคำสั่งขาย Scoin คืนโฮสสำเร็จ รอ admin อนุมัติ';
    return res.redirect('/app/scoin-wallet');
  } catch (error) {
    console.error('scoin market order error:', error);
    req.session.error = error.message || 'ส่งคำสั่งตลาด Scoin ไม่สำเร็จ';
    return res.redirect('/app/scoin-wallet');
  }
});

router.get('/scoin-market/payment/:id', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const orderId = Number(req.params.id || 0);

    const orderRes = await query(
      `SELECT *
       FROM scoin_market_orders
       WHERE id = $1
         AND user_id = $2
         AND order_type = 'buy'
       LIMIT 1`,
      [orderId, base.user.id]
    );

    const order = orderRes.rows[0];
    if (!order) {
      req.session.error = 'ไม่พบคำสั่งซื้อ Scoin';
      return res.redirect('/app/scoin-wallet');
    }

    if (String(order.status || '') === 'approved') {
      req.session.success = 'คำสั่งนี้ชำระเงินสำเร็จแล้ว';
      return res.redirect('/app/scoin-wallet');
    }

    const kbankPayment = await createKbankPaymentForScoin(order);

    await query(
      `UPDATE scoin_market_orders
       SET payment_ref = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, kbankPayment.ref]
    );

    return res.render('app/scoin-payment', {
      pageTitle: 'ชำระเงินซื้อ Scoin',
      currentPath: '/app/scoin-wallet',
      currentUrl: req.originalUrl,
      ...flash(req),
      ...base,
      order,
      kbankPayment,
      kbankMockMode: isMockMode()
    });
  } catch (error) {
    console.error('scoin payment page error:', error);
    req.session.error = 'เปิดหน้าชำระเงินไม่สำเร็จ';
    return res.redirect('/app/scoin-wallet');
  }
});

router.post('/scoin-market/payment-callback', async (req, res) => {
  try {
    const orderId = Number(req.body.order_id || 0);
    const paymentRef = String(req.body.payment_ref || '').trim();
    const paid = String(req.body.status || '').trim().toLowerCase() === 'paid';

    if (!orderId || !paid) {
      return res.status(400).json({ ok: false, error: 'invalid callback' });
    }

    const paidOrder = await markMarketOrderPaid(orderId, {
      callback_body: req.body,
      payment_ref: paymentRef
    });

    if (!paidOrder) {
      return res.status(404).json({ ok: false, error: 'order not found' });
    }

    await query(
      `UPDATE scoin_market_orders
       SET payment_ref = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId, paymentRef || null]
    );

    await approveBuyOrderAndCredit(orderId, null);

    return res.json({ ok: true });
  } catch (error) {
    console.error('scoin payment callback error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'callback failed' });
  }
});

router.post('/scoin-wallet/create-wallet', async (req, res) => {
  try {
    const user = req.user || req.session.user;
    await ensureUserWallet(user.id);
    req.session.success = 'สร้างรหัสกระเป๋า Scoin สำเร็จแล้ว';
    return res.redirect('/app/scoin-wallet');
  } catch (error) {
    console.error('create wallet error:', error);
    req.session.error = error.message || 'สร้างรหัสกระเป๋าไม่สำเร็จ';
    return res.redirect('/app/scoin-wallet');
  }
});

router.get('/scoin-wallet', async (req, res) => {
  const base = await getBaseData(req);
const pageOrders = Math.max(1, Number(req.query.orders_page || 1));
const pageTxs = Math.max(1, Number(req.query.txs_page || 1));
const limit = 10;
const ordersOffset = (pageOrders - 1) * limit;
const txsOffset = (pageTxs - 1) * limit;

  const transactionsRes = await query(
    `SELECT
       st.*,
       ru.email AS ref_user_email,
       ru.full_name AS ref_user_name
     FROM scoin_transactions st
     LEFT JOIN users ru ON ru.id = st.ref_user_id
     WHERE st.user_id = $1
     ORDER BY st.created_at DESC
     LIMIT $2 OFFSET $3`,
    [base.user.id, limit, txsOffset]
  ).catch(() => ({ rows: [] }));

  const marketOrdersRes = await query(
    `SELECT *
     FROM scoin_market_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [base.user.id, limit, ordersOffset]
  ).catch(() => ({ rows: [] }));

  const marketSummaryRes = await query(
    `SELECT
       COUNT(*)::int AS total_orders,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
       COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_orders,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders
     FROM scoin_market_orders
     WHERE user_id = $1`,
    [base.user.id]
  ).catch(() => ({ rows: [{ total_orders: 0, pending_orders: 0, approved_orders: 0, cancelled_orders: 0 }] }));

  const verifiedBankRes = await query(
    `SELECT *
     FROM user_bank_accounts
     WHERE user_id = $1
     ORDER BY is_verified DESC, id DESC
     LIMIT 1`,
    [base.user.id]
  ).catch(() => ({ rows: [] }));

  const payOrderId = Number(req.query.pay_order || 0);
  let paymentOrder = null;

  if (payOrderId > 0) {
    const paymentOrderRes = await query(
      `SELECT *
       FROM scoin_market_orders
       WHERE id = $1 AND user_id = $2 AND order_type = 'buy'
       LIMIT 1`,
      [payOrderId, base.user.id]
    ).catch(() => ({ rows: [] }));

    paymentOrder = paymentOrderRes.rows[0] || null;
  }

const ordersCountRes = await query(
  `SELECT COUNT(*)::int AS total
   FROM scoin_market_orders
   WHERE user_id = $1`,
  [base.user.id]
).catch(() => ({ rows: [{ total: 0 }] }));

const txsCountRes = await query(
  `SELECT COUNT(*)::int AS total
   FROM scoin_transactions
   WHERE user_id = $1`,
  [base.user.id]
).catch(() => ({ rows: [{ total: 0 }] }));

  return res.render('app/scoin-wallet', {
    pageTitle: 'Scoin Wallet',
    currentPath: '/app/scoin-wallet',
    ...flash(req),
    ...base,
    transactions: transactionsRes.rows,
    marketOrders: marketOrdersRes.rows,
    marketSummary: marketSummaryRes.rows[0] || {
      total_orders: 0,
      pending_orders: 0,
      approved_orders: 0,
      cancelled_orders: 0
    },
    bankAccount: verifiedBankRes.rows[0] || null,
paymentOrder,
ordersPagination: {
  page: pageOrders,
  limit,
  total: Number(ordersCountRes.rows[0]?.total || 0),
  totalPages: Math.max(1, Math.ceil(Number(ordersCountRes.rows[0]?.total || 0) / limit))
},
txsPagination: {
  page: pageTxs,
  limit,
  total: Number(txsCountRes.rows[0]?.total || 0),
  totalPages: Math.max(1, Math.ceil(Number(txsCountRes.rows[0]?.total || 0) / limit))
}
  });
});

router.get('/bank-accounts', async (req, res) => {
  try {
    const base = await getBaseData(req);

    const bankRes = await query(
      `SELECT *
       FROM user_bank_accounts
       WHERE user_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [base.user.id]
    ).catch(() => ({ rows: [] }));

    return res.render('app/bank-accounts', {
      pageTitle: 'Bank Accounts',
      currentPath: '/app/bank-accounts',
      ...flash(req),
      ...base,
      bankAccount: bankRes.rows[0] || null
    });
  } catch (error) {
    console.error('bank accounts page error:', error);
    req.session.error = 'ไม่สามารถโหลดหน้าบัญชีรับเงินได้';
    return res.redirect('/app/scoin-wallet');
  }
});

router.post('/bank-accounts/save', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const userId = base.user.id;

    const bankName = normalizeText(req.body.bank_name);
    const accountName = normalizeText(req.body.account_name);
    const accountNumber = normalizeText(req.body.account_number).replace(/\s+/g, '');
    const verifyEmail = normalizeEmail(req.body.verify_email || base.user.email);

    if (!bankName || !accountName || !accountNumber || !verifyEmail) {
  req.session.error = 'กรุณากรอกข้อมูลให้ครบ';
  return res.redirect('/app/bank-accounts');
}

const oldBankRes = await query(
  `SELECT *
   FROM user_bank_accounts
   WHERE user_id = $1
   ORDER BY id DESC
   LIMIT 1`,
  [userId]
);

const oldBank = oldBankRes.rows[0] || null;

let needOtp = true;

if (oldBank && oldBank.is_verified) {
  const sameData =
    String(oldBank.bank_name || '') === bankName &&
    String(oldBank.account_name || '') === accountName &&
    String(oldBank.account_number || '') === accountNumber &&
    String(oldBank.verify_email || '') === verifyEmail;

  if (sameData) {
    needOtp = false;
  }
}

    await query(
      `INSERT INTO user_bank_accounts (
        user_id,
        bank_name,
        account_name,
        account_number,
        account_number_masked,
        verify_email,
        is_verified,
        status,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7 = true THEN 'verified' ELSE 'pending' END,NOW(),NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        bank_name = EXCLUDED.bank_name,
        account_name = EXCLUDED.account_name,
        account_number = EXCLUDED.account_number,
        account_number_masked = EXCLUDED.account_number_masked,
        verify_email = EXCLUDED.verify_email,
        is_verified = $7,
	verified_at = CASE WHEN $7 = true THEN user_bank_accounts.verified_at ELSE NULL END,
	status = CASE WHEN $7 = true THEN 'verified' ELSE 'pending' END,
        updated_at = NOW()`,
      [
  userId,
  bankName,
  accountName,
  accountNumber,
  maskAccountNumber(accountNumber),
  verifyEmail,
  !needOtp
]
    );

    const bankRes = await query(
  `SELECT *
   FROM user_bank_accounts
   WHERE user_id = $1
   ORDER BY id DESC
   LIMIT 1`,
  [userId]
);

const bank = bankRes.rows[0];

if (needOtp && bank && bank.verify_email) {
  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await query(
  `INSERT INTO email_otps (
    user_id,
    email,
    otp_code,
    ref_type,
    ref_id,
    purpose,
    expires_at,
    used_at,
    created_at
  )
  VALUES ($1,$2,$3,'bank_account_verify',$4,'bank_account_verify',$5,NULL,NOW())`,
  [userId, bank.verify_email, otpCode, bank.id, expiresAt]
);

  await sendBankOtpEmail({
    email: bank.verify_email,
    accountName: bank.account_name,
    code: otpCode
  });

  req.session.success = 'บันทึกบัญชีรับเงินแล้ว และส่ง OTP ไปยังอีเมลแล้ว';
} else {
  req.session.success = 'ข้อมูลบัญชีเดิมยืนยันแล้ว ไม่ต้องส่ง OTP ใหม่';
}

return res.redirect('/app/bank-accounts');

  } catch (error) {
    console.error('bank account save error:', error);
    req.session.error = 'บันทึกบัญชีรับเงินไม่สำเร็จ';
    return res.redirect('/app/bank-accounts');
  }
});

async function notifyAdminSellOrder({ order, user, bank }) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL || process.env.SMTP_USER;
  if (!adminEmail) return;

  await sendMailSafe({
    to: adminEmail,
    subject: `มีคำสั่งขาย Scoin ใหม่ #${order.id}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#0f172a">
        <h2>มีคำสั่งขาย Scoin ใหม่</h2>
        <p><b>Order ID:</b> ${order.id}</p>
        <p><b>User:</b> ${user.email || user.id}</p>
        <p><b>Scoin:</b> ${order.scoin_amount}</p>
        <p><b>ยอดรับสุทธิ:</b> ${order.net_amount_thb} บาท</p>
        <p><b>ธนาคาร:</b> ${bank?.bank_name || '-'}</p>
        <p><b>ชื่อบัญชี:</b> ${bank?.account_name || '-'}</p>
        <p><b>เลขบัญชี:</b> ${bank?.account_number_masked || '-'}</p>
        <p><a href="${appBaseUrl()}/admin/scoin-market">เปิดหน้าอนุมัติ</a></p>
      </div>
    `
  });
}

router.post('/bank-accounts/send-otp', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const userId = base.user.id;

    const bankRes = await query(
      `SELECT *
       FROM user_bank_accounts
       WHERE user_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    );

    const bank = bankRes.rows[0];

    if (!bank) {
      req.session.error = 'กรุณาบันทึกบัญชีรับเงินก่อนส่ง OTP';
      return res.redirect('/app/bank-accounts');
    }

    if (!bank.verify_email) {
      req.session.error = 'ไม่พบอีเมลสำหรับยืนยันบัญชี';
      return res.redirect('/app/bank-accounts');
    }

    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await query(
  `INSERT INTO email_otps (
    user_id,
    email,
    otp_code,
    ref_type,
    ref_id,
    purpose,
    expires_at,
    used_at,
    created_at
  )
  VALUES ($1,$2,$3,'bank_account_verify',$4,'bank_account_verify',$5,NULL,NOW())`,
  [userId, bank.verify_email, otpCode, bank.id, expiresAt]
);

    await sendBankOtpEmail({
      email: bank.verify_email,
      accountName: bank.account_name,
      code: otpCode
    });

    req.session.success = 'ส่งรหัส OTP ไปยังอีเมลแล้ว';
    return res.redirect('/app/bank-accounts');
  } catch (error) {
    console.error('bank account send otp error:', error);
    req.session.error = 'ส่ง OTP ไม่สำเร็จ';
    return res.redirect('/app/bank-accounts');
  }
});

router.post('/bank-accounts/verify-otp', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const userId = base.user.id;
    const otpCode = normalizeText(req.body.otp_code);

    if (!otpCode) {
      req.session.error = 'กรุณากรอกรหัส OTP';
      return res.redirect('/app/bank-accounts');
    }

    const otpRes = await query(
      `SELECT *
       FROM email_otps
       WHERE user_id = $1
         AND purpose = 'bank_account_verify'
         AND used_at IS NULL
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    );

    const otpRow = otpRes.rows[0];

    if (!otpRow) {
      req.session.error = 'ไม่พบรหัส OTP กรุณากดส่งรหัสใหม่';
      return res.redirect('/app/bank-accounts');
    }

    if (!otpRow.expires_at || new Date(otpRow.expires_at).getTime() < Date.now()) {
      req.session.error = 'รหัส OTP หมดอายุ กรุณาขอรหัสใหม่';
      return res.redirect('/app/bank-accounts');
    }

    if (String(otpRow.otp_code) !== String(otpCode)) {
      req.session.error = 'รหัส OTP ไม่ถูกต้อง';
      return res.redirect('/app/bank-accounts');
    }

    await query(
      `UPDATE email_otps
       SET used_at = NOW()
       WHERE id = $1`,
      [otpRow.id]
    );

    await query(
      `UPDATE user_bank_accounts
       SET is_verified = true,
           verified_at = NOW(),
           status = 'verified',
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    req.session.success = 'ยืนยันบัญชีรับเงินสำเร็จแล้ว';
    return res.redirect('/app/bank-accounts');
  } catch (error) {
    console.error('bank account verify otp error:', error);
    req.session.error = 'ยืนยัน OTP ไม่สำเร็จ';
    return res.redirect('/app/bank-accounts');
  }
});

router.post('/scoin-market/payment/:id/confirm', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const orderId = Number(req.params.id || 0);
    const paymentRef = String(req.body.payment_ref || `MANUAL-${orderId}-${Date.now()}`).trim();

    const orderRes = await query(
      `SELECT *
       FROM scoin_market_orders
       WHERE id = $1 AND user_id = $2 AND order_type = 'buy'
       LIMIT 1`,
      [orderId, base.user.id]
    );

    const order = orderRes.rows[0];

    if (!order) {
      req.session.error = 'ไม่พบคำสั่งซื้อ';
      return res.redirect('/app/scoin-wallet');
    }

    if (String(order.status) === 'approved') {
      req.session.success = 'คำสั่งนี้ชำระเงินและเติม Scoin แล้ว';
      return res.redirect('/app/scoin-wallet');
    }

    await query(
      `UPDATE scoin_market_orders
       SET payment_status = 'paid',
           payment_ref = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [orderId, paymentRef]
    );

    await approveBuyOrderAndCredit(orderId, null);

    req.session.success = 'ยืนยันการชำระเงินสำเร็จ ระบบเติม Scoin ให้แล้ว';
    return res.redirect('/app/scoin-wallet');
  } catch (error) {
    console.error('scoin payment confirm error:', error);
    req.session.error = error.message || 'ยืนยันการชำระเงินไม่สำเร็จ';
    return res.redirect('/app/scoin-wallet');
  }
});

router.post('/scoin-market/order/:id/cancel', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const orderId = Number(req.params.id || 0);

    await query(
      `UPDATE scoin_market_orders
       SET status = 'cancelled',
           payment_status = 'cancelled',
           updated_at = NOW()
       WHERE id = $1
         AND user_id = $2
         AND order_type = 'buy'
         AND status = 'pending'
         AND payment_status = 'pending'`,
      [orderId, base.user.id]
    );

    req.session.success = 'ยกเลิกคำสั่งซื้อแล้ว';
    return res.redirect('/app/scoin-wallet');
  } catch (error) {
    console.error('cancel scoin order error:', error);
    req.session.error = 'ยกเลิกคำสั่งซื้อไม่สำเร็จ';
    return res.redirect('/app/scoin-wallet');
  }
});

router.post('/kbank/webhook/qr', async (req, res) => {
  try {
    if (!(await verifyKbankWebhook(req))) {
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }

    const body = req.body || {};
    const paymentRef =
      body.order_id ||
      body.reference_order ||
      body.payment_ref ||
      body.ref ||
      body.id ||
      '';

    const paidStatus = String(
      body.status ||
      body.payment_status ||
      body.transaction_state ||
      ''
    ).toLowerCase();

    const isPaid = ['paid', 'success', 'successful', 'approved', 'completed'].includes(paidStatus);

    if (!paymentRef || !isPaid) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const orderRes = await query(
      `SELECT *
       FROM scoin_market_orders
       WHERE payment_ref = $1
         AND order_type = 'buy'
       LIMIT 1`,
      [paymentRef]
    );

    const order = orderRes.rows[0];

    if (!order) {
      return res.status(200).json({ ok: true, ignored: 'order not found' });
    }

    if (String(order.status) === 'approved') {
      return res.status(200).json({ ok: true, already_paid: true });
    }

    await query(
      `UPDATE scoin_market_orders
       SET payment_status = 'paid',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id]
    );

    await approveBuyOrderAndCredit(order.id, null);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('kbank qr webhook error:', error);
    return res.status(500).json({ ok: false });
  }
});

router.post('/kbank/webhook/card', async (req, res) => {
  try {
    if (!(await verifyKbankWebhook(req))) {
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }

    const body = req.body || {};
    const paymentRef =
      body.order_id ||
      body.reference_order ||
      body.payment_ref ||
      body.ref ||
      body.id ||
      '';

    const paidStatus = String(
      body.status ||
      body.payment_status ||
      body.transaction_state ||
      ''
    ).toLowerCase();

    const isPaid = ['paid', 'success', 'successful', 'approved', 'completed'].includes(paidStatus);

    if (!paymentRef || !isPaid) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const orderRes = await query(
      `SELECT *
       FROM scoin_market_orders
       WHERE payment_ref = $1
         AND order_type = 'buy'
       LIMIT 1`,
      [paymentRef]
    );

    const order = orderRes.rows[0];

    if (!order) {
      return res.status(200).json({ ok: true, ignored: 'order not found' });
    }

    if (String(order.status) === 'approved') {
      return res.status(200).json({ ok: true, already_paid: true });
    }

    await query(
      `UPDATE scoin_market_orders
       SET payment_status = 'paid',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id]
    );

    await approveBuyOrderAndCredit(order.id, null);

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('kbank card webhook error:', error);
    return res.status(500).json({ ok: false });
  }
});

router.post('/scoin-wallet/transfer-by-wallet', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const fromUserId = base.user.id;
    const toWalletCode = String(req.body.to_wallet_code || '').trim();
    const amount = Number(req.body.amount || 0);

    if (!toWalletCode) {
      req.session.error = 'กรุณากรอกรหัสกระเป๋าปลายทาง';
      return res.redirect('/app/scoin-wallet');
    }

    if (!/^SCN-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(toWalletCode)) {
      req.session.error = 'รูปแบบรหัสกระเป๋าไม่ถูกต้อง';
      return res.redirect('/app/scoin-wallet');
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      req.session.error = 'จำนวน Scoin ไม่ถูกต้อง';
      return res.redirect('/app/scoin-wallet');
    }

    const targetUser = await findUserByWalletCode(toWalletCode);

    if (!targetUser) {
      req.session.error = 'ไม่พบรหัสกระเป๋าปลายทาง';
      return res.redirect('/app/scoin-wallet');
    }

    if (Number(targetUser.id) === Number(fromUserId)) {
      req.session.error = 'ไม่สามารถโอนให้กระเป๋าของตัวเองได้';
      return res.redirect('/app/scoin-wallet');
    }

    const transferResult = await transferScoinByWalletCode({
      fromUserId,
      toWalletCode,
      amount
    });

    req.session.success = `โอน Scoin สำเร็จ ผู้รับจะได้รับ ${Number(transferResult.receiveAmount || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} SCOIN`;
    return res.redirect('/app/scoin-wallet');
  } catch (error) {
    console.error('scoin transfer by wallet error:', error);
    req.session.error = error.message || 'โอนผ่านรหัสกระเป๋าไม่สำเร็จ';
    return res.redirect('/app/scoin-wallet');
  }
});

router.get('/referrals', async (req, res) => {
  const base = await getBaseData(req);

  const memberPage = Math.max(1, Number(req.query.memberPage || req.query.page || 1));
  const incomePage = Math.max(1, Number(req.query.incomePage || 1));
  const limit = 10;

  const treeRows = await getReferralTree(base.user.id, 5);
  const memberOffset = (memberPage - 1) * limit;
  const pagedRows = treeRows.slice(memberOffset, memberOffset + limit);
  const totalMembers = treeRows.length;

  const levels = [1, 2, 3, 4, 5].map((level) => ({
    level,
    members: treeRows.filter((row) => Number(row.level_no) === level)
  }));

  // รายได้ที่ต้องโชว์ในหน้า referrals เท่านั้น
  // - โบนัสแนะนำตรงครั้งแรก 60%: referral_first_purchase_bonus, qualified_referral_bonus
  // - โบนัสสายงานจากการซื้อแพ็กเกจด้วยเงินจริง: referral_level_1_bonus ... referral_level_5_bonus
  // - รองรับข้อมูลเก่าที่เคยใช้: referral_level_bonus, referral_reward
  const referralIncomeWhere = `
    st.direction = 'in'
    AND (
      st.tx_type IN ('referral_first_purchase_bonus', 'qualified_referral_bonus', 'referral_level_bonus', 'referral_reward')
      OR st.tx_type LIKE 'referral_level_%_bonus'
    )
  `;

  const incomeSummaryRes = await query(
    `SELECT
       COALESCE(SUM(st.amount), 0) AS total_scoin_income,
       COUNT(*) AS total_reward_count,
       COALESCE(SUM(CASE WHEN st.tx_type IN ('referral_first_purchase_bonus', 'qualified_referral_bonus') THEN st.amount ELSE 0 END), 0) AS direct_first_income,
       COALESCE(COUNT(CASE WHEN st.tx_type IN ('referral_first_purchase_bonus', 'qualified_referral_bonus') THEN 1 END), 0) AS direct_first_count,
       COALESCE(SUM(CASE WHEN (st.tx_type LIKE 'referral_level_%_bonus' OR st.tx_type IN ('referral_level_bonus', 'referral_reward')) AND COALESCE(st.level_no, 1) = 1 THEN st.amount ELSE 0 END), 0) AS level1_income,
       COALESCE(SUM(CASE WHEN (st.tx_type LIKE 'referral_level_%_bonus' OR st.tx_type IN ('referral_level_bonus', 'referral_reward')) AND st.level_no = 2 THEN st.amount ELSE 0 END), 0) AS level2_income,
       COALESCE(SUM(CASE WHEN (st.tx_type LIKE 'referral_level_%_bonus' OR st.tx_type IN ('referral_level_bonus', 'referral_reward')) AND st.level_no = 3 THEN st.amount ELSE 0 END), 0) AS level3_income,
       COALESCE(SUM(CASE WHEN (st.tx_type LIKE 'referral_level_%_bonus' OR st.tx_type IN ('referral_level_bonus', 'referral_reward')) AND st.level_no = 4 THEN st.amount ELSE 0 END), 0) AS level4_income,
       COALESCE(SUM(CASE WHEN (st.tx_type LIKE 'referral_level_%_bonus' OR st.tx_type IN ('referral_level_bonus', 'referral_reward')) AND st.level_no = 5 THEN st.amount ELSE 0 END), 0) AS level5_income
     FROM scoin_transactions st
     WHERE st.user_id = $1
       AND ${referralIncomeWhere}`,
    [base.user.id]
  ).catch((error) => {
    console.error('referral income summary error:', error);
    return { rows: [{}] };
  });

  const incomeSummaryRow = incomeSummaryRes.rows[0] || {};
  const referralIncomeSummary = {
    totalScoinIncome: Number(incomeSummaryRow.total_scoin_income || 0),
    totalRewardCount: Number(incomeSummaryRow.total_reward_count || 0),
    directFirstIncome: Number(incomeSummaryRow.direct_first_income || 0),
    directFirstCount: Number(incomeSummaryRow.direct_first_count || 0),
    byLevel: [1, 2, 3, 4, 5].map((level) => ({
      level,
      percent: level === 1 ? 8 : level === 2 ? 5 : level === 3 ? 3 : 2,
      amount: Number(incomeSummaryRow[`level${level}_income`] || 0),
      members: treeRows.filter((row) => Number(row.level_no) === level).length
    }))
  };

  const incomeCountRes = await query(
    `SELECT COUNT(*) AS total
     FROM scoin_transactions st
     WHERE st.user_id = $1
       AND ${referralIncomeWhere}`,
    [base.user.id]
  ).catch((error) => {
    console.error('referral income count error:', error);
    return { rows: [{ total: 0 }] };
  });

  const totalIncomeDetails = Number((incomeCountRes.rows && incomeCountRes.rows[0] && incomeCountRes.rows[0].total) || 0);
  const incomeOffset = (incomePage - 1) * limit;

  const incomeDetailsRes = await query(
    `SELECT
       st.id,
       COALESCE(NULLIF(st.display_id, ''), 'ST' || LPAD(st.id::text, 6, '0')) AS display_id,
       st.tx_type,
       st.amount,
       COALESCE(st.level_no, 0) AS level_no,
       st.created_at,
       st.ref_payment_id,
       st.ref_package_id,
       st.meta_json,
       COALESCE((st.meta_json->>'percent')::numeric, (st.meta_json->>'reward_percent')::numeric, 0) AS reward_percent,
       COALESCE((st.meta_json->>'package_price_thb')::numeric, (st.meta_json->>'package_price')::numeric, (st.meta_json->>'price_thb')::numeric, p.final_amount, p.amount, pkg.price, 0) AS package_price_thb,
       COALESCE(NULLIF(buyer.display_id, ''), 'US' || LPAD(buyer.id::text, 6, '0')) AS buyer_display_id,
       COALESCE(NULLIF(buyer.full_name, ''), NULLIF(TRIM(COALESCE(buyer.first_name,'') || ' ' || COALESCE(buyer.last_name,'')), ''), buyer.email, '-') AS buyer_name,
       buyer.email AS buyer_email,
       COALESCE(p.package_name_snapshot, 'แพ็กเกจ') AS package_name,
       COALESCE(p.final_amount, p.amount, pkg.price, 0) AS package_amount,
       COALESCE(p.payment_method, '-') AS payment_method
     FROM scoin_transactions st
     LEFT JOIN users buyer ON buyer.id = st.ref_user_id
     LEFT JOIN payments p ON p.id = st.ref_payment_id
     LEFT JOIN packages pkg ON pkg.id = st.ref_package_id
     WHERE st.user_id = $1
       AND ${referralIncomeWhere}
     ORDER BY st.created_at DESC, st.id DESC
     LIMIT $2 OFFSET $3`,
    [base.user.id, limit, incomeOffset]
  ).catch((error) => {
    console.error('referral income detail error:', error);
    return { rows: [] };
  });

  return res.render('app/referrals', {
    pageTitle: 'My Referral Network',
    pageCss: 'app-referrals.css',
    currentPath: '/app/referrals',
    ...flash(req),
    ...base,
    referralLevels: levels,
    referralTreeRows: pagedRows,
    referralIncomeSummary,
    referralIncomeDetails: incomeDetailsRes.rows || [],
    incomePagination: {
      page: incomePage,
      limit,
      total: totalIncomeDetails,
      totalPages: Math.max(1, Math.ceil(totalIncomeDetails / limit))
    },
    memberPagination: {
      page: memberPage,
      limit,
      total: totalMembers,
      totalPages: Math.max(1, Math.ceil(totalMembers / limit))
    },
    pagination: {
      page: memberPage,
      limit,
      total: totalMembers,
      totalPages: Math.max(1, Math.ceil(totalMembers / limit))
    }
  });
});


router.get('/calendar', async (req, res) => {
  const base = await getBaseData(req);
  return res.render('app/calendar', {
    pageTitle: 'ปฏิทินกำไร MT5',
    pageCss: 'app-calendar.css',
    currentPath: '/app/calendar',
    activeTab: 'calendar',
    refreshSec: MT5_CALENDAR_REFRESH_SEC,
    ...flash(req),
    ...base
  });
});

router.get('/calendar/ai', async (req, res) => {
  const base = await getBaseData(req);
  return res.render('app/calendar', {
    pageTitle: 'AI วิเคราะห์ตลาด 30 วัน',
    pageCss: 'app-calendar.css',
    currentPath: '/app/calendar/ai',
    activeTab: 'ai',
    refreshSec: MT5_CALENDAR_REFRESH_SEC,
    ...flash(req),
    ...base
  });
});

router.get('/calendar/forecast', async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = Number(req.query.accountId || 0);
    const refresh = String(req.query.refresh || '') === '1';
    const data = await fetchForecastForAccount(userId, accountId, { refresh });
    if (!data.ok) {
      return res.status(data.message === 'account_not_found' ? 404 : 400).json(data);
    }
    return res.json(data);
  } catch (e) {
    console.error('[calendar/forecast]', e);
    return res.status(500).json({ ok: false, message: e.message || 'server_error' });
  }
});

router.get('/calendar/data', async (req, res) => {
  try {
    const userId = req.user.id;
    const accountId = Number(req.query.accountId || 0);
    const month = String(req.query.month || '').trim();
    const day = String(req.query.day || '').trim();
    const historyPage = Math.max(1, Number(req.query.historyPage || 1));
    const data = await fetchCalendarPerformance(userId, {
      accountId,
      month,
      day,
      historyPage
    });
    if (!data.ok) {
      return res.status(data.message === 'account_not_found' ? 404 : 400).json(data);
    }
    return res.json(data);
  } catch (e) {
    console.error('[calendar/data]', e);
    return res.status(500).json({ ok: false, message: e.message || 'server_error' });
  }
});

router.get('/status', async (req, res) => {
  const base = await getBaseData(req);
  return res.render('app/status', {
    pageTitle: 'Account Status',
    currentPath: '/app/status',
    ...flash(req),
    ...base
  });
});

router.get('/security', async (req, res) => {
  const base = await getBaseData(req);
  if (!base.canChangePassword) {
    req.session.error = 'เมนูนี้แสดงเฉพาะผู้สมัครผ่านเว็บ';
  }
  return res.render('app/security', {
    pageTitle: 'Security',
    currentPath: '/app/security',
    ...flash(req),
    ...base
  });
});

router.post('/security/change-password', async (req, res) => {
  try {
    const base = await getBaseData(req);

    if (!base.canChangePassword) {
      req.session.error = 'บัญชี Google / LINE ไม่สามารถเปลี่ยนรหัสผ่านในระบบนี้ได้';
      return res.redirect('/app/security');
    }

    const currentPassword = normalizeText(req.body.current_password);
    const newPassword = normalizeText(req.body.new_password);
    const confirmPassword = normalizeText(req.body.confirm_password);

    if (!currentPassword || !newPassword || !confirmPassword) {
      req.session.error = 'กรุณากรอกข้อมูลให้ครบ';
      return res.redirect('/app/security');
    }

    if (newPassword !== confirmPassword) {
      req.session.error = 'รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน';
      return res.redirect('/app/security');
    }

    if (newPassword.length < 6) {
      req.session.error = 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร';
      return res.redirect('/app/security');
    }

    const userRes = await query(
      `SELECT * FROM users WHERE id = $1 LIMIT 1`,
      [base.user.id]
    );

    const user = userRes.rows[0];

    if (!user || !user.password) {
      req.session.error = 'ไม่พบรหัสผ่านเดิมในระบบ';
      return res.redirect('/app/security');
    }

    const ok = await bcrypt.compare(currentPassword, user.password);

    if (!ok) {
      req.session.error = 'รหัสผ่านเดิมไม่ถูกต้อง';
      return res.redirect('/app/security');
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    await query(
      `UPDATE users
       SET password = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [base.user.id, newHash]
    );

    req.session.success = 'เปลี่ยนรหัสผ่านสำเร็จ';
    return res.redirect('/app/security');
  } catch (error) {
    console.error('change password error:', error);
    req.session.error = 'เปลี่ยนรหัสผ่านไม่สำเร็จ';
    return res.redirect('/app/security');
  }
});

async function sendDeleteAccountOtpEmail({ email, code }) {
  await sendMailSafe({
    to: email,
    subject: 'OTP ยืนยันการลบบัญชี TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7">
        <h2>ยืนยันการลบบัญชี</h2>
        <p>รหัส OTP ของคุณคือ</p>
        <h1 style="letter-spacing:6px">${code}</h1>
        <p>รหัสนี้มีอายุ 10 นาที</p>
      </div>
    `
  });
}

router.get('/delete-account', async (req, res) => {
  const base = await getBaseData(req);

  return res.render('app/delete-account', {
    pageTitle: 'Delete Account',
    currentPath: '/app/status',
    ...flash(req),
    ...base
  });
});

router.post('/delete-account/request-otp', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await query(
      `INSERT INTO email_otps (
        user_id,
        email,
        otp_code,
        ref_type,
        ref_id,
        purpose,
        expires_at,
        used_at,
        created_at
      )
      VALUES ($1,$2,$3,'delete_account',$1,'delete_account',$4,NULL,NOW())`,
      [base.user.id, base.user.email, otpCode, expiresAt]
    );

    await sendDeleteAccountOtpEmail({
      email: base.user.email,
      code: otpCode
    });

    req.session.success = 'ส่ง OTP ไปยังอีเมลแล้ว';
    return res.redirect('/app/delete-account');
  } catch (error) {
    console.error('delete account otp error:', error);
    req.session.error = 'ส่ง OTP ไม่สำเร็จ';
    return res.redirect('/app/delete-account');
  }
});

router.post('/delete-account/confirm', async (req, res) => {
  try {
    const base = await getBaseData(req);
    const userId = base.user.id;
    const otpCode = normalizeText(req.body.otp_code);

    const otpRes = await query(
      `SELECT *
       FROM email_otps
       WHERE user_id = $1
         AND purpose = 'delete_account'
         AND used_at IS NULL
       ORDER BY id DESC
       LIMIT 1`,
      [userId]
    );

    const otp = otpRes.rows[0];

    if (!otp) {
      req.session.error = 'ไม่พบ OTP กรุณาขอรหัสใหม่';
      return res.redirect('/app/delete-account');
    }

    if (String(otp.otp_code) !== String(otpCode)) {
      req.session.error = 'OTP ไม่ถูกต้อง';
      return res.redirect('/app/delete-account');
    }

    if (!otp.expires_at || new Date(otp.expires_at).getTime() < Date.now()) {
      req.session.error = 'OTP หมดอายุ กรุณาขอรหัสใหม่';
      return res.redirect('/app/delete-account');
    }

    const userRes = await query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const user = userRes.rows[0];
    const scoinBalance = Number(user?.scoin_balance || 0);

    if (scoinBalance > 0) {
      await query(
        `INSERT INTO system_wallets (wallet_type, wallet_code, balance, created_at, updated_at)
         VALUES ('host_scoin','HOST-SCOIN-WALLET',$1,NOW(),NOW())
         ON CONFLICT (wallet_type)
         DO UPDATE SET balance = COALESCE(system_wallets.balance,0) + EXCLUDED.balance,
                       updated_at = NOW()`,
        [scoinBalance]
      ).catch(() => {});
    }

    await query(`UPDATE email_otps SET used_at = NOW() WHERE id = $1`, [otp.id]).catch(() => {});
    await query(`DELETE FROM bot_sessions WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM user_broker_accounts WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM user_bank_accounts WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM user_identity_verifications WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM scoin_market_orders WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM scoin_wallets WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM scoin_transactions WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM user_subscriptions WHERE user_id = $1`, [userId]).catch(() => {});
    await query(`DELETE FROM payments WHERE user_id = $1`, [userId]).catch(() => {});

    // ถ้ามีคนที่ user นี้เคยแนะนำไว้ ให้ตัดสายออกก่อน ไม่งั้น FK อาจลบไม่ได้
await query(
  `UPDATE users
   SET referred_by_user_id = NULL,
       updated_at = NOW()
   WHERE referred_by_user_id = $1`,
  [userId]
).catch(() => {});

// ลบข้อมูล user ออกจากระบบจริง
await query(
  `DELETE FROM users WHERE id = $1`,
  [userId]
);

    req.session.destroy(() => {});
    return res.redirect('/login?deleted=1');
  } catch (error) {
    console.error('delete account confirm error:', error);
    req.session.error = 'ลบบัญชีไม่สำเร็จ';
    return res.redirect('/app/delete-account');
  }
});
router.post('/kbank/package-webhook', async (req, res) => {
  try {
    if (!(await verifyKbankWebhook(req))) {
      return res.status(401).json({ ok: false, error: 'invalid signature' });
    }

    const body = req.body || {};
    const paymentRef =
      body.order_id ||
      body.reference_order ||
      body.payment_ref ||
      body.ref ||
      body.id ||
      '';

    const paidStatus = String(
      body.status ||
      body.payment_status ||
      body.transaction_state ||
      ''
    ).toLowerCase();

    const isPaid = ['paid', 'success', 'successful', 'approved', 'completed'].includes(paidStatus);

    if (!paymentRef || !isPaid) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const paymentRes = await query(
      `SELECT *
       FROM payments
       WHERE payment_ref = $1
         AND package_id IS NOT NULL
       LIMIT 1`,
      [paymentRef]
    );

    const payment = paymentRes.rows[0];

    if (!payment) {
      return res.status(200).json({ ok: true, ignored: 'payment not found' });
    }

    if (String(payment.payment_status) === 'paid') {
      return res.status(200).json({ ok: true, already_paid: true });
    }

    await activatePackagePayment(payment.id, body);

    return res.status(200).json({ ok: true, auto_confirmed: true });
  } catch (error) {
    console.error('kbank package webhook error:', error);
    return res.status(500).json({ ok: false });
  }
});


module.exports = router;
