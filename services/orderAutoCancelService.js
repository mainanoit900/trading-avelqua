const { query } = require('../config/database');

async function autoCancelExpiredOrders() {
  // ซื้อแพ็กเกจ: ถ้า pending เกิน 20 นาที ยกเลิกอัตโนมัติ
  await query(`
    UPDATE payments
    SET payment_status = 'cancelled',
        cancel_reason = COALESCE(cancel_reason, 'auto_cancel_20_minutes'),
        cancelled_at = COALESCE(cancelled_at, NOW()),
        auto_cancelled_at = COALESCE(auto_cancelled_at, NOW()),
        updated_at = NOW()
    WHERE COALESCE(payment_status,'pending') IN ('pending','waiting','unpaid')
      AND created_at <= NOW() - INTERVAL '20 minutes'
  `).catch((err) => console.error('auto cancel package payments error:', err));

  // ซื้อ Scoin: ถ้า pending เกิน 20 นาที ยกเลิกอัตโนมัติ
  await query(`
    UPDATE scoin_market_orders
    SET status = 'cancelled',
        payment_status = CASE WHEN COALESCE(payment_status,'pending') = 'paid' THEN payment_status ELSE 'cancelled' END,
        cancel_reason = COALESCE(cancel_reason, 'auto_cancel_20_minutes'),
        cancelled_at = COALESCE(cancelled_at, NOW()),
        auto_cancelled_at = COALESCE(auto_cancelled_at, NOW()),
        updated_at = NOW()
    WHERE order_type = 'buy'
      AND COALESCE(status,'pending') = 'pending'
      AND COALESCE(payment_status,'pending') IN ('pending','waiting','unpaid')
      AND created_at <= NOW() - INTERVAL '20 minutes'
  `).catch((err) => console.error('auto cancel scoin buy error:', err));

  // ขาย Scoin: ถ้าไม่มีใครอนุมัติภายใน 1 วัน ยกเลิกอัตโนมัติ
  await query(`
    UPDATE scoin_market_orders
    SET status = 'cancelled',
        payout_status = CASE WHEN COALESCE(payout_status,'pending') = 'paid' THEN payout_status ELSE 'cancelled' END,
        cancel_reason = COALESCE(cancel_reason, 'auto_cancel_1_day_no_admin_approval'),
        cancelled_at = COALESCE(cancelled_at, NOW()),
        auto_cancelled_at = COALESCE(auto_cancelled_at, NOW()),
        updated_at = NOW()
    WHERE order_type = 'sell'
      AND COALESCE(status,'pending') = 'pending'
      AND created_at <= NOW() - INTERVAL '1 day'
  `).catch((err) => console.error('auto cancel scoin sell error:', err));
}

module.exports = { autoCancelExpiredOrders };
