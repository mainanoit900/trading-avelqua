function requireAdmin(req, res, next) {
  const user = req.user || req.session.user || null;

  if (!user) {
    req.session.error = 'กรุณาเข้าสู่ระบบก่อน';
    return res.redirect('/login');
  }

  if (String(user.role || '').toLowerCase() !== 'admin') {
    req.session.error = 'ไม่มีสิทธิ์เข้าใช้งานส่วนผู้ดูแลระบบ';
    return res.redirect('/app');
  }

  return next();
}

module.exports = requireAdmin;