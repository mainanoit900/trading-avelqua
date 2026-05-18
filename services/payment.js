const express = require('express');
  const providerRef = String(req.body.provider_ref || '').trim();
  const paymentId = Number(req.body.payment_id || 0);
  const amount = Number(req.body.amount || 0);
  const isPaid = String(req.body.status || '').toLowerCase() === 'paid';

  if (!providerRef && !paymentId) return res.status(400).json({ ok: false, error: 'missing payment ref' });

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const paymentRes = await client.query(
      `SELECT * FROM payments WHERE (id = $1 OR provider_ref = $2) LIMIT 1 FOR UPDATE`,
      [paymentId || null, providerRef || '']
    );
    const payment = paymentRes.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'payment not found' });
    }

    await client.query(
      `INSERT INTO payment_events (payment_id, event_type, provider_name, provider_ref, payload_json)
       VALUES ($1, 'webhook', 'manual_qr', $2, $3)`,
      [payment.id, providerRef || payment.provider_ref || '', req.body || {}]
    );

    if (!isPaid) {
      await client.query('COMMIT');
      return res.json({ ok: true, ignored: true });
    }

    if (Number(payment.final_amount || 0) !== amount && amount > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'amount mismatch' });
    }

    await client.query(
      `UPDATE payments
       SET payment_status = 'paid',
           paid_at = NOW(),
           updated_at = NOW(),
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [payment.id, JSON.stringify({ webhook: req.body || {}, webhookReceivedAt: new Date().toISOString() })]
    );

    if (payment.coupon_id) {
      await client.query(`UPDATE coupons SET used_count = used_count + 1, updated_at = NOW() WHERE id = $1`, [payment.coupon_id]);
    }

    await client.query('COMMIT');
    await activateSubscriptionFromPayment(payment.id);
    return res.json({ ok: true, paymentId: payment.id });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    console.error('manual_qr webhook error:', error);
    return res.status(500).json({ ok: false, error: 'webhook failed' });
  } finally {
    client.release();
  }
});

module.exports = router;