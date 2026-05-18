module.exports = function requireVerified(req, res, next) {
  const currentUser = req.user || req.session?.user || null;

  if (!currentUser) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({
        ok: false,
        code: 'LOGIN_REQUIRED',
        message: 'Please login first'
      });
    }
    return res.redirect('/login');
  }

  const isVerified = Boolean(
    currentUser.email_verified ||
    currentUser.emailVerified ||
    currentUser.verified_at
  );

  if (!isVerified) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(403).json({
        ok: false,
        code: 'VERIFICATION_REQUIRED',
        message: 'Verification required before using this feature'
      });
    }

    return res.redirect('/app?verify_required=1');
  }

  return next();
};
