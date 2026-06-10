require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const passport = require('passport');
const { query } = require('../config/database');
const { requireGuest, requireLogin } = require('../middleware/requireAuth');
const { markSessionActive } = require('../middleware/sessionIdleTimeout');
const { invalidateUserCache, setCachedUser } = require('../lib/userCache');
const { sendMailSafe } = require('../services/mailService');
const {
  ensureUserReferralCode
} = require('../services/scoinService');
const { translate, normalizeLocale } = require('../services/i18n');

const router = express.Router();

function reqLang(req) {
  return normalizeLocale(req.session?.lang || req.lang || 'th');
}

function authT(req, key, fallback = '') {
  return translate(reqLang(req), key, fallback);
}

function renderLogin(req, res, extra = {}) {
  return res.render('login', {
    error: '',
    success: '',
    lang: reqLang(req),
    ...extra
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validatePassword(password) {
  const errors = [];

  if (password.length < 6) {
    errors.push('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('ต้องมีตัวอักษรภาษาอังกฤษตัวใหญ่ อย่างน้อย 1 ตัว');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('ต้องมีตัวอักษรภาษาอังกฤษตัวเล็ก อย่างน้อย 1 ตัว');
  }

  if (!/[!@#$%^&*(),.?":{}|<>_\-+=\[\]\\\/]/.test(password)) {
    errors.push('ต้องมีอักขระพิเศษ อย่างน้อย 1 ตัว');
  }

  return errors;
}

function baseView(req, extra = {}) {
  return {
    error: req.session.error || '',
    success: req.session.success || '',
    user: req.user || req.session.user || null,
    lang: reqLang(req),
    ...extra
  };
}

function clearFlash(req) {
  req.session.error = '';
  req.session.success = '';
}

function appBaseUrl() {
  return process.env.APP_BASE_URL || process.env.BASE_URL || 'https://trading.avelqua.com';
}

function buildVerifyUrl(token) {
  return `${appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

function lineAuthConfigReady() {
  return !!(
    process.env.LINE_CLIENT_ID &&
    process.env.LINE_CLIENT_SECRET &&
    process.env.LINE_CALLBACK_URL
  );
}

function buildLineAuthorizeUrl(state) {
  const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.LINE_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.LINE_CALLBACK_URL);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'profile openid email');
  return url.toString();
}

function readReferralCode(req) {
  return String(
    req.body?.ref ||
    req.query?.ref ||
    req.session?.referralCode ||
    req.cookies?.referralCode ||
    ''
  ).trim().toUpperCase();
}

function persistReferralCode(req, res, code) {
  const ref = String(code || '').trim().toUpperCase();
  if (!ref) return;

  req.session.referralCode = ref;
  res.cookie('referralCode', ref, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
}

function clearReferralCode(req, res) {
  if (req.session) req.session.referralCode = '';
  res.clearCookie('referralCode');
}

async function resolveReferralUserId(referralCode, currentUserId = null) {
  const code = String(referralCode || '').trim();
  if (!code) return null;

  const result = await query(
    `SELECT id
     FROM users
     WHERE UPPER(COALESCE(referral_code, '')) = UPPER($1)
     LIMIT 1`,
    [code]
  );

  const sponsor = result.rows[0];
  if (!sponsor) return null;

  if (currentUserId && Number(sponsor.id) === Number(currentUserId)) {
    return null;
  }

  return sponsor.id;
}

async function exchangeLineCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.LINE_CALLBACK_URL,
    client_id: process.env.LINE_CLIENT_ID,
    client_secret: process.env.LINE_CLIENT_SECRET
  });

  const response = await fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'LINE token exchange failed');
  }

  return data;
}

async function verifyLineIdToken(idToken) {
  const body = new URLSearchParams({
    id_token: idToken,
    client_id: process.env.LINE_CLIENT_ID
  });

  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'LINE ID token verify failed');
  }

  return data;
}

async function sendVerifyEmail({ email, name, token }) {
  const verifyUrl = buildVerifyUrl(token);

  await sendMailSafe({
    to: email,
    subject: 'ยืนยันอีเมลก่อนเข้าใช้งาน TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#0f172a">
        <h2>ยืนยันอีเมลของคุณ</h2>
        <p>สวัสดี ${name || email}</p>
        <p>กรุณากดยืนยันอีเมลก่อนเข้าสู่ระบบใช้งาน</p>
        <p>
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:10px">
            ยืนยันอีเมล
          </a>
        </p>
        <p>หากปุ่มกดไม่ได้ ให้เปิดลิงก์นี้:</p>
        <p>${verifyUrl}</p>
        <p>ลิงก์นี้มีอายุ 24 ชั่วโมง</p>
      </div>
    `
  });
}

async function sendResetPasswordEmail({ email, token }) {
  const resetUrl = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;

  await sendMailSafe({
    to: email,
    subject: 'รีเซ็ตรหัสผ่าน TRADING AVELQUA',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.7;color:#0f172a">
        <h2>รีเซ็ตรหัสผ่าน</h2>
        <p>มีคำขอรีเซ็ตรหัสผ่านสำหรับบัญชี ${email}</p>
        <p>กดปุ่มด้านล่างเพื่อกำหนดรหัสผ่านใหม่</p>
        <p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:10px">
            ตั้งรหัสผ่านใหม่
          </a>
        </p>
        <p>หากปุ่มกดไม่ได้ ให้เปิดลิงก์นี้:</p>
        <p>${resetUrl}</p>
        <p>ลิงก์นี้มีอายุ 30 นาที</p>
      </div>
    `
  });
}

/* =========================
   LOGIN / REGISTER
========================= */

router.get('/login', requireGuest, (req, res) => {
  const view = baseView(req);
  clearFlash(req);
  if (String(req.query.reason || '') === 'idle') {
    view.error = authT(
      req,
      'login.error.idle_logout',
      'ออกจากระบบอัตโนมัติเนื่องจากไม่มีการใช้งาน 2 ชั่วโมง เพื่อความปลอดภัย'
    );
  }
  return res.render('login', view);
});

router.post('/login', requireGuest, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const result = await query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    const user = result.rows[0];

    if (!user) {
      return renderLogin(req, res, { error: authT(req, 'login.error.account_not_found', 'ไม่พบบัญชี') });
    }

    if (String(user.status || 'active') === 'banned' || String(user.status || '') === 'disabled') {
      return renderLogin(req, res, { error: authT(req, 'login.error.account_banned', 'บัญชีนี้ถูกระงับการใช้งาน') });
    }

    if (!user.password_hash) {
      return renderLogin(req, res, { error: authT(req, 'login.error.oauth_only', 'บัญชีนี้เข้าสู่ระบบด้วย Google หรือ LINE') });
    }

    if (!user.email_verified) {
      return renderLogin(req, res, {
        error: authT(req, 'login.error.email_not_verified', 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ'),
        unverifiedEmail: user.email
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return renderLogin(req, res, { error: authT(req, 'login.error.wrong_password', 'รหัสผ่านไม่ถูกต้อง') });
    }

    await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [user.id]).catch(() => {});

    req.login(user, (err) => {
      if (err) {
        return renderLogin(req, res, { error: authT(req, 'login.error.login_failed', 'เข้าสู่ระบบไม่สำเร็จ') });
      }
      invalidateUserCache(user.id);
      setCachedUser(user.id, user);
      req.session.user = user;
      markSessionActive(req);
      return res.redirect(String(user.role || 'user') === 'admin' ? '/admin' : '/app');
    });
  } catch (error) {
    console.error(error);
    return renderLogin(req, res, { error: authT(req, 'login.error.system_error', 'ระบบผิดพลาด') });
  }
});

router.get('/register', requireGuest, (req, res) => {
  const ref = readReferralCode(req);

  if (ref) {
    persistReferralCode(req, res, ref);
  }

  return res.render('register', {
    error: '',
    success: '',
    lang: req.session?.lang || 'th',
    ref
  });
});

router.post('/register', requireGuest, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const name = email.split('@')[0];
    const referralCode = readReferralCode(req);

    if (!email || !password) {
      return res.render('register', {
        error: 'กรุณากรอกข้อมูลให้ครบ',
        success: '',
        lang: req.session?.lang || 'th',
        ref: referralCode
      });
    }

    const passwordErrors = validatePassword(password);
    if (passwordErrors.length > 0) {
      return res.render('register', {
        error: passwordErrors.join('<br>'),
        success: '',
        lang: req.session?.lang || 'th',
        ref: referralCode
      });
    }

    const exists = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1`,
      [email]
    );

    if (exists.rows.length) {
      return res.render('register', {
        error: 'อีเมลนี้ถูกใช้แล้ว',
        success: '',
        lang: req.session?.lang || 'th',
        ref: referralCode
      });
    }

    const referredByUserId = await resolveReferralUserId(referralCode);

    const hash = await bcrypt.hash(password, 10);
    const verifyToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const createdUserRes = await query(
  `INSERT INTO users (
    email,
    password_hash,
    role,
    provider,
    status,
    full_name,
    first_name,
    email_verified,
    verify_token,
    verify_token_expires_at,
    referred_by_user_id
  )
  VALUES ($1,$2,'user','local','pending_verification',$3,$4,FALSE,$5,$6,$7)
  RETURNING id`,
  [email, hash, name, name, verifyToken, verifyExpiresAt, referredByUserId]
);

const createdUserId = createdUserRes.rows[0]?.id || null;

if (createdUserId) {
  await ensureUserReferralCode(createdUserId);

  if (referredByUserId) {
    await query(
      `UPDATE users
       SET referred_by_user_id = COALESCE(referred_by_user_id, $2)
       WHERE id = $1`,
      [createdUserId, referredByUserId]
    );
  }
}

    clearReferralCode(req, res);

    await sendVerifyEmail({
      email,
      name,
      token: verifyToken
    });

    req.session.success = 'สมัครสมาชิกสำเร็จ กรุณาตรวจสอบอีเมลและกดยืนยันก่อนเข้าสู่ระบบ';
    return res.redirect('/login');
  } catch (error) {
    console.error(error);
    return res.render('register', {
      error: error.message || 'สมัครไม่สำเร็จ',
      success: '',
      lang: req.session?.lang || 'th',
      ref: String(req.body.ref || req.session.referralCode || '').trim().toUpperCase()
    });
  }
});

router.get('/verify-email', requireGuest, async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();

    if (!token) {
      req.session.error = authT(req, 'login.error.verify_link_invalid', 'ลิงก์ยืนยันไม่ถูกต้อง');
      return res.redirect('/login');
    }

    const result = await query(
      `SELECT id, email
       FROM users
       WHERE verify_token = $1
         AND verify_token_expires_at IS NOT NULL
         AND verify_token_expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    const user = result.rows[0];

    if (!user) {
      req.session.error = authT(req, 'login.error.verify_link_expired', 'ลิงก์ยืนยันหมดอายุหรือไม่ถูกต้อง');
      return res.redirect('/login');
    }

    await query(
      `UPDATE users
       SET email_verified = TRUE,
           verified_at = NOW(),
           status = 'active',
           verify_token = NULL,
           verify_token_expires_at = NULL
       WHERE id = $1`,
      [user.id]
    );

    req.session.success = authT(req, 'login.success.email_verified', 'ยืนยันอีเมลสำเร็จ ตอนนี้คุณสามารถเข้าสู่ระบบได้แล้ว');
    return res.redirect('/login');
  } catch (error) {
    console.error(error);
    req.session.error = authT(req, 'login.error.verify_failed', 'ยืนยันอีเมลไม่สำเร็จ');
    return res.redirect('/login');
  }
});

router.post('/resend-verification', requireGuest, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return renderLogin(req, res, { error: authT(req, 'login.error.email_required', 'กรุณากรอกอีเมลก่อน') });
    }

    const result = await query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    const user = result.rows[0];

    if (!user) {
      return renderLogin(req, res, { error: authT(req, 'login.error.email_not_found_resend', 'ไม่พบบัญชีอีเมลนี้') });
    }

    if (user.email_verified) {
      return renderLogin(req, res, {
        success: authT(req, 'login.success.email_already_verified', 'อีเมลนี้ยืนยันแล้ว สามารถเข้าสู่ระบบได้เลย')
      });
    }

    const verifyToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await query(
      `UPDATE users
       SET verify_token = $1,
           verify_token_expires_at = $2
       WHERE id = $3`,
      [verifyToken, verifyExpiresAt, user.id]
    );

    await sendVerifyEmail({
      email: user.email,
      name: user.full_name || user.first_name || '',
      token: verifyToken
    });

    return renderLogin(req, res, {
      success: authT(req, 'login.success.verification_resent', 'ส่งอีเมลยืนยันใหม่แล้ว กรุณาตรวจสอบกล่องจดหมาย'),
      unverifiedEmail: user.email
    });
  } catch (error) {
    console.error(error);
    return renderLogin(req, res, {
      error: authT(req, 'login.error.verification_resend_failed', 'ส่งอีเมลยืนยันใหม่ไม่สำเร็จ')
    });
  }
});

/* =========================
   GOOGLE LOGIN
========================= */

router.get('/auth/google', requireGuest, (req, res, next) => {
const ref = readReferralCode(req);
if (ref) {
  persistReferralCode(req, res, ref);
}
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALLBACK_URL) {
    req.session.error = authT(req, 'login.error.google_not_configured', 'ยังไม่ได้ตั้งค่า Google Login');
    return res.redirect('/login');
  }

  return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

router.get('/auth/google/callback', requireGuest, (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALLBACK_URL) {
    req.session.error = authT(req, 'login.error.google_not_configured', 'ยังไม่ได้ตั้งค่า Google Login');
    return res.redirect('/login');
  }

  return passport.authenticate('google', {
    failureRedirect: '/login'
  })(req, res, next);
}, async (req, res) => {
  try {
    const referralCode = readReferralCode(req);

    if (req.user?.id) {
      await ensureUserReferralCode(req.user.id);

      const sponsorId = await resolveReferralUserId(referralCode, req.user.id);

      if (sponsorId) {
        await query(
          `UPDATE users
           SET referred_by_user_id = COALESCE(referred_by_user_id, $2)
           WHERE id = $1`,
          [req.user.id, sponsorId]
        );

        const updatedUser = await query(
          `SELECT * FROM users WHERE id = $1 LIMIT 1`,
          [req.user.id]
        );

        if (updatedUser.rows[0]) {
          req.user = updatedUser.rows[0];
        }
      }
    }

    clearReferralCode(req, res);
    req.session.user = req.user;
    markSessionActive(req);
    return res.redirect(String(req.user?.role || 'user') === 'admin' ? '/admin' : '/app');
  } catch (error) {
    console.error('GOOGLE referral attach error:', error);
    req.session.user = req.user;
    markSessionActive(req);
    return res.redirect(String(req.user?.role || 'user') === 'admin' ? '/admin' : '/app');
  }
});

/* =========================
   LINE LOGIN
========================= */

router.get('/auth/line', requireGuest, (req, res) => {
const ref = readReferralCode(req);
if (ref) {
  persistReferralCode(req, res, ref);
}
  try {
    if (!lineAuthConfigReady()) {
      req.session.error = authT(req, 'login.error.line_not_configured', 'ยังไม่ได้ตั้งค่า LINE Login');
      return res.redirect('/login');
    }

    const state = randomUUID().replace(/-/g, '');
    req.session.lineAuthState = state;

    return res.redirect(buildLineAuthorizeUrl(state));
  } catch (error) {
    console.error('LINE auth start error:', error);
    req.session.error = authT(req, 'login.error.line_start_failed', 'เริ่มต้น LINE Login ไม่สำเร็จ');
    return res.redirect('/login');
  }
});

router.get('/auth/line/callback', requireGuest, async (req, res) => {
  try {
    if (!lineAuthConfigReady()) {
      req.session.error = authT(req, 'login.error.line_not_configured', 'ยังไม่ได้ตั้งค่า LINE Login');
      return res.redirect('/login');
    }

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const savedState = String(req.session.lineAuthState || '');

    req.session.lineAuthState = '';

    if (!code || !state || !savedState || state !== savedState) {
      req.session.error = authT(req, 'login.error.line_callback_invalid', 'LINE callback ไม่ถูกต้อง');
      return res.redirect('/login');
    }

    const tokenData = await exchangeLineCodeForToken(code);

    if (!tokenData.id_token) {
      req.session.error = authT(req, 'login.error.line_no_token', 'ไม่ได้รับ LINE ID token');
      return res.redirect('/login');
    }

    const lineProfile = await verifyLineIdToken(tokenData.id_token);

    const lineUid = String(lineProfile.sub || '').trim();
    const email = normalizeEmail(lineProfile.email || '');
    const fullName = String(lineProfile.name || '').trim();

    if (!lineUid) {
      req.session.error = authT(req, 'login.error.line_profile_failed', 'ไม่สามารถอ่านข้อมูลบัญชี LINE ได้');
      return res.redirect('/login');
    }

    let user = null;

    const byLine = await query(
      `SELECT * FROM users WHERE provider_uid = $1 OR line_id = $1 LIMIT 1`,
      [lineUid]
    );
    user = byLine.rows[0] || null;

    if (!user && email) {
      const byEmail = await query(
        `SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [email]
      );
      user = byEmail.rows[0] || null;
    }

    if (!user) {
      const created = await query(
        `INSERT INTO users (
          email, password_hash, role, provider, provider_uid, line_id,
          status, full_name, first_name, email_verified, verified_at
        )
        VALUES ($1, '', 'user', 'line', $2, $2, 'active', $3, $3, TRUE, NOW())
        RETURNING *`,
        [email, lineUid, fullName]
      );
      user = created.rows[0];
    }

    await query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`,
      [user.id]
    ).catch(() => {});

    req.login(user, async (err) => {
      if (err) {
        console.error('LINE req.login error:', err);
        req.session.error = authT(req, 'login.error.line_login_failed', 'เข้าสู่ระบบ LINE ไม่สำเร็จ');
        return res.redirect('/login');
      }

      try {
        const referralCode = readReferralCode(req);

        if (user?.id) {
          await ensureUserReferralCode(user.id);

          const sponsorId = await resolveReferralUserId(referralCode, user.id);

          if (sponsorId) {
            await query(
              `UPDATE users
               SET referred_by_user_id = COALESCE(referred_by_user_id, $2)
               WHERE id = $1`,
              [user.id, sponsorId]
            );
          }
        }
      } catch (attachError) {
        console.error('LINE referral attach error:', attachError);
      }

      clearReferralCode(req, res);
      req.session.user = user;
      markSessionActive(req);
      return res.redirect('/app');
    });

  } catch (error) {
    console.error('LINE callback error:', error);
    req.session.error = error.message || authT(req, 'login.error.line_login_failed', 'เข้าสู่ระบบ LINE ไม่สำเร็จ');
    return res.redirect('/login');
  }
});

/* =========================
   FORGOT / RESET PASSWORD
========================= */

router.get('/forgot-password', requireGuest, (req, res) => {
  return res.render('forgot-password', {
    error: '',
    success: '',
    lang: req.session?.lang || 'th'
  });
});

router.post('/forgot-password', requireGuest, async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.render('forgot-password', {
        error: 'กรุณากรอกอีเมล',
        success: '',
        lang: req.session?.lang || 'th'
      });
    }

    const result = await query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
    const user = result.rows[0];

    if (!user) {
      return res.render('forgot-password', {
        error: 'ไม่พบบัญชีอีเมลนี้',
        success: '',
        lang: req.session?.lang || 'th'
      });
    }

    if (!user.password_hash) {
      return res.render('forgot-password', {
        error: 'บัญชีนี้เข้าสู่ระบบด้วย Google หรือ LINE',
        success: '',
        lang: req.session?.lang || 'th'
      });
    }

    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

    await query(`DELETE FROM password_change_requests WHERE email = $1 OR expires_at < NOW()`, [user.email]).catch(() => {});
    await query(
      `INSERT INTO password_change_requests (user_id, email, token, new_password_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 minute')`,
      [user.id, user.email || '', token, user.password_hash || '']
    );

    await sendResetPasswordEmail({
      email: user.email,
      token
    });

    req.session.success = 'ส่งลิงก์รีเซ็ตรหัสผ่านไปที่อีเมลแล้ว กรุณาตรวจสอบอีเมล';
    req.session.error = '';
    return res.redirect('/login');
  } catch (error) {
    console.error(error);
    return res.render('forgot-password', {
      error: 'ไม่สามารถส่งอีเมลรีเซ็ตได้',
      success: '',
      lang: req.session?.lang || 'th'
    });
  }
});

router.get('/reset-password', requireGuest, (req, res) => {
  return res.render('reset-password', {
    error: '',
    success: '',
    token: String(req.query.token || ''),
    lang: req.session?.lang || 'th'
  });
});

router.post('/reset-password', requireGuest, async (req, res) => {
  try {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');

    if (!token) {
      return res.render('reset-password', {
        error: 'ลิงก์รีเซ็ตไม่ถูกต้อง',
        success: '',
        token: '',
        lang: req.session?.lang || 'th'
      });
    }

    const passwordErrors = validatePassword(password);
    if (passwordErrors.length > 0) {
      return res.render('reset-password', {
        error: passwordErrors.join('<br>'),
        success: '',
        token,
        lang: req.session?.lang || 'th'
      });
    }

    const result = await query(
      `SELECT * FROM password_change_requests
       WHERE token = $1
         AND used_at IS NULL
         AND expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    const requestRow = result.rows[0];
    if (!requestRow) {
      return res.render('reset-password', {
        error: 'ลิงก์รีเซ็ตหมดอายุหรือถูกใช้งานแล้ว',
        success: '',
        token: '',
        lang: req.session?.lang || 'th'
      });
    }

    const newHash = await bcrypt.hash(password, 10);
    await query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [requestRow.user_id, newHash]);
    await query(`UPDATE password_change_requests SET used_at = NOW(), new_password_hash = $2 WHERE id = $1`, [requestRow.id, newHash]);

    req.session.success = 'ตั้งรหัสผ่านใหม่สำเร็จ กรุณาเข้าสู่ระบบ';
    return res.redirect('/login');
  } catch (error) {
    console.error(error);
    return res.render('reset-password', {
      error: 'ตั้งรหัสผ่านใหม่ไม่สำเร็จ',
      success: '',
      token: String(req.body.token || ''),
      lang: req.session?.lang || 'th'
    });
  }
});

/* =========================
   CHANGE PASSWORD AFTER LOGIN
========================= */

router.post('/security/password', requireLogin, async (req, res) => {
  try {
    const user = req.user || req.session.user;
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    const result = await query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [user.id]);
    const row = result.rows[0];
    if (!row) {
      req.session.error = 'ไม่พบบัญชีผู้ใช้';
      return res.redirect('/app/security');
    }

    if (String(row.provider || 'local') !== 'local') {
      req.session.error = 'เมนูนี้ใช้ได้เฉพาะผู้สมัครผ่านเว็บ';
      return res.redirect('/app/security');
    }

    const passwordErrors = validatePassword(newPassword);
    if (passwordErrors.length > 0) {
      req.session.error = passwordErrors.join(', ');
      return res.redirect('/app/security');
    }

    if (newPassword !== confirmPassword) {
      req.session.error = 'ยืนยันรหัสผ่านใหม่ไม่ตรงกัน';
      return res.redirect('/app/security');
    }

    const token = randomUUID();
    const newHash = await bcrypt.hash(newPassword, 10);

    await query(`DELETE FROM password_change_requests WHERE user_id = $1 OR expires_at < NOW()`, [user.id]).catch(() => {});
    await query(
      `INSERT INTO password_change_requests (user_id, email, token, new_password_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 minute')`,
      [user.id, row.email || '', token, newHash]
    );

    const verifyUrl = `${appBaseUrl()}/security/password/verify?token=${encodeURIComponent(token)}`;
    await sendMailSafe({
      to: row.email,
      subject: 'ยืนยันการเปลี่ยนรหัสผ่าน TRADING AVELQUA',
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.7;color:#0f172a">
          <h2>ยืนยันการเปลี่ยนรหัสผ่าน</h2>
          <p>มีคำขอเปลี่ยนรหัสผ่านสำหรับบัญชี ${row.email}</p>
          <p>กดปุ่มด้านล่างเพื่อยืนยันภายใน 30 นาที</p>
          <p><a href="${verifyUrl}" style="display:inline-block;padding:12px 18px;background:#111827;color:#fff;text-decoration:none;border-radius:10px">ยืนยันการเปลี่ยนรหัสผ่าน</a></p>
          <p>หากคุณไม่ได้เป็นผู้ร้องขอ กรุณาเพิกเฉยต่ออีเมลฉบับนี้</p>
          <p>${verifyUrl}</p>
        </div>
      `
    });

    req.session.success = 'ส่งลิงก์ยืนยันการเปลี่ยนรหัสผ่านไปที่อีเมลแล้ว';
    return res.redirect('/app/security');
  } catch (error) {
    console.error(error);
    req.session.error = 'เปลี่ยนรหัสผ่านไม่สำเร็จ';
    return res.redirect('/app/security');
  }
});

router.get('/security/password/verify', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) {
      req.session.error = 'ลิงก์ยืนยันไม่ถูกต้อง';
      return res.redirect('/login');
    }

    const result = await query(
      `SELECT * FROM password_change_requests WHERE token = $1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [token]
    );
    const requestRow = result.rows[0];
    if (!requestRow) {
      req.session.error = 'ลิงก์ยืนยันหมดอายุหรือถูกใช้งานแล้ว';
      return res.redirect('/login');
    }

    await query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [requestRow.user_id, requestRow.new_password_hash]);
    await query(`UPDATE password_change_requests SET used_at = NOW() WHERE id = $1`, [requestRow.id]);

    req.session.success = 'ยืนยันการเปลี่ยนรหัสผ่านเรียบร้อยแล้ว กรุณาเข้าสู่ระบบใหม่';
    return res.redirect('/login');
  } catch (error) {
    console.error(error);
    req.session.error = 'ยืนยันการเปลี่ยนรหัสผ่านไม่สำเร็จ';
    return res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.logout?.(() => {});
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;