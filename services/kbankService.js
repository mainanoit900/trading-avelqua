const crypto = require('crypto');
const axios = require('axios');
const { query } = require('../config/database');

async function getKbankConfig() {
  let db = {};
  try {
    const result = await query(`SELECT * FROM kbank_api_settings WHERE id = 1 LIMIT 1`);
    db = result.rows[0] || {};
  } catch (error) {
    db = {};
  }

  const cfg = {
    publicKey: db.public_key || process.env.KBANK_PUBLIC_KEY || '',
    secretKey: db.secret_key || process.env.KBANK_SECRET_KEY || '',
    merchantId: db.merchant_id || process.env.KBANK_MERCHANT_ID || '',
    baseUrl: db.base_url || process.env.KBANK_BASE_URL || '',
    mockMode: typeof db.mock_mode === 'boolean'
      ? db.mock_mode
      : String(process.env.KBANK_MOCK_MODE || 'true').toLowerCase() === 'true',
    enabled: typeof db.is_enabled === 'boolean' ? db.is_enabled : true,
    qrEnabled: typeof db.qr_enabled === 'boolean' ? db.qr_enabled : true,
    cardEnabled: typeof db.card_enabled === 'boolean' ? db.card_enabled : true
  };

  cfg.ready = !!(cfg.publicKey && cfg.secretKey && cfg.merchantId && cfg.baseUrl && cfg.enabled);
  cfg.mockMode = cfg.mockMode || !cfg.ready;
  return cfg;
}

function isKbankReady() {
  return !!(
    process.env.KBANK_PUBLIC_KEY &&
    process.env.KBANK_SECRET_KEY &&
    process.env.KBANK_MERCHANT_ID &&
    process.env.KBANK_BASE_URL
  );
}

function isMockMode() {
  return String(process.env.KBANK_MOCK_MODE || 'true').toLowerCase() === 'true' || !isKbankReady();
}

function makeScoinRef(orderId) {
  return `SCOIN-${orderId}-${Date.now()}`;
}

function makePackageRef(paymentId) {
  return `PACKAGE-${paymentId}-${Date.now()}`;
}

async function createKbankPaymentForScoin(order) {
  const amount = Number(order.net_amount_thb || order.gross_amount_thb || 0);
  const ref = makeScoinRef(order.id);
  const cfg = await getKbankConfig();

  if (cfg.mockMode) {
    return {
      ok: true,
      mock: true,
      ref,
      payment_url: '',
      qr_text: `MOCK-KBANK-QR|TYPE=SCOIN|ORDER=${order.id}|AMOUNT=${amount.toFixed(2)}|REF=${ref}`,
      gateway_order_id: ref
    };
  }

  const payload = {
    merchant_id: cfg.merchantId,
    amount: amount.toFixed(2),
    currency: 'THB',
    order_id: ref,
    description: `Buy Scoin order #${order.id}`,
    metadata: {
      local_order_id: order.id,
      type: 'scoin_buy'
    }
  };

  const response = await axios.post(
    `${cfg.baseUrl}/api/payment/orders`,
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.secretKey}`,
        'x-api-key': cfg.publicKey
      },
      timeout: 20000
    }
  );

  return {
    ok: true,
    mock: false,
    ref,
    raw: response.data,
    payment_url: response.data.payment_url || response.data.redirect_url || '',
    qr_text: response.data.qr_text || response.data.qr_code || '',
    gateway_order_id: response.data.id || response.data.order_id || ref
  };
}

async function createKbankPaymentForPackage(payment) {
  const amount = Number(payment.final_amount ?? payment.amount ?? 0);
  const ref = makePackageRef(payment.id);
  const method = String(payment.payment_method || 'promptpay_qr').toLowerCase();
  const cfg = await getKbankConfig();

  if (cfg.mockMode) {
    return {
      ok: true,
      mock: true,
      ref,
      method,
      payment_url: '',
      qr_text: method === 'promptpay_qr'
        ? `MOCK-KBANK-QR|TYPE=PACKAGE|PAYMENT=${payment.id}|AMOUNT=${amount.toFixed(2)}|REF=${ref}`
        : '',
      gateway_order_id: ref
    };
  }

  const appUrl = process.env.APP_BASE_URL || process.env.BASE_URL || 'https://trading.avelqua.com';

  const payload = {
    merchant_id: cfg.merchantId,
    amount: amount.toFixed(2),
    currency: 'THB',
    order_id: ref,
    payment_method: method,
    description: `Buy Package payment #${payment.id}`,
    metadata: {
      local_payment_id: payment.id,
      type: 'package_buy',
      package_id: payment.package_id || null
    },
    redirect_url: `${appUrl}/app/package-payment/${payment.id}`,
    webhook_url: `${appUrl}/app/kbank/package-webhook`
  };

  const response = await axios.post(
    `${cfg.baseUrl}/api/payment/orders`,
    payload,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.secretKey}`,
        'x-api-key': cfg.publicKey
      },
      timeout: 20000
    }
  );

  return {
    ok: true,
    mock: false,
    ref,
    method,
    raw: response.data,
    payment_url: response.data.payment_url || response.data.redirect_url || '',
    qr_text: response.data.qr_text || response.data.qr_code || '',
    gateway_order_id: response.data.id || response.data.order_id || ref
  };
}

async function verifyKbankWebhook(req) {
  const cfg = await getKbankConfig();
  if (cfg.mockMode) return true;

  const secret = cfg.secretKey || '';
  const signature = req.headers['x-kbank-signature'] || req.headers['x-signature'];

  if (!signature || !secret) return false;

  const raw = JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(String(signature)),
      Buffer.from(String(expected))
    );
  } catch (error) {
    return false;
  }
}

module.exports = {
  isKbankReady,
  isMockMode,
  getKbankConfig,
  createKbankPaymentForScoin,
  createKbankPaymentForPackage,
  verifyKbankWebhook
};
