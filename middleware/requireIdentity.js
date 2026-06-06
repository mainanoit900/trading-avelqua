'use strict';

const { query } = require('../config/database');

function isIdentityVerified(user) {
  return !!(
    user &&
    (
      user.identity_verified === true ||
      user.identity_verified === 't' ||
      user.identity_verified === 1 ||
      user.identityVerified === true
    )
  );
}

function isIdentityExemptRequest(req) {
  const path = String(req.path || '/');

  if (path.startsWith('/identity')) return true;
  if (path.startsWith('/kbank/')) return true;
  if (req.method === 'GET' && (path === '/' || path === '')) return true;

  return false;
}

async function getFreshUser(userId) {
  if (!userId) return null;
  const result = await query(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  ).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

async function requireIdentityVerified(req, res, next) {
  if (isIdentityExemptRequest(req)) return next();

  const sessionUser = req.user || req.session?.user;
  if (!sessionUser?.id) return next();

  const freshUser = await getFreshUser(sessionUser.id);
  const user = freshUser || sessionUser;
  if (freshUser) {
    req.session.user = freshUser;
    req.user = freshUser;
  }

  if (isIdentityVerified(user)) return next();

  req.session.error = 'กรุณายืนยันตัวตนก่อนใช้งานเมนูอื่น';

  const accept = String(req.get('Accept') || '');
  if (accept.includes('application/json')) {
    return res.status(403).json({
      ok: false,
      error: 'identity_required',
      message: 'กรุณายืนยันตัวตนก่อนใช้งานเมนูอื่น'
    });
  }

  return res.redirect('/app/identity');
}

module.exports = {
  isIdentityVerified,
  isIdentityExemptRequest,
  requireIdentityVerified
};
