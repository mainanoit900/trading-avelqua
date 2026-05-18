const { query, getClient } = require('../config/database');

function generateReferralCode() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function ensureUserReferralCode(userId) {
  const found = await query(
    `SELECT id, referral_code FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );

  const user = found.rows[0];
  if (!user) return null;
  if (user.referral_code) return user.referral_code;

  for (let i = 0; i < 10; i += 1) {
    const code = generateReferralCode();
    try {
      await query(
        `UPDATE users SET referral_code = $2 WHERE id = $1 AND referral_code IS NULL`,
        [userId, code]
      );
      return code;
    } catch (error) {
      if (String(error.code || '') !== '23505') throw error;
    }
  }

  throw new Error('Cannot generate unique referral code');
}

async function getScoinSettings() {
  const result = await query(
    `SELECT * FROM scoin_settings WHERE id = 1 LIMIT 1`
  );
  return result.rows[0] || {
    coin_name: 'Scoin',
    coin_symbol: 'SCOIN',
    current_price_thb: 0.10,
    transfer_fee_percent: 1.20,
    is_enabled: true
  };
}

function parsePaymentRawPayload(paymentRow = {}) {
  const raw = paymentRow.raw_payload || paymentRow.raw_payload_json || paymentRow.gateway_payload_json || paymentRow.meta_json || null;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (error) { return {}; }
}

function isPackagePaidByScoin(paymentRow = {}) {
  const method = String(paymentRow.payment_method || paymentRow.method || '').toLowerCase();
  const ref = String(paymentRow.payment_ref || paymentRow.reference || '').toUpperCase();
  const raw = parsePaymentRawPayload(paymentRow);

  return method === 'scoin'
    || method === 'scoin_package'
    || ref.startsWith('SCOIN-PKG-')
    || !!raw.scoin_payment
    || !!raw.package_scoin_payment
    || String(raw.payment_method || '').toLowerCase() === 'scoin';
}

async function awardScoin({
  userId,
  amount,
  txType,
  refUserId = null,
  refPaymentId = null,
  refPackageId = null,
  levelNo = 0,
  meta = {}
}) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      `SELECT id, scoin_balance FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    );

    if (!userRes.rows.length) {
      throw new Error('User not found');
    }

    const before = Number(userRes.rows[0].scoin_balance || 0);
    const reward = Number(amount || 0);
    const after = before + reward;

    await client.query(
      `UPDATE users SET scoin_balance = $2 WHERE id = $1`,
      [userId, after]
    );

    await client.query(
      `INSERT INTO scoin_transactions (
        user_id, tx_type, direction, amount, fee_amount,
        balance_before, balance_after, ref_user_id, ref_payment_id, ref_package_id,
        level_no, meta_json
      )
      VALUES ($1,$2,'in',$3,0,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [
        userId,
        txType,
        reward,
        before,
        after,
        refUserId,
        refPaymentId,
        refPackageId,
        levelNo,
        JSON.stringify(meta || {})
      ]
    );

    await client.query('COMMIT');
    return { before, after };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function grantPackageReward(paymentRow) {
  // Scoin package payment: no 30% package reward.
  if (isPackagePaidByScoin(paymentRow)) return null;

  const rewardRes = await query(
    `SELECT
       psr.*,
       p.price AS package_price,
       ROUND((COALESCE(p.price,0) * 0.30)::numeric, 4) AS customer_reward_scoin
     FROM packages p
     LEFT JOIN package_scoin_rewards psr ON psr.package_id = p.id
     WHERE p.id = $1
     LIMIT 1`,
    [paymentRow.package_id]
  );

  const reward = rewardRes.rows[0];
  if (!reward) return null;

  const rewardAmount = Number(reward.customer_reward_scoin || 0);
  if (rewardAmount <= 0) return null;

  const existing = await query(
    `SELECT id
     FROM scoin_transactions
     WHERE user_id = $1
       AND tx_type = 'package_reward'
       AND ref_payment_id = $2
     LIMIT 1`,
    [paymentRow.user_id, paymentRow.id]
  );

  if (existing.rows.length) return null;

  return awardScoin({
    userId: paymentRow.user_id,
    amount: rewardAmount,
    txType: 'package_reward',
    refPaymentId: paymentRow.id,
    refPackageId: paymentRow.package_id,
    meta: {
      package_name: paymentRow.package_name_snapshot || '',
      reward_type: reward.reward_type || 'fixed',
      customer_reward_percent: 30,
      package_price: Number(reward.package_price || 0)
    }
  });
}


async function getReferralChain(startUserId, maxLevel = 5) {
  const chain = [];
  let currentUserId = startUserId;

  for (let level = 1; level <= maxLevel; level += 1) {
    const result = await query(
      `SELECT referred_by_user_id
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [currentUserId]
    );

    const row = result.rows[0];
    if (!row || !row.referred_by_user_id) break;

    chain.push({
      levelNo: level,
      userId: row.referred_by_user_id
    });

    currentUserId = row.referred_by_user_id;
  }

  return chain;
}

async function grantReferralRewards(paymentRow) {
  // Scoin package payment: no referral level bonus.
  if (isPackagePaidByScoin(paymentRow)) return null;

  const packageRes = await query(
    `SELECT
       p.price,
       COALESCE(psr.level1_percent, 8) AS level1_percent,
       COALESCE(psr.level2_percent, 5) AS level2_percent,
       COALESCE(psr.level3_percent, 3) AS level3_percent,
       COALESCE(psr.level4_percent, 2) AS level4_percent,
       COALESCE(psr.level5_percent, 2) AS level5_percent
     FROM packages p
     LEFT JOIN package_scoin_rewards psr ON psr.package_id = p.id
     WHERE p.id = $1
     LIMIT 1`,
    [paymentRow.package_id]
  );

  const packageRule = packageRes.rows[0] || {};
  const packagePrice = Number(packageRule.price || paymentRow.final_amount || paymentRow.amount || 0);
  if (packagePrice <= 0) return;

  const existing = await query(
    `SELECT id
     FROM scoin_transactions
     WHERE tx_type = 'referral_reward'
       AND ref_payment_id = $1
     LIMIT 1`,
    [paymentRow.id]
  );
  if (existing.rows.length) return;

  const chain = await getReferralChain(paymentRow.user_id, 5);
  if (!chain.length) return;

  const fallbackLevelsRes = await query(
    `SELECT level_no, reward_percent
     FROM referral_commissions
     WHERE is_enabled = TRUE
       AND level_no BETWEEN 1 AND 5
     ORDER BY level_no ASC`
  );

  const levelMap = new Map(
    fallbackLevelsRes.rows.map((r) => [Number(r.level_no), Number(r.reward_percent)])
  );
  levelMap.set(1, Number(packageRule.level1_percent || levelMap.get(1) || 8));
  levelMap.set(2, Number(packageRule.level2_percent || levelMap.get(2) || 5));
  levelMap.set(3, Number(packageRule.level3_percent || levelMap.get(3) || 3));
  levelMap.set(4, Number(packageRule.level4_percent || levelMap.get(4) || 2));
  levelMap.set(5, Number(packageRule.level5_percent || levelMap.get(5) || 2));

  for (const item of chain) {
    const percent = Number(levelMap.get(item.levelNo) || 0);
    if (percent <= 0) continue;

    const rewardScoin = Number((packagePrice * percent / 100).toFixed(4));
    if (rewardScoin <= 0) continue;

    await awardScoin({
      userId: item.userId,
      amount: rewardScoin,
      txType: 'referral_reward',
      refUserId: paymentRow.user_id,
      refPaymentId: paymentRow.id,
      refPackageId: paymentRow.package_id,
      levelNo: item.levelNo,
      meta: {
        buyer_user_id: paymentRow.user_id,
        package_price: packagePrice,
        reward_percent: percent,
        reward_rule: 'repeat_or_existing_customer_network_20_percent'
      }
    });
  }
}


async function transferScoin({ fromUserId, toUserId, amount }) {
  const settings = await getScoinSettings();
  const feePercent = Number(settings.transfer_fee_percent || 1.2);
  const transferAmount = Number(amount || 0);

  if (transferAmount <= 0) {
    throw new Error('Invalid amount');
  }
  if (Number(fromUserId) === Number(toUserId)) {
    throw new Error('Cannot transfer to self');
  }

  const feeAmount = +(transferAmount * feePercent / 100).toFixed(4);
  const receiveAmount = +(transferAmount - feeAmount).toFixed(4);

  if (receiveAmount <= 0) {
    throw new Error('Receive amount must be greater than zero');
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const senderRes = await client.query(
      `SELECT id, scoin_balance FROM users WHERE id = $1 FOR UPDATE`,
      [fromUserId]
    );
    const receiverRes = await client.query(
      `SELECT id, scoin_balance FROM users WHERE id = $1 FOR UPDATE`,
      [toUserId]
    );

    if (!senderRes.rows.length || !receiverRes.rows.length) {
      throw new Error('User not found');
    }

    const senderBefore = Number(senderRes.rows[0].scoin_balance || 0);
    const receiverBefore = Number(receiverRes.rows[0].scoin_balance || 0);

    if (senderBefore < transferAmount) {
      throw new Error('Scoin balance is not enough');
    }

    const senderAfter = senderBefore - transferAmount;
    const receiverAfter = receiverBefore + receiveAmount;

    await client.query(`UPDATE users SET scoin_balance = $2 WHERE id = $1`, [fromUserId, senderAfter]);
    await client.query(`UPDATE users SET scoin_balance = $2 WHERE id = $1`, [toUserId, receiverAfter]);

    await client.query(
      `INSERT INTO scoin_transfer_requests (
        from_user_id, to_user_id, amount, fee_percent, fee_amount, receive_amount, status
      ) VALUES ($1,$2,$3,$4,$5,$6,'completed')`,
      [fromUserId, toUserId, transferAmount, feePercent, feeAmount, receiveAmount]
    );

    await client.query(
      `INSERT INTO scoin_transactions (
        user_id, tx_type, direction, amount, fee_amount, balance_before, balance_after, ref_user_id, meta_json
      ) VALUES ($1,'transfer_out','out',$2,$3,$4,$5,$6,$7::jsonb)`,
      [fromUserId, transferAmount, feeAmount, senderBefore, senderAfter, toUserId, JSON.stringify({ receive_amount: receiveAmount })]
    );

    await client.query(
      `INSERT INTO scoin_transactions (
        user_id, tx_type, direction, amount, fee_amount, balance_before, balance_after, ref_user_id, meta_json
      ) VALUES ($1,'transfer_in','in',$2,0,$3,$4,$5,$6::jsonb)`,
      [toUserId, receiveAmount, receiverBefore, receiverAfter, fromUserId, JSON.stringify({ sent_amount: transferAmount })]
    );

    await client.query('COMMIT');
    return { feeAmount, receiveAmount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function grantQualifiedReferralBonus(paymentRow) {
  // Scoin package payment: no first direct referral bonus.
  if (isPackagePaidByScoin(paymentRow)) return null;

  const buyerUserId = Number(paymentRow?.user_id || 0);
  const paymentId = Number(paymentRow?.id || 0);
  const packageId = Number(paymentRow?.package_id || 0);

  if (!buyerUserId || !paymentId || !packageId) return null;

  const buyerRes = await query(
    `SELECT id, referred_by_user_id, identity_verified
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [buyerUserId]
  );

  const buyer = buyerRes.rows[0];
  if (!buyer) return null;

  const sponsorUserId = Number(buyer.referred_by_user_id || 0);
  if (!sponsorUserId) return null;

  if (!buyer.identity_verified) {
    return null;
  }

  const packageRes = await query(
    `SELECT
       p.price,
       COALESCE(psr.first_referral_percent, 60) AS first_referral_percent
     FROM packages p
     LEFT JOIN package_scoin_rewards psr ON psr.package_id = p.id
     WHERE p.id = $1
     LIMIT 1`,
    [packageId]
  );

  const packageRule = packageRes.rows[0] || {};
  const packagePrice = Number(packageRule.price || paymentRow.final_amount || paymentRow.amount || 0);
  if (packagePrice <= 0) return null;

  const firstReferralPercent = Number(packageRule.first_referral_percent || 60);
  const rewardAmount = Number((packagePrice * firstReferralPercent / 100).toFixed(4));
  if (rewardAmount <= 0) return null;

  const existing = await query(
    `SELECT id
     FROM scoin_transactions
     WHERE user_id = $1
       AND tx_type = 'qualified_referral_bonus'
       AND ref_user_id = $2
     LIMIT 1`,
    [sponsorUserId, buyerUserId]
  );

  if (existing.rows.length) {
    return null;
  }

  return awardScoin({
    userId: sponsorUserId,
    amount: rewardAmount,
    txType: 'qualified_referral_bonus',
    refUserId: buyerUserId,
    refPaymentId: paymentId,
    refPackageId: packageId,
    levelNo: 0,
    meta: {
      reward_reason: 'first_package_purchase_direct_referral_once',
      buyer_user_id: buyerUserId,
      package_id: packageId,
      package_price: packagePrice,
      reward_percent: firstReferralPercent,
      note: 'จ่ายให้ผู้แนะนำตรงครั้งแรกครั้งเดียว ไม่แบ่งสายงาน'
    }
  });
}


function generateWalletCode19() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SCN-';

  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (i < 3) code += '-';
  }

  return code;
}

async function ensureUserWallet(userId) {
  const found = await query(
    `SELECT * FROM scoin_wallets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );

  if (found.rows[0]) return found.rows[0];

  for (let i = 0; i < 10; i += 1) {
    const walletCode = generateWalletCode19();

    try {
      const created = await query(
        `INSERT INTO scoin_wallets (
          user_id,
          wallet_code,
          wallet_type,
          is_active,
          created_at,
          updated_at
        )
        VALUES ($1,$2,'user',TRUE,NOW(),NOW())
        RETURNING *`,
        [userId, walletCode]
      );

      return created.rows[0] || null;
    } catch (error) {
      if (String(error.code || '') !== '23505') throw error;
    }
  }

  throw new Error('ไม่สามารถสร้างรหัสกระเป๋า Scoin ได้');
}

async function findUserByWalletCode(walletCode) {
  const code = String(walletCode || '').trim();
  if (!code) return null;

  const result = await query(
    `SELECT
       u.*,
       w.wallet_code
     FROM scoin_wallets w
     INNER JOIN users u ON u.id = w.user_id
     WHERE w.wallet_code = $1
       AND w.is_active = TRUE
     LIMIT 1`,
    [code]
  );

  return result.rows[0] || null;
}

async function transferScoinByWalletCode({ fromUserId, toWalletCode, amount }) {
  const targetUser = await findUserByWalletCode(toWalletCode);

  if (!targetUser) {
    throw new Error('ไม่พบรหัสกระเป๋าปลายทาง');
  }

  return transferScoin({
    fromUserId,
    toUserId: targetUser.id,
    amount
  });
}

async function distributeScoinEconomy({
  userId,
  paymentId = null,
  packageId = null,
  amountThb = 0,
  paymentMethod = null,
  paymentRef = null,
  rawPayload = null
}) {
  // Scoin package payment: buy and activate only, no reward or referral split.
  let paymentInfo = {
    payment_method: paymentMethod,
    payment_ref: paymentRef,
    raw_payload: rawPayload
  };

  // Safety: if caller did not pass payment method/ref, check the payment row before giving any reward.
  if (paymentId && !paymentMethod && !paymentRef && !rawPayload) {
    const paymentInfoRes = await query(
      `SELECT payment_method, payment_ref, raw_payload
       FROM payments
       WHERE id = $1
       LIMIT 1`,
      [paymentId]
    ).catch(() => ({ rows: [] }));

    paymentInfo = paymentInfoRes.rows[0] || paymentInfo;
  }

  if (isPackagePaidByScoin(paymentInfo)) {
    return {
      userReceiveScoin: 0,
      directReferralScoin: 0,
      levelBonus: {},
      skipped: true,
      reason: 'package_paid_by_scoin_no_reward_no_referral'
    };
  }
  const priceThb = Number(amountThb || 0);
  if (!userId || !paymentId || priceThb <= 0) return null;

  const buyerScoin = Number((priceThb * 0.30).toFixed(4));
  const directReferralScoin = Number((priceThb * 0.60).toFixed(4));

  // สูตรใหม่: ซื้อซ้ำ/ลูกค้าเก่า แบ่งโบนัสสายงานจากราคาแพ็กเกจโดยตรง 8/5/3/2/2 = รวม 20%
  const levelBonus = {
    1: 8,
    2: 5,
    3: 3,
    4: 2,
    5: 2
  };

  const existingBuyerReward = await query(
    `SELECT id
     FROM scoin_transactions
     WHERE tx_type = 'package_reward'
       AND ref_payment_id = $1
       AND user_id = $2
     LIMIT 1`,
    [paymentId, userId]
  );

  if (!existingBuyerReward.rows.length && buyerScoin > 0) {
    await awardScoin({
      userId,
      amount: buyerScoin,
      txType: 'package_reward',
      refPaymentId: paymentId,
      refPackageId: packageId,
      meta: {
        rule: 'buyer_get_30_percent_of_package_price',
        price_thb: priceThb,
        percent: 30
      }
    });
  }

  const chain = await getReferralChain(userId, 5);

  let paidFirstDirectReferralBonus = false;
  let buyerAlreadyHadFirstBonus = false;

  if (chain.length && directReferralScoin > 0) {
    const directUpline = chain[0];

    const existingFirstBonus = await query(
      `SELECT id
       FROM scoin_transactions
       WHERE tx_type = 'referral_first_purchase_bonus'
         AND ref_user_id = $1
       LIMIT 1`,
      [userId]
    );

    buyerAlreadyHadFirstBonus = existingFirstBonus.rows.length > 0;

    if (!buyerAlreadyHadFirstBonus) {
      await awardScoin({
        userId: directUpline.userId,
        amount: directReferralScoin,
        txType: 'referral_first_purchase_bonus',
        refUserId: userId,
        refPaymentId: paymentId,
        refPackageId: packageId,
        levelNo: 1,
        meta: {
          rule: 'direct_referrer_get_60_percent_once_per_referred_user_no_network_split',
          buyer_user_id: userId,
          price_thb: priceThb,
          percent: 60,
          note: 'แนะนำตรงครั้งแรก ได้ 60% ครั้งเดียว และไม่แบ่งสายงานในออเดอร์นี้'
        }
      });
      paidFirstDirectReferralBonus = true;
    }
  }

  const existingLevelBonus = await query(
    `SELECT id
     FROM scoin_transactions
     WHERE tx_type LIKE 'referral_level_%_bonus'
       AND ref_payment_id = $1
     LIMIT 1`,
    [paymentId]
  );

  // แบ่งสายงานเฉพาะซื้อซ้ำ/ลูกค้าเก่าเท่านั้น เพื่อไม่ให้ซ้อนกับโบนัสแนะนำตรงครั้งแรก 60%
  if (!existingLevelBonus.rows.length && !paidFirstDirectReferralBonus && buyerAlreadyHadFirstBonus && chain.length) {
    for (const item of chain) {
      const percent = Number(levelBonus[item.levelNo] || 0);
      const rewardScoin = Number((priceThb * percent / 100).toFixed(4));
      if (rewardScoin <= 0) continue;

      await awardScoin({
        userId: item.userId,
        amount: rewardScoin,
        txType: `referral_level_${item.levelNo}_bonus`,
        refUserId: userId,
        refPaymentId: paymentId,
        refPackageId: packageId,
        levelNo: item.levelNo,
        meta: {
          rule: 'repeat_or_existing_customer_network_20_percent_8_5_3_2_2',
          buyer_user_id: userId,
          package_price_thb: priceThb,
          level: item.levelNo,
          percent
        }
      });
    }
  }

  await query(`
    INSERT INTO scoin_economy_logs (
      payment_id,
      user_id,
      package_id,
      package_price_thb,
      user_receive_scoin,
      network_bonus_thb
    )
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [
    paymentId,
    userId,
    packageId,
    priceThb,
    buyerScoin,
    directReferralScoin
  ]).catch(() => null);

  return {
    userReceiveScoin: buyerScoin,
    directReferralScoin,
    levelBonus,
    paidFirstDirectReferralBonus,
    buyerAlreadyHadFirstBonus
  };
}

async function increaseTreasury(walletKey, amount) {
  await query(`
    UPDATE scoin_treasury_wallets
    SET balance_thb = balance_thb + $1,
        updated_at = NOW()
    WHERE wallet_key = $2
  `, [amount, walletKey]);
}

async function deleteWalletByUserId(userId) {
  const result = await query(
    `DELETE FROM scoin_wallets
     WHERE user_id = $1
     RETURNING *`,
    [userId]
  );

  return result.rows[0] || null;
}

async function recreateWalletByUserId(userId) {
  await deleteWalletByUserId(userId);
  return ensureUserWallet(userId);
}

async function markMarketOrderPaid(orderId, payload = {}) {
  const result = await query(
    `UPDATE scoin_market_orders
     SET payment_status = 'paid',
         paid_at = NOW(),
         gateway_payload_json = COALESCE(gateway_payload_json, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [orderId, JSON.stringify(payload || {})]
  );

  return result.rows[0] || null;
}

async function approveBuyOrderAndCredit(orderId, adminUserId = null) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT *
       FROM scoin_market_orders
       WHERE id = $1
       FOR UPDATE`,
      [orderId]
    );

    const order = orderRes.rows[0];
    if (!order) throw new Error('ไม่พบคำสั่งตลาด');
    if (String(order.order_type) !== 'buy') throw new Error('คำสั่งนี้ไม่ใช่ buy');
    if (String(order.payment_status) !== 'paid') throw new Error('คำสั่งนี้ยังไม่ชำระเงิน');
    if (String(order.status) !== 'pending') throw new Error('คำสั่งนี้ไม่ได้อยู่ในสถานะ pending');

    const userRes = await client.query(
      `SELECT id, scoin_balance
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [order.user_id]
    );

    const user = userRes.rows[0];
    if (!user) throw new Error('ไม่พบผู้ใช้งาน');

    const before = Number(user.scoin_balance || 0);
    const scoinAmount = Number(order.scoin_amount || 0);
    const after = before + scoinAmount;

    await client.query(
      `UPDATE users
       SET scoin_balance = $2
       WHERE id = $1`,
      [user.id, after]
    );

    await client.query(
      `INSERT INTO scoin_transactions (
        user_id, tx_type, direction, amount, fee_amount,
        balance_before, balance_after, meta_json, created_at
      )
      VALUES ($1, 'market_buy', 'in', $2, 0, $3, $4, $5::jsonb, NOW())`,
      [
        user.id,
        scoinAmount,
        before,
        after,
        JSON.stringify({
          market_order_id: order.id,
          order_type: order.order_type,
          payment_method: order.payment_method,
          payment_ref: order.payment_ref,
          gross_amount_thb: order.gross_amount_thb,
          fee_amount_thb: order.fee_amount_thb,
          net_amount_thb: order.net_amount_thb
        })
      ]
    );

    await client.query(
      `UPDATE scoin_market_orders
       SET status = 'approved',
           approved_at = NOW(),
           approved_by_user_id = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, adminUserId]
    );

    const statsRes = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN order_type = 'buy' AND status = 'approved' THEN scoin_amount ELSE 0 END), 0) AS buy_volume,
         COALESCE(SUM(CASE WHEN order_type = 'sell' AND status = 'approved' THEN scoin_amount ELSE 0 END), 0) AS sell_volume
       FROM scoin_market_orders`
    );

    const settingsRes = await client.query(`SELECT * FROM scoin_settings WHERE id = 1 LIMIT 1`);
    const settings = settingsRes.rows[0] || {};
    const buyVolume = Number(statsRes.rows[0]?.buy_volume || 0);
    const sellVolume = Number(statsRes.rows[0]?.sell_volume || 0);
    const marketSupply = Number(settings.market_supply || 0);
    const currentPrice = Number(settings.current_price_thb || 0.10);

    await client.query(
      `INSERT INTO scoin_price_history (
        price_thb, buy_volume, sell_volume, market_supply, created_at
      )
      VALUES ($1,$2,$3,$4,NOW())`,
      [currentPrice, buyVolume, sellVolume, marketSupply]
    );

    await client.query('COMMIT');
    return { ok: true, orderId: order.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureUserReferralCode,
  ensureUserWallet,
  findUserByWalletCode,
  getScoinSettings,
  grantPackageReward,
  grantQualifiedReferralBonus,
  grantReferralRewards,
  distributeScoinEconomy,
  transferScoin,
  transferScoinByWalletCode,
  deleteWalletByUserId,
  recreateWalletByUserId,
  markMarketOrderPaid,
  approveBuyOrderAndCredit,
  isPackagePaidByScoin
};