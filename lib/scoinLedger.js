const crypto = require('crypto');
const { getClient } = require('../config/database');

const TX_SOURCE = { WEB: 'web', API: 'api', SYSTEM: 'system' };
const TX_STATUS = { CONFIRMED: 'confirmed', PENDING: 'pending', CANCELLED: 'cancelled' };

function generateTxRef() {
  const part = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SCN-TX-${part}-${rand}`;
}

function generateTransferGroupId() {
  return `SCN-TR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function sellLockKey(orderId) {
  return `sell-lock-${orderId}`;
}

async function readUserBalances(client, userId, lockRow = true) {
  const sql = lockRow
    ? `SELECT id, scoin_balance, COALESCE(scoin_locked_balance, 0) AS scoin_locked_balance
       FROM users WHERE id = $1 FOR UPDATE`
    : `SELECT id, scoin_balance, COALESCE(scoin_locked_balance, 0) AS scoin_locked_balance
       FROM users WHERE id = $1`;

  const res = await client.query(sql, [userId]);
  if (!res.rows.length) throw new Error('User not found');

  const balance = Number(res.rows[0].scoin_balance || 0);
  const locked = Number(res.rows[0].scoin_locked_balance || 0);
  return {
    userId: res.rows[0].id,
    balance,
    locked,
    available: +(balance - locked).toFixed(4)
  };
}

async function postTransaction(client, {
  userId,
  direction,
  amount,
  txType,
  feeAmount = 0,
  refUserId = null,
  refPaymentId = null,
  refPackageId = null,
  levelNo = 0,
  meta = {},
  idempotencyKey = null,
  source = TX_SOURCE.WEB,
  status = TX_STATUS.CONFIRMED,
  txRef = null,
  transferGroupId = null
}) {
  const amt = Number(amount || 0);
  if (amt <= 0) throw new Error('Invalid amount');
  if (!['in', 'out'].includes(String(direction))) throw new Error('Invalid direction');

  if (idempotencyKey) {
    const dup = await client.query(
      `SELECT * FROM scoin_transactions WHERE idempotency_key = $1 LIMIT 1`,
      [idempotencyKey]
    );
    if (dup.rows.length) {
      const row = dup.rows[0];
      return {
        tx: row,
        before: Number(row.balance_before || 0),
        after: Number(row.balance_after || 0),
        duplicate: true
      };
    }
  }

  const balances = await readUserBalances(client, userId, true);
  const before = balances.balance;
  let after = before;

  if (direction === 'in') {
    after = +(before + amt).toFixed(4);
  } else if (balances.available < amt) {
    throw new Error('Scoin balance is not enough');
  } else {
    after = +(before - amt).toFixed(4);
  }

  await client.query(`UPDATE users SET scoin_balance = $2 WHERE id = $1`, [userId, after]);

  const insertRes = await client.query(
    `INSERT INTO scoin_transactions (
      user_id, tx_type, direction, amount, fee_amount,
      balance_before, balance_after, ref_user_id, ref_payment_id, ref_package_id,
      level_no, meta_json, tx_ref, idempotency_key, source, status, transfer_group_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
    RETURNING *`,
    [
      userId,
      txType,
      direction,
      amt,
      Number(feeAmount || 0),
      before,
      after,
      refUserId,
      refPaymentId,
      refPackageId,
      levelNo,
      JSON.stringify(meta || {}),
      txRef || generateTxRef(),
      idempotencyKey,
      source,
      status,
      transferGroupId
    ]
  );

  return {
    tx: insertRes.rows[0],
    before,
    after,
    duplicate: false
  };
}

async function lockScoinForOrder(client, { userId, amount, orderId }) {
  const amt = Number(amount || 0);
  if (amt <= 0) throw new Error('Invalid amount');

  const key = sellLockKey(orderId);
  const dup = await client.query(
    `SELECT * FROM scoin_transactions WHERE idempotency_key = $1 LIMIT 1`,
    [key]
  );
  if (dup.rows.length) return dup.rows[0];

  const balances = await readUserBalances(client, userId, true);
  if (balances.available < amt) throw new Error('Scoin balance is not enough');

  const newLocked = +(balances.locked + amt).toFixed(4);
  await client.query(`UPDATE users SET scoin_locked_balance = $2 WHERE id = $1`, [userId, newLocked]);

  const insertRes = await client.query(
    `INSERT INTO scoin_transactions (
      user_id, tx_type, direction, amount, fee_amount,
      balance_before, balance_after, meta_json, tx_ref, idempotency_key, source, status
    ) VALUES ($1,'market_sell_hold','out',$2,0,$3,$3,$4::jsonb,$5,$6,'web','pending')
    RETURNING *`,
    [
      userId,
      amt,
      balances.balance,
      JSON.stringify({
        market_order_id: orderId,
        locked_balance_after: newLocked,
        note: 'hold for pending sell order'
      }),
      generateTxRef(),
      key
    ]
  );

  return insertRes.rows[0];
}

async function finalizeSellLock(client, { userId, amount, orderId, meta = {} }) {
  const amt = Number(amount || 0);
  if (amt <= 0) throw new Error('Invalid amount');

  const balances = await readUserBalances(client, userId, true);

  if (balances.locked < amt) {
    if (balances.locked === 0 && balances.balance >= amt) {
      const result = await postTransaction(client, {
        userId,
        direction: 'out',
        amount: amt,
        txType: 'market_sell',
        idempotencyKey: `market-sell-${orderId}`,
        meta: { market_order_id: orderId, ...meta, legacy_no_lock: true }
      });
      return result.tx;
    }
    throw new Error('Locked Scoin is not enough');
  }

  if (balances.balance < amt) throw new Error('Scoin balance is not enough');

  const before = balances.balance;
  const after = +(before - amt).toFixed(4);
  const newLocked = +(balances.locked - amt).toFixed(4);

  await client.query(
    `UPDATE users SET scoin_balance = $2, scoin_locked_balance = $3 WHERE id = $1`,
    [userId, after, newLocked]
  );

  await client.query(
    `UPDATE scoin_transactions
     SET status = 'confirmed',
         balance_after = $3,
         meta_json = meta_json || $4::jsonb
     WHERE idempotency_key = $1
       AND user_id = $2
       AND tx_type = 'market_sell_hold'`,
    [sellLockKey(orderId), userId, after, JSON.stringify({ finalized: true })]
  );

  const insertRes = await client.query(
    `INSERT INTO scoin_transactions (
      user_id, tx_type, direction, amount, fee_amount,
      balance_before, balance_after, meta_json, tx_ref, source, status
    ) VALUES ($1,'market_sell','out',$2,0,$3,$4,$5::jsonb,$6,'web','confirmed')
    RETURNING *`,
    [
      userId,
      amt,
      before,
      after,
      JSON.stringify({ market_order_id: orderId, ...meta }),
      generateTxRef()
    ]
  );

  return insertRes.rows[0];
}

async function releaseSellLock(client, { userId, amount, orderId, reason = 'cancelled' }) {
  const amt = Number(amount || 0);
  if (amt <= 0) throw new Error('Invalid amount');

  const balances = await readUserBalances(client, userId, true);
  if (balances.locked < amt) throw new Error('Locked Scoin is not enough');

  const newLocked = +(balances.locked - amt).toFixed(4);
  await client.query(`UPDATE users SET scoin_locked_balance = $2 WHERE id = $1`, [userId, newLocked]);

  await client.query(
    `UPDATE scoin_transactions
     SET status = 'cancelled',
         meta_json = meta_json || $4::jsonb
     WHERE idempotency_key = $1
       AND user_id = $2
       AND tx_type = 'market_sell_hold'`,
    [sellLockKey(orderId), userId, amt, JSON.stringify({ released: true, reason })]
  );

  return { lockedAfter: newLocked };
}

async function withLedgerTransaction(fn, existingClient = null) {
  const ownClient = !existingClient;
  const client = existingClient || await getClient();

  try {
    if (ownClient) await client.query('BEGIN');
    const result = await fn(client);
    if (ownClient) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (ownClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownClient) client.release();
  }
}

module.exports = {
  TX_SOURCE,
  TX_STATUS,
  generateTxRef,
  generateTransferGroupId,
  sellLockKey,
  readUserBalances,
  postTransaction,
  lockScoinForOrder,
  finalizeSellLock,
  releaseSellLock,
  withLedgerTransaction
};
