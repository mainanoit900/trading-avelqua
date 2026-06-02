const { query, getClient } = require('../config/database');
const {
  isStripeReady,
  retrieveStripeCheckoutSession
} = require('./stripeService');
const { applyPaidPackageSubscription } = require('../lib/subscriptionPackage');
const { distributeScoinEconomy } = require('./scoinService');

const reconcileIntervalMsEnv = Number.parseInt(
  process.env.STRIPE_PENDING_RECONCILE_INTERVAL_MS || String(30 * 1000),
  10
);
const reconcileLookbackSecEnv = Number.parseInt(
  process.env.STRIPE_PENDING_RECONCILE_LOOKBACK_SEC || String(3 * 24 * 60 * 60),
  10
);
const reconcileBatchSizeEnv = Number.parseInt(
  process.env.STRIPE_PENDING_RECONCILE_BATCH_SIZE || '30',
  10
);

const STRIPE_PENDING_RECONCILE_INTERVAL_MS =
  Number.isFinite(reconcileIntervalMsEnv) && reconcileIntervalMsEnv > 0
    ? Math.max(10000, reconcileIntervalMsEnv)
    : 30 * 1000;
const STRIPE_PENDING_RECONCILE_LOOKBACK_SEC =
  Number.isFinite(reconcileLookbackSecEnv) && reconcileLookbackSecEnv > 0
    ? Math.max(3600, reconcileLookbackSecEnv)
    : 3 * 24 * 60 * 60;
const STRIPE_PENDING_RECONCILE_BATCH_SIZE =
  Number.isFinite(reconcileBatchSizeEnv) && reconcileBatchSizeEnv > 0
    ? Math.max(5, Math.min(200, reconcileBatchSizeEnv))
    : 30;

let schedulerStarted = false;
let reconcileRunning = false;

function parseJsonObject(input) {
  if (!input) return {};
  if (typeof input === 'object') return input;
  if (typeof input !== 'string') return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function resolveStripeSessionId(paymentRow) {
  const paymentRef = String(paymentRow?.payment_ref || '').trim();
  if (paymentRef.startsWith('cs_')) return paymentRef;
  const payload = parseJsonObject(paymentRow?.raw_payload);
  const checkoutRef = String(payload?.stripe_checkout?.ref || '').trim();
  if (checkoutRef.startsWith('cs_')) return checkoutRef;
  return '';
}

async function activateStripePaidPackagePayment(paymentRow, session, sourceNote) {
  const client = await getClient();
  let latestPayment = paymentRow;

  try {
    await client.query('BEGIN');
    const paymentRes = await client.query(
      `SELECT *
       FROM payments
       WHERE id = $1
       FOR UPDATE`,
      [paymentRow.id]
    );
    latestPayment = paymentRes.rows[0];
    if (!latestPayment) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'payment_not_found' };
    }

    const statusNorm = String(latestPayment.payment_status || '').trim().toLowerCase();
    if (statusNorm === 'paid') {
      await client.query('ROLLBACK');
      return { ok: true, alreadyPaid: true };
    }

    if (!['pending', 'waiting', 'unpaid', 'cancelled'].includes(statusNorm)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: `status_${statusNorm || 'unknown'}` };
    }

    const payloadPatch = {
      stripe_reconcile: {
        session_id: session.id || null,
        payment_intent: session.payment_intent || null,
        payment_status: session.payment_status || null,
        reconciled_at: new Date().toISOString()
      }
    };

    await client.query(
      `UPDATE payments
       SET payment_status = 'paid',
           paid_at = COALESCE(paid_at, NOW()),
           auto_confirmed_at = NOW(),
           auto_confirm_note = $2,
           payment_ref = COALESCE(NULLIF(payment_ref, ''), $3),
           payment_method = COALESCE(NULLIF(payment_method, ''), 'stripe_promptpay'),
           raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $4::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [
        latestPayment.id,
        sourceNote,
        String(session.id || '').trim() || null,
        JSON.stringify(payloadPatch)
      ]
    );

    if (latestPayment.package_id) {
      const pkgRes = await client.query(
        `SELECT *
         FROM packages
         WHERE id = $1
         LIMIT 1`,
        [latestPayment.package_id]
      );
      const pkg = pkgRes.rows[0];
      if (pkg) {
        await applyPaidPackageSubscription({
          client,
          userId: latestPayment.user_id,
          packageRow: pkg,
          sourceChannel: `payment:${latestPayment.id}`
        });
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    throw error;
  } finally {
    client.release();
  }

  if (latestPayment?.package_id) {
    await distributeScoinEconomy({
      userId: latestPayment.user_id,
      paymentId: latestPayment.id,
      packageId: latestPayment.package_id,
      amountThb: Number(latestPayment.final_amount ?? latestPayment.amount ?? 0)
    }).catch(() => null);
  }

  return { ok: true, alreadyPaid: false };
}

async function reconcileStripePendingPaymentsOnce() {
  if (!isStripeReady()) return { scanned: 0, confirmed: 0 };

  const candidates = await query(
    `
    SELECT *
    FROM payments
    WHERE package_id IS NOT NULL
      AND LOWER(TRIM(COALESCE(payment_method, ''))) IN ('stripe_card', 'stripe_promptpay')
      AND LOWER(TRIM(COALESCE(payment_status, ''))) IN ('pending', 'waiting', 'unpaid', 'cancelled')
      AND created_at >= NOW() - ($1::int * INTERVAL '1 second')
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `,
    [STRIPE_PENDING_RECONCILE_LOOKBACK_SEC, STRIPE_PENDING_RECONCILE_BATCH_SIZE]
  ).catch((error) => {
    console.error('[StripePendingReconcile] query error:', error.message);
    return { rows: [] };
  });

  let scanned = 0;
  let confirmed = 0;

  for (const paymentRow of candidates.rows || []) {
    scanned += 1;
    const sessionId = resolveStripeSessionId(paymentRow);
    if (!sessionId) continue;

    try {
      const session = await retrieveStripeCheckoutSession(sessionId);
      const sessionPaymentStatus = String(session?.payment_status || '').trim().toLowerCase();
      if (sessionPaymentStatus !== 'paid') continue;

      const metadataType = String(session?.metadata?.local_type || '').trim().toLowerCase();
      if (metadataType && metadataType !== 'package_buy') continue;

      const metadataPaymentId = Number(session?.metadata?.local_payment_id || session?.client_reference_id || 0);
      if (metadataPaymentId > 0 && metadataPaymentId !== Number(paymentRow.id)) continue;

      const statusNorm = String(paymentRow.payment_status || '').trim().toLowerCase();
      const sourceNote = statusNorm === 'cancelled'
        ? 'Stripe reconcile auto confirm (recovered from cancelled)'
        : 'Stripe reconcile auto confirm';

      const result = await activateStripePaidPackagePayment(paymentRow, session, sourceNote);
      if (result.ok && !result.alreadyPaid) confirmed += 1;
    } catch (error) {
      console.error(
        `[StripePendingReconcile] payment_id=${paymentRow.id} session_id=${sessionId} error:`,
        error.message
      );
    }
  }

  if (confirmed > 0) {
    console.log(
      `[StripePendingReconcile] confirmed ${confirmed} payment(s) from ${scanned} candidate(s)`
    );
  }

  return { scanned, confirmed };
}

async function runReconcileSafely() {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try {
    await reconcileStripePendingPaymentsOnce();
  } catch (error) {
    console.error('[StripePendingReconcile] run error:', error.message);
  } finally {
    reconcileRunning = false;
  }
}

function startStripePendingPaymentReconcileScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  if (!isStripeReady()) {
    console.log('[StripePendingReconcile] skipped — Stripe not configured');
    return;
  }

  runReconcileSafely();
  setInterval(runReconcileSafely, STRIPE_PENDING_RECONCILE_INTERVAL_MS);
  console.log(
    `[StripePendingReconcile] started interval=${STRIPE_PENDING_RECONCILE_INTERVAL_MS}ms lookback=${STRIPE_PENDING_RECONCILE_LOOKBACK_SEC}s batch=${STRIPE_PENDING_RECONCILE_BATCH_SIZE}`
  );
}

module.exports = {
  STRIPE_PENDING_RECONCILE_INTERVAL_MS,
  STRIPE_PENDING_RECONCILE_LOOKBACK_SEC,
  STRIPE_PENDING_RECONCILE_BATCH_SIZE,
  reconcileStripePendingPaymentsOnce,
  startStripePendingPaymentReconcileScheduler
};
