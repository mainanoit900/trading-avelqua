const { query } = require('../config/database');

const packagePaymentTimeoutSecEnv = Number.parseInt(
  process.env.PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC || '600',
  10
);
const packagePaymentIntervalMsEnv = Number.parseInt(
  process.env.PACKAGE_PAYMENT_AUTO_CANCEL_INTERVAL_MS || String(10 * 1000),
  10
);

const PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC =
  Number.isFinite(packagePaymentTimeoutSecEnv) && packagePaymentTimeoutSecEnv > 0
    ? Math.max(600, packagePaymentTimeoutSecEnv)
    : 600;
const PACKAGE_PAYMENT_AUTO_CANCEL_INTERVAL_MS =
  Number.isFinite(packagePaymentIntervalMsEnv) && packagePaymentIntervalMsEnv > 0
    ? Math.max(5000, packagePaymentIntervalMsEnv)
    : 10 * 1000;

let schedulerStarted = false;
let cancelJobRunning = false;

async function autoCancelPendingPackagePaymentsOnce() {
  const result = await query(
    `
    UPDATE payments
    SET payment_status = 'cancelled',
        updated_at = NOW()
    WHERE package_id IS NOT NULL
      AND COALESCE(LOWER(TRIM(payment_status)), 'pending') = 'pending'
      AND created_at < NOW() - ($1::int * INTERVAL '1 second')
    RETURNING id
  `,
    [PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC]
  ).catch((error) => {
    console.error('[PackagePaymentAutoCancel] query error:', error.message);
    return { rows: [] };
  });

  const cancelledCount = Array.isArray(result?.rows) ? result.rows.length : 0;
  if (cancelledCount > 0) {
    console.log(
      `[PackagePaymentAutoCancel] auto-cancelled ${cancelledCount} pending payment(s) older than ${PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC}s`
    );
  }
  return cancelledCount;
}

async function runAutoCancelSafely() {
  if (cancelJobRunning) return;
  cancelJobRunning = true;
  try {
    await autoCancelPendingPackagePaymentsOnce();
  } catch (error) {
    console.error('[PackagePaymentAutoCancel] run error:', error.message);
  } finally {
    cancelJobRunning = false;
  }
}

function startPackagePaymentAutoCancelScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  runAutoCancelSafely();
  setInterval(runAutoCancelSafely, PACKAGE_PAYMENT_AUTO_CANCEL_INTERVAL_MS);
  console.log(
    `[PackagePaymentAutoCancel] started interval=${PACKAGE_PAYMENT_AUTO_CANCEL_INTERVAL_MS}ms timeout=${PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC}s`
  );
}

module.exports = {
  PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC,
  PACKAGE_PAYMENT_AUTO_CANCEL_INTERVAL_MS,
  autoCancelPendingPackagePaymentsOnce,
  startPackagePaymentAutoCancelScheduler
};
