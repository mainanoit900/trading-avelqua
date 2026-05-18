function getUser(req) {
  return req.user || req.session?.user || null;
}

function prefersJsonResponse(req) {
  const accept = String(req.headers.accept || req.headers.Accept || '');
  if (accept.includes('application/json')) return true;
  const xhr = String(req.headers['x-requested-with'] || '');
  return xhr.toLowerCase() === 'xmlhttprequest';
}

function requireLogin(req, res, next) {
  if (getUser(req)) return next();
  if (prefersJsonResponse(req)) {
    return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบใหม่' });
  }
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  const user = getUser(req);
  if (!user) return res.redirect('/login');
  if (String(user.role || 'user') !== 'admin') return res.redirect('/app');
  return next();
}

function requireGuest(req, res, next) {
  const user = getUser(req);
  if (user) return res.redirect(String(user.role || 'user') === 'admin' ? '/admin' : '/app');
  return next();
}

function injectUser(req, res, next) {
  if (req.user) req.session.user = req.user;
  next();
}

module.exports = { requireLogin, requireAdmin, requireGuest, injectUser, prefersJsonResponse };
