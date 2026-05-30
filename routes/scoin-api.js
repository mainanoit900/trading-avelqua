const express = require('express');
const { requireLogin } = require('../middleware/requireAuth');
const { query } = require('../config/database');
const { ensureUserWallet, getScoinSettings } = require('../services/scoinService');

const router = express.Router();
router.use(requireLogin);

const SCOIN_NETWORK = 'avelqua-ledger-v1';

function currentUser(req) {
  return req.user || req.session.user || null;
}

router.get('/v1/scoin/balance', async (req, res) => {
  try {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const settings = await getScoinSettings();
    const rowRes = await query(
      `SELECT scoin_balance, COALESCE(scoin_locked_balance, 0) AS scoin_locked_balance
       FROM users WHERE id = $1 LIMIT 1`,
      [user.id]
    );
    const row = rowRes.rows[0] || {};
    const balance = Number(row.scoin_balance || 0);
    const locked = Number(row.scoin_locked_balance || 0);
    const available = Math.max(0, +(balance - locked).toFixed(4));
    const priceThb = Number(settings.current_price_thb || 0);

    return res.json({
      ok: true,
      data: {
        symbol: settings.coin_symbol || 'SCOIN',
        name: settings.coin_name || 'Scoin',
        balance,
        locked_balance: locked,
        available_balance: available,
        price_thb: priceThb,
        value_thb: +(available * priceThb).toFixed(2),
        network: SCOIN_NETWORK,
        decimals: 4
      }
    });
  } catch (error) {
    console.error('scoin api balance error:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.get('/v1/scoin/wallet', async (req, res) => {
  try {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const wallet = await ensureUserWallet(user.id);
    return res.json({
      ok: true,
      data: {
        wallet_code: wallet?.wallet_code || null,
        wallet_type: wallet?.wallet_type || 'user',
        is_active: wallet?.is_active !== false,
        network: SCOIN_NETWORK,
        address_format: 'SCN-XXXX-XXXX-XXXX-XXXX'
      }
    });
  } catch (error) {
    console.error('scoin api wallet error:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.get('/v1/scoin/transactions', async (req, res) => {
  try {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;
    const direction = String(req.query.direction || '').trim().toLowerCase();

    const params = [user.id];
    let directionSql = '';
    if (direction === 'in' || direction === 'out') {
      directionSql = ` AND st.direction = $${params.length + 1}`;
      params.push(direction);
    }

    params.push(limit, offset);

    const listRes = await query(
      `SELECT
         st.id,
         st.tx_ref,
         st.tx_type,
         st.direction,
         st.amount,
         st.fee_amount,
         st.balance_before,
         st.balance_after,
         st.status,
         st.source,
         st.transfer_group_id,
         st.ref_user_id,
         st.ref_payment_id,
         st.meta_json,
         st.created_at
       FROM scoin_transactions st
       WHERE st.user_id = $1${directionSql}
       ORDER BY st.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = [user.id];
    let countDirectionSql = '';
    if (direction === 'in' || direction === 'out') {
      countDirectionSql = ` AND direction = $2`;
      countParams.push(direction);
    }

    const countRes = await query(
      `SELECT COUNT(*)::int AS total
       FROM scoin_transactions
       WHERE user_id = $1${countDirectionSql}`,
      countParams
    );

    const total = Number(countRes.rows[0]?.total || 0);

    return res.json({
      ok: true,
      data: {
        items: listRes.rows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.max(1, Math.ceil(total / limit))
        },
        network: SCOIN_NETWORK
      }
    });
  } catch (error) {
    console.error('scoin api transactions error:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
