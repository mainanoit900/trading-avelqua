const { prefersJsonResponse } = require('./requireAuth');

const IDLE_TIMEOUT_MS = Number(process.env.SESSION_IDLE_MS || 2 * 60 * 60 * 1000);

function getLoggedInUser(req) {
  return req.user || req.session?.user || null;
}

function markSessionActive(req, at = Date.now()) {
  if (!req.session) return;
  req.session.lastUserActivityAt = at;
}

function isSessionIdleExpired(session, now = Date.now()) {
  if (!session) return false;
  const last = Number(session.lastUserActivityAt);
  if (!Number.isFinite(last) || last <= 0) return false;
  return now - last >= IDLE_TIMEOUT_MS;
}

function destroyIdleSession(req, res, next) {
  const finish = () => {
    res.clearCookie('connect.sid');
    if (prefersJsonResponse(req)) {
      return res.status(401).json({
        ok: false,
        code: 'SESSION_IDLE_TIMEOUT',
        message: 'ออกจากระบบอัตโนมัติเนื่องจากไม่มีการใช้งาน 2 ชั่วโมง'
      });
    }
    return res.redirect('/login?reason=idle');
  };

  if (typeof req.logout === 'function') {
    return req.logout(() => {
      if (req.session) {
        return req.session.destroy(() => finish());
      }
      return finish();
    });
  }

  if (req.session) {
    return req.session.destroy(() => finish());
  }

  return finish();
}

function enforceSessionIdle(req, res, next) {
  const user = getLoggedInUser(req);
  if (!user || !req.session) return next();

  if (!Number.isFinite(Number(req.session.lastUserActivityAt))) {
    markSessionActive(req);
    return next();
  }

  if (isSessionIdleExpired(req.session)) {
    return destroyIdleSession(req, res, next);
  }

  return next();
}

module.exports = {
  IDLE_TIMEOUT_MS,
  markSessionActive,
  isSessionIdleExpired,
  enforceSessionIdle,
  destroyIdleSession
};
