'use strict';

const { query } = require('../config/database');
const { isIdentityVerified } = require('./requireIdentity');

async function appUserLocals(req, res, next) {
  const sessionUser = req.user || req.session?.user || null;

  if (!sessionUser?.id) {
    res.locals.user = null;
    res.locals.isIdentityVerified = false;
    return next();
  }

  try {
    const result = await query(
      `SELECT * FROM users WHERE id = $1 LIMIT 1`,
      [sessionUser.id]
    );
    const freshUser = result.rows[0] || sessionUser;
    req.session.user = freshUser;
    req.user = freshUser;
    res.locals.user = freshUser;
    res.locals.isIdentityVerified = isIdentityVerified(freshUser);
  } catch (_) {
    res.locals.user = sessionUser;
    res.locals.isIdentityVerified = isIdentityVerified(sessionUser);
  }

  return next();
}

module.exports = { appUserLocals };
