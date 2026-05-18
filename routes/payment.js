const express = require('express');
const { loadData, saveData } = require('../config/db');
const { requireLogin } = require('../middleware/requireAuth');

const router = express.Router();

function nextId(items, fallback = 1) {
  const ids = (Array.isArray(items) ? items : [])
    .map((i) => Number(i.id || 0))
    .filter(Number.isFinite);
  return ids.length ? Math.max(...ids) + 1 : fallback;
}

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  return req.session.cart;
}

function calculateDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  if (String(coupon.type || '').toLowerCase() === 'free') return subtotal;
  return Math.min(subtotal, Number(coupon.value || 0));
}

function buildSummary(cart, coupon = null) {
  const subtotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
  const discountAmount = calculateDiscount(coupon, subtotal);
  return {
    subtotal,
    discountAmount,
    total: Math.max(0, subtotal - discountAmount)
  };
}

function findCoupon(db, code) {
  const now = Date.now();
  return (db.coupons || []).find((coupon) => {
    if (String(coupon.code || '').toUpperCase() !== String(code || '').toUpperCase()) return false;
    if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < now) return false;
    if (Number(coupon.usageLimit || 0) > 0 && Number(coupon.usedCount || 0) >= Number(coupon.usageLimit || 0)) return false;
    return true;
  }) || null;
}

router.get('/checkout', requireLogin, (req, res) => {
  const cart = getCart(req);
  const coupon = req.session.appliedCoupon || null;
  const summary = buildSummary(cart, coupon);

  return res.render('checkout', {
    pageTitle: 'Checkout',
    hasCart: cart.length > 0,
    cartItems: cart.map((item) => ({
      ...item,
      packageName: item.packageName || item.name || ''
    })),
    summary,
    discountCode: coupon ? coupon.code : '',
    discountError: '',
    discountMessage: coupon ? 'ใช้คูปองสำเร็จ' : '',
    user: req.user || null,
    currentUser: req.user || null,
    currentPath: '/payment/checkout',
    lang: req.session?.lang || 'th'
  });
});

router.get('/buy/:id', requireLogin, (req, res) => {
  const db = loadData();
  const pkg = (db.packages || []).find((p) => String(p.id) === String(req.params.id));

  if (!pkg) {
    return res.redirect(`/pricing?lang=${req.session?.lang || 'th'}`);
  }

  req.session.cart = [{
    id: pkg.id,
    name: pkg.name || '',
    packageName: pkg.name || '',
    size: pkg.size || 'basic',
    days: Number(pkg.days || 0),
    price: Number(pkg.price || 0),
    lotMin: Number(pkg.lotMin || 0),
    lotMax: Number(pkg.lotMax || 0),
    portMin: Number(pkg.portMin || 0),
    portMax: Number(pkg.portMax || 0),
    profit: pkg.profit || {
      min: Number(pkg.profitMin || 0),
      max: Number(pkg.profitMax || 0),
      label: (pkg.profitMin || pkg.profitMax) ? `${Number(pkg.profitMin || 0)}% - ${Number(pkg.profitMax || 0)}%` : '-'
    }
  }];
  req.session.appliedCoupon = null;

  return res.redirect(`/payment/checkout?lang=${req.session?.lang || 'th'}`);
});

router.post('/checkout', requireLogin, (req, res) => {
  const db = loadData();
  const cart = getCart(req);
  const discountCode = String(req.body.discountCode || '').trim().toUpperCase();
  const coupon = discountCode ? findCoupon(db, discountCode) : null;
  const summary = buildSummary(cart, coupon);

  if (!cart.length) {
    return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
  }

  if (discountCode && !coupon) {
    return res.status(400).render('checkout', {
      pageTitle: 'Checkout',
      hasCart: true,
      cartItems: cart.map((item) => ({ ...item, packageName: item.packageName || item.name || '' })),
      summary: buildSummary(cart, null),
      discountCode,
      discountError: 'คูปองไม่ถูกต้อง หรือหมดอายุแล้ว',
      discountMessage: '',
      user: req.user || null,
      currentUser: req.user || null,
      currentPath: '/payment/checkout',
      lang: req.session?.lang || 'th'
    });
  }

  if (!db.payments) db.payments = [];
  if (!db.users) db.users = [];

  const firstItem = cart[0] || {};

  db.payments.push({
    id: nextId(db.payments, 1),
    userId: req.user ? req.user.id : null,
    packageId: firstItem.id || null,
    packageName: firstItem.packageName || firstItem.name || 'Package',
    amount: summary.total,
    subtotal: summary.subtotal,
    discountCode: coupon ? coupon.code : '',
    discountAmount: summary.discountAmount,
    status: 'pending',
    method: 'manual',
    createdAt: new Date().toISOString()
  });

  if (coupon) {
    coupon.usedCount = Number(coupon.usedCount || 0) + 1;
  }

  const dbUser = (db.users || []).find((u) => String(u.id) === String(req.user?.id || ''));
  if (dbUser && firstItem.id) {
    const now = new Date();
    const end = new Date(now.getTime() + (Number(firstItem.days || 0) * 24 * 60 * 60 * 1000));
    dbUser.activePackageId = firstItem.id;
    dbUser.activePackageName = firstItem.packageName || firstItem.name || '';
    dbUser.packageStartAt = now.toISOString();
    dbUser.packageEndAt = end.toISOString();
    dbUser.lotMin = Number(firstItem.lotMin || 0);
    dbUser.lotMax = Number(firstItem.lotMax || 0);
    dbUser.portMin = Number(firstItem.portMin || 0);
    dbUser.portMax = Number(firstItem.portMax || 0);
    dbUser.profit = firstItem.profit || dbUser.profit || null;
    if (!Array.isArray(dbUser.packageHistory)) dbUser.packageHistory = [];
    dbUser.packageHistory.unshift({
      packageId: firstItem.id,
      packageName: firstItem.packageName || firstItem.name || '',
      startedAt: now.toISOString(),
      endAt: end.toISOString()
    });
  }

  saveData(db);
  req.session.cart = [];
  req.session.appliedCoupon = coupon || null;

  return res.redirect(`/app?lang=${req.session?.lang || 'th'}`);
});

module.exports = router;
