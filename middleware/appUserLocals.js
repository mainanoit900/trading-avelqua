'use strict';

const { query } = require('../config/database');
const { isIdentityVerified } = require('./requireIdentity');

const { getCachedUser, setCachedUser } = require('../lib/userCache');

async function appUserLocals(req, res, next) {
  const sessionUser = req.user || req.session?.user || null;

  if (!sessionUser?.id) {
    res.locals.user = null;
    res.locals.isIdentityVerified = false;
    return next();
  }

  const cached = getCachedUser(sessionUser.id);
  if (cached) {
    req.session.user = cached;
    req.user = cached;
    res.locals.user = cached;
    res.locals.isIdentityVerified = isIdentityVerified(cached);
    return next();
  }

  try {
    const result = await query(
      `SELECT * FROM users WHERE id = $1 LIMIT 1`,
      [sessionUser.id]
    );
    const freshUser = result.rows[0] || sessionUser;
    setCachedUser(sessionUser.id, freshUser);
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
