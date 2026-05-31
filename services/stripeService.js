const Stripe = require('stripe');

let stripeClient = null;
let stripeKeyCached = '';

function getStripeConfig() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  const publishableKey = String(process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
  const enabled = String(process.env.STRIPE_ENABLED || 'true').trim().toLowerCase() !== 'false';
  return {
    enabled,
    secretKey,
    webhookSecret,
    publishableKey
  };
}

function isStripeReady() {
  const cfg = getStripeConfig();
  return cfg.enabled && !!cfg.secretKey;
}

function getStripeClientOrThrow() {
  const cfg = getStripeConfig();
  if (!cfg.enabled) {
    throw new Error('Stripe ถูกปิดใช้งานอยู่');
  }
  if (!cfg.secretKey) {
    throw new Error('ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY');
  }
  if (!stripeClient || stripeKeyCached !== cfg.secretKey) {
    stripeClient = new Stripe(cfg.secretKey);
    stripeKeyCached = cfg.secretKey;
  }
  return stripeClient;
}

function getAppBaseUrl() {
  return String(
    process.env.APP_BASE_URL ||
    process.env.BASE_URL ||
    'https://trading.avelqua.com'
  ).replace(/\/+$/, '');
}

function toAmountSatang(amountThb) {
  const value = Number(amountThb || 0);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('ยอดชำระไม่ถูกต้อง');
  }
  return Math.round(value * 100);
}

function normalizePackagePaymentMethod(inputMethod) {
  const method = String(inputMethod || '').trim().toLowerCase();
  if (method === 'promptpay_qr' || method === 'stripe_promptpay') return 'promptpay_qr';
  return 'credit_card';
}

async function createStripeCheckoutForPackage(payment, options = {}) {
  const stripe = getStripeClientOrThrow();
  const amountSatang = toAmountSatang(payment.final_amount ?? payment.amount ?? 0);
  const appBaseUrl = getAppBaseUrl();
  const paymentId = Number(payment.id || 0);
  const packageName = String(payment.package_name_snapshot || `Package #${payment.package_id || '-'}`);
  const paymentMethod = normalizePackagePaymentMethod(options.paymentMethod || payment.payment_method);
  const stripePaymentMethodType = paymentMethod === 'promptpay_qr' ? 'promptpay' : 'card';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: [stripePaymentMethodType],
    customer_email: payment.payer_email || undefined,
    client_reference_id: String(paymentId),
    metadata: {
      local_type: 'package_buy',
      local_payment_id: String(paymentId),
      local_user_id: String(payment.user_id || ''),
      package_id: String(payment.package_id || ''),
      payment_method: paymentMethod
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'thb',
          unit_amount: amountSatang,
          product_data: {
            name: packageName
          }
        }
      }
    ],
    success_url: `${appBaseUrl}/app/package-payment/${paymentId}?provider=stripe&result=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appBaseUrl}/app/package-payment/${paymentId}?provider=stripe&result=cancel`
  });

  return {
    ok: true,
    provider: 'stripe',
    method: paymentMethod,
    ref: session.id,
    payment_url: session.url || '',
    gateway_order_id: session.id,
    raw: session
  };
}

async function createStripeCheckoutForScoin(order) {
  const stripe = getStripeClientOrThrow();
  const amountSatang = toAmountSatang(order.net_amount_thb || order.gross_amount_thb || 0);
  const appBaseUrl = getAppBaseUrl();
  const orderId = Number(order.id || 0);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: String(orderId),
    metadata: {
      local_type: 'scoin_buy',
      local_order_id: String(orderId),
      local_user_id: String(order.user_id || ''),
      scoin_amount: String(order.scoin_amount || 0)
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'thb',
          unit_amount: amountSatang,
          product_data: {
            name: `Buy Scoin #${orderId}`
          }
        }
      }
    ],
    success_url: `${appBaseUrl}/app/scoin-market/payment/${orderId}?provider=stripe&result=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appBaseUrl}/app/scoin-market/payment/${orderId}?provider=stripe&result=cancel`
  });

  return {
    ok: true,
    provider: 'stripe',
    method: 'credit_card',
    ref: session.id,
    payment_url: session.url || '',
    gateway_order_id: session.id,
    raw: session
  };
}

function constructStripeWebhookEvent(req) {
  const stripe = getStripeClientOrThrow();
  const cfg = getStripeConfig();
  if (!cfg.webhookSecret) {
    throw new Error('ยังไม่ได้ตั้งค่า STRIPE_WEBHOOK_SECRET');
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    throw new Error('missing stripe signature');
  }

  const rawBody = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {})));
  return stripe.webhooks.constructEvent(rawBody, signature, cfg.webhookSecret);
}

module.exports = {
  getStripeConfig,
  isStripeReady,
  createStripeCheckoutForPackage,
  createStripeCheckoutForScoin,
  constructStripeWebhookEvent
};
