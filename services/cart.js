const express = require('express');
    lotMin: Number(row.lot_min || 0),
    lotMax: Number(row.lot_max || 0),
    portMin: Number(row.ports_min || 0),
    portMax: Number(row.ports_max || 0),
    profit: {
      min: Number(row.profit_min || 0),
      max: Number(row.profit_max || 0),
      label: row.profit_label_th || row.profit_label_en || '-'
    }
  };
}

function calcCartSummary(cart) {
  const items = (cart || []).slice(0, 1);
  const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0), 0);
  return { items, subtotal, total: subtotal };
}

router.get('/', requireLogin, (req, res) => {
  const cart = getCart(req).slice(0, 1);
  const summary = calcCartSummary(cart);

  return res.render('cart', {
    pageTitle: 'Cart',
    cartItems: summary.items,
    subtotal: summary.subtotal,
    total: summary.total,
    user: req.user || null,
    currentUser: req.user || null,
    currentPath: '/cart',
    lang: req.session?.lang || 'th'
  });
});

router.get('/add/:id', requireLogin, async (req, res) => {
  const result = await query(
    `SELECT * FROM packages WHERE id = $1 AND is_enabled = TRUE LIMIT 1`,
    [req.params.id]
  );
  const pkg = result.rows[0];

  if (!pkg) return res.redirect(`/pricing?lang=${req.session?.lang || 'th'}`);

  req.session.cart = [toCartItem(pkg)];
  req.session.appliedCoupon = null;
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

router.post('/remove/:id', requireLogin, (req, res) => {
  req.session.cart = [];
  req.session.appliedCoupon = null;
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

router.post('/remove', requireLogin, (req, res) => {
  req.session.cart = [];
  req.session.appliedCoupon = null;
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

router.post('/clear', requireLogin, (req, res) => {
  req.session.cart = [];
  req.session.appliedCoupon = null;
  return res.redirect(`/cart?lang=${req.session?.lang || 'th'}`);
});

module.exports = router;