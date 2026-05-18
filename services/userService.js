const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function nextId(items, fallback = 1) {
  const ids = (Array.isArray(items) ? items : [])
    .map(i => Number(i.id || 0))
    .filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : fallback;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function findUserByEmail(db, email) {
  const safeEmail = normalizeEmail(email);
  return (db.users || []).find(
    u => normalizeEmail(u.email) === safeEmail
  );
}

function ensureVerifyTokens(db) {
  if (!Array.isArray(db.emailVerifyTokens)) {
    db.emailVerifyTokens = [];
  }
}

function buildVerifyToken() {
  return crypto.randomUUID();
}

async function createUser(db, payload) {
  const safeEmail = normalizeEmail(payload.email);
  const existing = findUserByEmail(db, safeEmail);
  if (existing) return { ok: false, message: 'อีเมลนี้ถูกใช้งานแล้ว' };

  const passwordHash = await bcrypt.hash(String(payload.password || ''), 10);
  const verifyToken = buildVerifyToken();
  const id = nextId(db.users, 1);

  const user = {
    id,
    firstName: payload.firstName || '',
    lastName: payload.lastName || '',
    name: `${payload.firstName || ''} ${payload.lastName || ''}`.trim(),
    email: safeEmail,
    phone: payload.phone || '',
    address: payload.address || '',
    password: passwordHash,
    role: 'user',
    provider: payload.provider || 'local',
    emailVerified: false,
    verifyToken,
    status: 'pending_verification',
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
  ensureVerifyTokens(db);
  db.emailVerifyTokens = db.emailVerifyTokens.filter(
    row => normalizeEmail(row.email) !== safeEmail
  );
  db.emailVerifyTokens.push({
    email: safeEmail,
    token: verifyToken,
    expiresAt: Date.now() + (1000 * 60 * 60 * 24)
  });

  return { ok: true, user, verifyToken };
}

async function verifyLogin(db, email, password) {
  const user = findUserByEmail(db, email);
  if (!user) return { ok: false, message: 'ไม่พบผู้ใช้งาน' };

  const hashLike = String(user.password || '');
  let matched = false;

  if (hashLike.startsWith('$2')) {
    matched = await bcrypt.compare(String(password || ''), hashLike);
  } else {
    matched = hashLike === String(password || '');
  }

  if (!matched) return { ok: false, message: 'รหัสผ่านไม่ถูกต้อง' };

  if (String(user.provider || 'local') === 'local' && !user.emailVerified) {
    return { ok: false, message: 'กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ' };
  }

  return { ok: true, user };
}

function createVerifyEmailToken(db, email) {
  const user = findUserByEmail(db, email);
  if (!user) return { ok: false, message: 'ไม่พบผู้ใช้งาน' };

  if (String(user.provider || 'local') !== 'local') {
    return { ok: false, message: 'บัญชีนี้ไม่ต้องยืนยันอีเมล' };
  }

  const token = buildVerifyToken();
  user.verifyToken = token;
  user.emailVerified = false;
  user.status = 'pending_verification';

  ensureVerifyTokens(db);
  db.emailVerifyTokens = db.emailVerifyTokens.filter(
    row => normalizeEmail(row.email) !== normalizeEmail(user.email)
  );
  db.emailVerifyTokens.push({
    email: normalizeEmail(user.email),
    token,
    expiresAt: Date.now() + (1000 * 60 * 60 * 24)
  });

  return { ok: true, token, user };
}

function verifyEmailToken(db, token) {
  ensureVerifyTokens(db);
  const row = (db.emailVerifyTokens || []).find(
    t => String(t.token || '') === String(token || '') && Number(t.expiresAt || 0) > Date.now()
  );

  if (!row) {
    return { ok: false, message: 'ลิงก์ยืนยันอีเมลไม่ถูกต้องหรือหมดอายุแล้ว' };
  }

  const user = findUserByEmail(db, row.email);
  if (!user) {
    return { ok: false, message: 'ไม่พบผู้ใช้งาน' };
  }

  user.emailVerified = true;
  user.verifyToken = '';
  user.status = 'active';

  db.emailVerifyTokens = db.emailVerifyTokens.filter(
    t => String(t.token || '') !== String(token || '')
  );

  return { ok: true, user };
}

function createResetToken(db, email) {
  const user = findUserByEmail(db, email);
  if (!user) return { ok: false, message: 'ไม่พบผู้ใช้งาน' };

  const token = crypto.randomUUID();

  if (!db.passwordResetTokens) db.passwordResetTokens = [];

  db.passwordResetTokens = db.passwordResetTokens.filter(
    t => normalizeEmail(t.email) !== normalizeEmail(email)
  );

  db.passwordResetTokens.push({
    email: normalizeEmail(email),
    token,
    expiresAt: Date.now() + (1000 * 60 * 30)
  });

  return { ok: true, token };
}

async function resetPassword(db, token, newPassword) {
  const row = (db.passwordResetTokens || []).find(
    t => String(t.token || '') === String(token || '') && Number(t.expiresAt || 0) > Date.now()
  );

  if (!row) return { ok: false, message: 'ลิงก์หมดอายุ' };

  const user = findUserByEmail(db, row.email);
  if (!user) return { ok: false, message: 'ไม่พบผู้ใช้งาน' };

  user.password = await bcrypt.hash(newPassword, 10);

  db.passwordResetTokens = db.passwordResetTokens.filter(
    t => String(t.token || '') !== String(token || '')
  );

  return { ok: true };
}

module.exports = {
  nextId,
  normalizeEmail,
  findUserByEmail,
  createUser,
  verifyLogin,
  createVerifyEmailToken,
  verifyEmailToken,
  createResetToken,
  resetPassword
};
