
function normalizeProfit(profit) {
  if (!profit || typeof profit !== 'object') return { min: 0, max: 0, label: '0% - 0%' };
  const min = Number(profit.min || 0);
  const max = Number(profit.max || 0);
  return { min, max, label: profit.label || `${min}% - ${max}%` };
}

function getCartSummary(items) {
  const subtotal = (items || []).reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  return { subtotal, total: subtotal };
}

function applyDiscountCode(db, code, userId, summary) {
  const coupon = (db.coupons || []).find(c => String(c.code).toLowerCase() === String(code).toLowerCase());
  if (!coupon) return { ok: false, message: 'ไม่พบคูปอง' };
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() < Date.now()) return { ok: false, message: 'คูปองหมดอายุแล้ว' };
  const subtotal = Number(summary.subtotal || 0);
  if (coupon.type === 'free') return { ok: true, discountAmount: subtotal, finalTotal: 0, message: 'ใช้คูปองฟรีสำเร็จ' };
  const discountAmount = Math.min(subtotal, Number(coupon.value || 0));
  return { ok: true, discountAmount, finalTotal: subtotal - discountAmount, message: 'ใช้คูปองส่วนลดสำเร็จ' };
}

function assignPackageToUser(db, userId, pkg) {
  const user = (db.users || []).find(u => String(u.id) === String(userId));
  if (!user || !pkg) return;
  const now = Date.now();
  const currentEnd = user.packageEndAt ? new Date(user.packageEndAt).getTime() : 0;
  const startAt = currentEnd > now ? currentEnd : now;
  const endAt = startAt + (Number(pkg.days || 0) * 86400000);

  // highest package governs lot/port while days stack
  const rank = { basic: 1, pro: 2, advanced: 3 };
  const currentRank = rank[String(((user.activePackageName || '').split(' ')[0] || '')).toLowerCase()] || 0;
  const newRank = rank[String(pkg.size || '').toLowerCase()] || 0;
  if (newRank >= currentRank || !user.activePackageName) {
    user.activePackageId = pkg.id;
    user.activePackageName = pkg.name;
    user.lotMin = Number(pkg.lotMin || 0);
    user.lotMax = Number(pkg.lotMax || 0);
    user.portMin = Number(pkg.portMin || 0);
    user.portMax = Number(pkg.portMax || 0);
    user.profit = normalizeProfit(pkg.profit);
  }
  user.packageStartAt = new Date(startAt).toISOString();
  user.packageEndAt = new Date(endAt).toISOString();
  user.packageHistory = Array.isArray(user.packageHistory) ? user.packageHistory : [];
  user.packageHistory.push({ packageId: pkg.id, packageName: pkg.name, startedAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString() });
}

function createOrderAndMarkPaid(db, userId, cartItems, discountCode, method='auto') {
  const summary = getCartSummary(cartItems);
  let discountAmount = 0;
  let total = summary.total;
  if (discountCode) {
    const discount = applyDiscountCode(db, discountCode, userId, summary);
    if (discount.ok) {
      discountAmount = Number(discount.discountAmount || 0);
      total = Number(discount.finalTotal || 0);
    }
  }
  const orderId = (db.orders || []).reduce((m, x) => Math.max(m, Number(x.id || 1000)), 1000) + 1;
  const paymentId = (db.payments || []).reduce((m, x) => Math.max(m, Number(x.id || 2000)), 2000) + 1;
  const item = cartItems[0];
  const order = {
    id: orderId,
    userId,
    packageId: item.packageId,
    packageName: item.packageName,
    amount: total,
    discountAmount,
    discountCode: discountCode || '',
    status: 'paid',
    createdAt: new Date().toISOString()
  };
  const payment = {
    id: paymentId,
    orderId,
    userId,
    packageId: item.packageId,
    packageName: item.packageName,
    amount: total,
    status: 'paid',
    method,
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    paidAt: new Date().toISOString()
  };
  db.orders = Array.isArray(db.orders) ? db.orders : [];
  db.payments = Array.isArray(db.payments) ? db.payments : [];
  db.orders.push(order);
  db.payments.push(payment);
  const pkg = (db.packages || []).find(p => String(p.id) === String(item.packageId));
  assignPackageToUser(db, userId, pkg);
  return { ok: true, order, payment };
}

module.exports = { normalizeProfit, getCartSummary, applyDiscountCode, createOrderAndMarkPaid, assignPackageToUser };
