const express = require('express');
const { loadData } = require('../config/db');
const { requireLogin } = require('../middleware/requireAuth');

const router = express.Router();

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  return req.session.cart;
}

function findPackage(db, id) {
  return (db.packages || []).find((p) => String(p.id) === String(id));
}

function calcCartSummary(cart) {
  const subtotal = cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
  return {
    items: cart,
    subtotal,
    total: subtotal
  };
}

router.get('/', requireLogin, (req, res) => {
  const cart = getCart(req);
  const summary = calcCartSummary(cart);

  return res.render('cart', {
    pageTitle: 'Cart',
    cartItems: summary.items.map((item) => ({
      ...item,
      packageName: item.packageName || item.name || '',
      profit: item.profit || null
    })),
    subtotal: summary.subtotal,
    total: summary.total,
    user: req.user || null,
    currentUser: req.user || null,
    currentPath: '/cart',
    lang: req.session?.lang || 'th'
  });
});

router.get('/add/:id', requireLogin, (req, res) => {
  const db = loadData();
  const pkg = findPackage(db, req.params.id);

  if (!pkg) {
    return res.redirect(`/pricing?lang=${req.session?.lang || 'th'}`);
  }

  const cart = getCart(req);

  cart.push({
    id: pkg.id,
    name: pkg.name || '',
    packageName: pkg.name || '',
    size: pkg.size || 'basic',
    days: Number(pkg.days || 0),
    price: Number(pkg.price || 0),
    lotMin: Number(pkg.lotMin || 0),
    lotMax: Number(pkg.lotMax || 0),
    portMin: Number(pkg.portMin || 0),
    portMax: Number(pkg.portMax || 0)
  });

  req.session.cart = cart;
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

router.post('/remove/:id', requireLogin, (req, res) => {
  const cart = getCart(req).filter((item) => String(item.id) !== String(req.params.id));
  req.session.cart = cart;
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

router.post('/remove', requireLogin, (req, res) => {
  req.session.cart = [];
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

router.post('/clear', requireLogin, (req, res) => {
  req.session.cart = [];
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

module.exports = router;
