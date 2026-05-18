require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const passport = require('passport');

const { requireGuest, requireLogin } = require('../middleware/requireAuth');

const router = express.Router();
const DATA_FILE = path.join(__dirname, '..', 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {
      users: [],
      packages: [],
      ports: [],
      orders: [],
      payments: [],
      siteContent: {},
      news: [],
      communityPosts: [],
      passwordResetTokens: [],
      emailVerifyTokens: [],
      coupons: [],
      vpsNodes: []
    };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function generateId(prefix = '') {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 100000)}`;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
}

function isAdminEmail(email) {
  return getAdminEmails().includes(normalizeEmail(email));
}

function getRedirectByRole(user) {
  return String(user?.role || 'user') === 'admin' ? '/admin' : '/app';
}

function upsertRoleFromEmail(user) {
  const email = normalizeEmail(user?.email);
  if (email && isAdminEmail(email)) {
    user.role = 'admin';
  } else if (!user.role) {
    user.role = 'user';
  }
  return user;
}

router.get('/login', requireGuest, (req, res) => {
  const error = req.session?.authError || '';
  req.session.authError = '';

  return res.render('login', { error });
});

router.get(
  '/auth/google',
  requireGuest,
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })
);

router.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/login',
    failureMessage: false
  }),
  (req, res) => {
    try {
      const db = loadData();
      const user = (db.users || []).find(
        (u) => String(u.id) === String(req.user?.id)
      );

      if (user) {
        upsertRoleFromEmail(user);
        saveData(db);
        req.user.role = user.role;
      }

      return res.redirect(getRedirectByRole(req.user));
    } catch (err) {
      console.error('Google callback role update error:', err);
      return res.redirect(getRedirectByRole(req.user));
    }
  }
);

router.get('/auth/line', requireGuest, (req, res) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    const nonce = crypto.randomBytes(24).toString('hex');

    req.session.lineState = state;
    req.session.lineNonce = nonce;

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.LINE_CHANNEL_ID || '',
      redirect_uri: process.env.LINE_CALLBACK_URL || '',
      state,
      scope: 'profile openid email',
      nonce
    });

    const url = `https://access.line.me/oauth2/v2.1/authorize?${params.toString()}`;
    return res.redirect(url);
  } catch (err) {
    console.error('LINE auth start error:', err);
    req.session.authError = 'LINE login เริ่มต้นไม่สำเร็จ';
    return res.redirect('/login');
  }
});

router.get('/auth/line/callback', requireGuest, async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      req.session.authError = error_description || 'LINE login ไม่สำเร็จ';
      return res.redirect('/login');
    }

    if (!code || !state || state !== req.session.lineState) {
      req.session.authError = 'LINE state ไม่ถูกต้อง';
      return res.redirect('/login');
    }

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: process.env.LINE_CALLBACK_URL || '',
      client_id: process.env.LINE_CHANNEL_ID || '',
      client_secret: process.env.LINE_CHANNEL_SECRET || ''
    });

    const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('LINE token error:', tokenData);
      req.session.authError = 'แลก LINE token ไม่สำเร็จ';
      return res.redirect('/login');
    }

    let profileData = {};
    let idTokenData = {};

    const profileRes = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    if (profileRes.ok) {
      profileData = await profileRes.json();
    }

    if (tokenData.id_token) {
      const verifyParams = new URLSearchParams({
        id_token: tokenData.id_token,
        client_id: process.env.LINE_CHANNEL_ID || ''
      });

      const verifyRes = await fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verifyParams.toString()
      });

      if (verifyRes.ok) {
        idTokenData = await verifyRes.json();
      }
    }

    const lineId = String(idTokenData.sub || profileData.userId || '').trim();
    const displayName = String(idTokenData.name || profileData.displayName || 'LINE User').trim();
    const email = normalizeEmail(idTokenData.email || '');

    if (!lineId) {
      req.session.authError = 'ไม่พบ LINE User ID';
      return res.redirect('/login');
    }

    const db = loadData();

    let user = (db.users || []).find(
      (u) =>
        String(u.lineId || '') === lineId ||
        (email && normalizeEmail(u.email) === email)
    );

    if (!user) {
      user = {
        id: generateId('u_'),
        firstName: '',
        lastName: '',
        name: displayName || 'LINE User',
        email,
        phone: '',
        address: '',
        password: '',
        role: isAdminEmail(email) ? 'admin' : 'user',
        provider: 'line',
        emailVerified: !!email,
        verifyToken: '',
        status: 'active',
        googleId: '',
        lineId,
        createdAt: new Date().toISOString(),
        activePackageId: null,
        activePackageName: null,
        packageStartAt: null,
        packageEndAt: null,
        lotMin: 0,
        lotMax: 0,
        portMin: 0,
        portMax: 0,
        packageHistory: []
      };
      db.users.push(user);
    } else {
      user.provider = user.provider || 'line';
      user.lineId = lineId;
      if (!user.name && displayName) user.name = displayName;
      if (!user.email && email) user.email = email;
      if (email) user.emailVerified = true;
      upsertRoleFromEmail(user);
    }

    saveData(db);

    req.session.lineState = null;
    req.session.lineNonce = null;

    req.login(user, (err) => {
      if (err) {
        console.error('LINE req.login error:', err);
        req.session.authError = 'เข้าสู่ระบบไม่สำเร็จ';
        return res.redirect('/login');
      }

      return res.redirect(getRedirectByRole(user));
    });
  } catch (err) {
    console.error('LINE callback error:', err);
    req.session.authError = 'LINE login เกิดข้อผิดพลาด';
    return res.redirect('/login');
  }
});

router.get('/app', requireLogin, (req, res) => {
  return res.render('app', {
    user: req.user
  });
});

router.get('/logout', (req, res, next) => {
  req.logout(function (err) {
    if (err) return next(err);

    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      return res.redirect('/login');
    });
  });
});

module.exports = router;