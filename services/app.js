const express = require('express');
         address = $10,
         updated_at = NOW()
     WHERE id = $11`,
    [
      firstName,
      lastName,
      fullName,
      phone,
      addressLine,
      provinceName,
      districtName,
      subdistrictName,
      postalCode,
      `${addressLine} ${subdistrictName} ${districtName} ${provinceName} ${postalCode}`.trim(),
      user.id
    ]
  );

  req.session.success = 'บันทึกข้อมูลผู้ใช้งานเรียบร้อยแล้ว';
  return res.redirect('/app');
});

router.get('/bots', async (req, res) => {
  const base = await getBaseData(req);
  return res.render('app/bots', { pageTitle: 'Bot Connection', currentPath: '/app/bots', ...flash(req), ...base });
});

router.post('/bots/:accountId/play', async (req, res) => {
  const user = req.user || req.session.user;
  const sub = await getActiveSubscription(user.id);
  if (!sub) {
    req.session.error = 'แพ็กเกจของคุณหมดอายุหรือยังไม่ได้ชำระเงิน ไม่สามารถเปิดบอทได้';
    return res.redirect('/app/bots');
  }

  const requestedLot = Number(req.body.lot_in_use || 0);
  const requestedPorts = Number(req.body.ports_in_use || 1);
  const safeLot = Math.min(Math.max(requestedLot || Number(sub.lot_min || 0), Number(sub.lot_min || 0)), Number(sub.lot_max || 0));
  const safePorts = Math.min(Math.max(requestedPorts || Number(sub.ports_min || 1), Number(sub.ports_min || 1)), Number(sub.ports_max || 0));

  const result = await query(
    `INSERT INTO bot_sessions (user_id, broker_account_id, session_code, symbol, lot_in_use, ports_in_use, status, started_at)
     VALUES ($1, $2, encode(gen_random_bytes(6), 'hex'), $3, $4, $5, 'running', NOW()) RETURNING id`,
    [user.id, req.params.accountId, String(req.body.symbol || 'XAUUSD'), safeLot, safePorts]
  );
  req.session.success = `เริ่ม Bot session #${result.rows[0].id} แล้ว`;
  return res.redirect('/app/bots');
});

router.post('/bots/:id/stop', async (req, res) => {
  const user = req.user || req.session.user;
  await query(
    `UPDATE bot_sessions SET status = 'stopped', stopped_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2`,
    [req.params.id, user.id]
  );
  req.session.success = 'หยุด Bot แล้ว';
  return res.redirect('/app/bots');
});

module.exports = router;