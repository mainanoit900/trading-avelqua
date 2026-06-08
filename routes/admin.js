const express = require('express');
const { randomUUID } = require('crypto');
const { query, getClient } = require('../config/database');
const requireAdmin = require('../middleware/admin');
const XLSX = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const upload = multer({ dest: '/tmp' });
const { getStripeReceiptUrlForPayment } = require('../services/stripeService');
const { ensurePaymentReceiptSnapshotById } = require('../services/paymentReceiptSnapshot');
const { buildPaymentReceiptView, buildPaymentReceiptViewById } = require('../lib/paymentReceiptView');
const { buildScoinSellReceiptView } = require('../lib/scoinSellReceiptView');

const hostSlipStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '../uploads/host-slips');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(String(file.originalname || '')).toLowerCase() || '.jpg';
    cb(null, `sell-${req.params.id}-${Date.now()}${ext}`);
  }
});

const hostSlipUpload = multer({
  storage: hostSlipStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/i.test(String(file.mimetype || ''));
    cb(ok ? null : new Error('รองรับเฉพาะรูปภาพหรือ PDF'), ok);
  }
});


const backupService = require('../services/backupService');
const {
  resolveSystemVpsId,
  queueSystemAgentCommand,
  fetchLiveHealthMap,
  fetchDbMt5UsageMap,
  isPortAdminDisabled,
  ensureVpsAllocationsAdminColumns,
  setAdminAllocationStatus,
  VPS_ALLOC_PORT_NO_SQL,
  parsePortNumber,
  lookupLiveHealth,
  lookupDbUsage,
  resolveAdminPortMt5State,
  isAgentMt5Running,
  reconcilePortIdleWhenAgentFree,
  queueForceStopMt5,
  syncStaleAdminAllocations,
  expireStaleLockedPorts
} = require('../lib/adminVpsBridge');
const { clearFolderPortBinding } = require('../lib/mt5PortCleanup');

function formatBytes(size) {
  const n = Number(size || 0);
  if (!n) return '-';
  const units = ['B','KB','MB','GB','TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatThaiDateTime(value) {
  if (!value) return '-';
  try {
    return new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(new Date(value));
  } catch (_) { return String(value); }
}

function cronTimeFromLine(line) {
  const parts = String(line || '').trim().split(/\s+/);
  if (parts.length < 2) return '03:00';
  return `${String(parts[1]).padStart(2, '0')}:${String(parts[0]).padStart(2, '0')}`;
}

const {
  distributeScoinEconomy,
  finalizeSellLock,
  releaseSellLock
} = require('../services/scoinService');
const { postTransaction } = require('../lib/scoinLedger');
const {
  ensureScoinCirculationSchema,
  applyMarketCirculation,
  getCirculationSummary,
  lockCentralWallet
} = require('../lib/scoinCirculation');
const { applyAutoPriceAfterTrade } = require('../lib/scoinAutoPrice');
const { applyPaidPackageSubscription } = require('../lib/subscriptionPackage');
const {
  getMt5PortScoinPrices,
  updateMt5PortScoinPrices
} = require('../lib/mt5PortScoinSettings');

const { syncNewsNow } = require('../services/newsSyncService');
const {
  PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC,
  autoCancelPendingPackagePaymentsOnce
} = require('../services/packagePaymentAutoCancelScheduler');

const router = express.Router();


function toPositiveInt(value, fallback = 1) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function ensureScoinMarketAdminColumns(clientOrDb = { query }) {
  const runner = clientOrDb.query ? clientOrDb : { query };
  await runner.query('ALTER TABLE scoin_settings ADD COLUMN IF NOT EXISTS buy_fee_percent numeric(8,4) DEFAULT 3.0000 NOT NULL, ADD COLUMN IF NOT EXISTS sell_fee_percent numeric(8,4) DEFAULT 3.0000 NOT NULL');
}


function scoinExcelDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
}

async function scoinTableExists(tableName) {
  const r = await query('SELECT to_regclass($1) AS name', ['public.' + tableName]);
  return !!(r.rows[0] && r.rows[0].name);
}

async function scoinColumns(tableName) {
  const r = await query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [tableName]);
  return new Set((r.rows || []).map(x => x.column_name));
}

function scoinSelect(cols, alias, wanted) {
  return wanted.map(([col, asName]) => cols.has(col) ? `${alias}.${col} AS ${asName || col}` : `NULL AS ${asName || col}`).join(', ');
}

async function scoinBuildExportQuery(type) {
  if (type === 'orders') {
    if (!(await scoinTableExists('scoin_market_orders'))) return null;
    const c = await scoinColumns('scoin_market_orders');
    const hasUsers = await scoinTableExists('users');
    const joinUser = hasUsers && c.has('user_id') ? 'LEFT JOIN users u ON u.id=o.user_id' : '';
    const userSelect = joinUser ? "u.email AS email, COALESCE(NULLIF(u.full_name,''), u.email) AS full_name" : 'NULL AS email, NULL AS full_name';
    const select = scoinSelect(c, 'o', [['id'], ['display_id'], ['created_at'], ['order_type'], ['status'], ['wallet_code'], ['scoin_amount'], ['price_thb'], ['gross_amount_thb'], ['fee_percent'], ['fee_amount_thb'], ['net_amount_thb'], ['payment_method'], ['payment_status']]);
    const order = c.has('created_at') ? 'ORDER BY o.created_at DESC' : 'ORDER BY o.id DESC';
    return { sheet: 'Scoin Orders', sql: `SELECT ${select}, ${userSelect} FROM scoin_market_orders o ${joinUser} ${order}` };
  }
  if (type === 'wallets') {
    if (!(await scoinTableExists('scoin_wallets'))) return null;
    const c = await scoinColumns('scoin_wallets');
    const hasUsers = await scoinTableExists('users');
    const joinUser = hasUsers && c.has('user_id') ? 'LEFT JOIN users u ON u.id=w.user_id' : '';
    const userSelect = joinUser ? "u.email AS email, COALESCE(NULLIF(u.full_name,''), u.email) AS full_name" : 'NULL AS email, NULL AS full_name';
    const select = scoinSelect(c, 'w', [['id'], ['display_id'], ['created_at'], ['wallet_code'], ['wallet_type'], ['is_active']]);
    const order = c.has('created_at') ? 'ORDER BY w.created_at DESC' : 'ORDER BY w.id DESC';
    return { sheet: 'Scoin Wallets', sql: `SELECT ${select}, ${userSelect} FROM scoin_wallets w ${joinUser} ${order}` };
  }
  if (type === 'transactions') {
    if (!(await scoinTableExists('scoin_transactions'))) return null;
    const c = await scoinColumns('scoin_transactions');
    const hasUsers = await scoinTableExists('users');
    const joinUser = hasUsers && c.has('user_id') ? 'LEFT JOIN users u ON u.id=st.user_id' : '';
    const userSelect = joinUser ? "u.email AS email, COALESCE(NULLIF(u.full_name,''), u.email) AS full_name" : 'NULL AS email, NULL AS full_name';
    const select = scoinSelect(c, 'st', [['id'], ['display_id'], ['created_at'], ['tx_type'], ['direction'], ['amount'], ['fee_amount'], ['balance_before'], ['balance_after']]);
    const order = c.has('created_at') ? 'ORDER BY st.created_at DESC' : 'ORDER BY st.id DESC';
    return { sheet: 'Scoin Transactions', sql: `SELECT ${select}, ${userSelect} FROM scoin_transactions st ${joinUser} ${order}` };
  }
  if (type === 'economy') {
    if (!(await scoinTableExists('scoin_economy_logs'))) return null;
    const c = await scoinColumns('scoin_economy_logs');
    const select = scoinSelect(c, 'e', [['id'], ['display_id'], ['created_at'], ['user_id'], ['payment_id'], ['package_id'], ['package_price_thb'], ['user_receive_scoin'], ['company_profit_thb'], ['network_bonus_thb'], ['buyback_reserve_thb'], ['burn_liquidity_thb'], ['promotion_thb'], ['system_marketing_thb']]);
    const order = c.has('created_at') ? 'ORDER BY e.created_at DESC' : 'ORDER BY e.id DESC';
    return { sheet: 'Scoin Economy Logs', sql: `SELECT ${select} FROM scoin_economy_logs e ${order}` };
  }
  if (type === 'circulation') {
    if (!(await scoinTableExists('scoin_circulation_logs'))) return null;
    const c = await scoinColumns('scoin_circulation_logs');
    const hasUsers = await scoinTableExists('users');
    const joinUser = hasUsers && c.has('user_id') ? 'LEFT JOIN users u ON u.id = l.user_id' : '';
    const userSelect = joinUser ? "u.email AS email, COALESCE(NULLIF(u.full_name,''), u.email) AS full_name" : 'NULL AS email, NULL AS full_name';
    const select = scoinSelect(c, 'l', [
      ['id'], ['market_order_id'], ['user_id'], ['flow_type'], ['scoin_amount'],
      ['thb_gross'], ['thb_fee'], ['thb_net'],
      ['central_scoin_before'], ['central_scoin_after'],
      ['central_thb_before'], ['central_thb_after'],
      ['market_supply_before'], ['market_supply_after'],
      ['circulation_volume_total'], ['note'], ['created_at']
    ]);
    const order = c.has('created_at') ? 'ORDER BY l.created_at DESC' : 'ORDER BY l.id DESC';
    return { sheet: 'Scoin Circulation', sql: `SELECT ${select}, ${userSelect} FROM scoin_circulation_logs l ${joinUser} ${order}` };
  }
  return null;
}

function generateWalletCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
  return `SCN-${block()}-${block()}-${block()}-${block()}`;
}

function flash(req) {
  const out = {
    success: req.session.success || '',
    error: req.session.error || ''
  };
  req.session.success = '';
  req.session.error = '';
  return out;
}

function baseView(req, extra = {}) {
  return {
    pageTitle: extra.pageTitle || 'Admin',
    currentPath: extra.currentPath || '/admin',
    currentUrl: req.originalUrl || extra.currentPath || '/admin',
    user: req.user || req.session.user || null,
    ...flash(req),
    ...extra
  };
}

async function getAdminSummary() {
  const [userStats, packageStats, paymentStats, couponStats, aiStats, newsStats, vpsStats] = await Promise.all([
    query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'banned')::int AS banned
      FROM users
    `),
    query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_enabled IS TRUE)::int AS enabled
      FROM packages
    `),
    query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
        COALESCE(SUM(final_amount) FILTER (WHERE payment_status = 'paid'),0)::numeric AS revenue
      FROM payments
    `),
    query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active IS TRUE)::int AS active
      FROM coupons
    `),
    query(`
      SELECT is_enabled, save_chat_history, hide_system_structure
      FROM ai_settings
      WHERE id = 1
      LIMIT 1
    `).catch(() => ({ rows: [{}] })),
    query(`
      SELECT auto_update_enabled, ai_analysis_enabled, auto_translate_enabled
      FROM news_settings
      WHERE id = 1
      LIMIT 1
    `).catch(() => ({ rows: [{}] })),
    query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'available')::int AS available,
        COUNT(*) FILTER (WHERE status = 'busy')::int AS busy,
        COUNT(*) FILTER (WHERE status = 'offline')::int AS offline
      FROM vps_nodes
    `).catch(() => ({ rows: [{ total: 0, available: 0, busy: 0, offline: 0 }] }))
  ]);

  return {
    users: userStats.rows[0] || {},
    packages: packageStats.rows[0] || {},
    payments: paymentStats.rows[0] || {},
    coupons: couponStats.rows[0] || {},
    ai: aiStats.rows[0] || {},
    news: newsStats.rows[0] || {},
    vps: vpsStats.rows[0] || {}
  };
}

function fillDashboardDailySeries(rows = [], days = 14) {
  const map = new Map(
    (rows || []).map((row) => [String(row.label || ''), Number(row.total || 0)])
  );
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const label = date.toISOString().slice(0, 10);
    result.push({
      label,
      total: map.get(label) || 0,
      display: date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
    });
  }
  return result;
}

function dashboardPaymentChannelLabel(method = '') {
  const value = String(method || '').trim().toLowerCase();
  if (['scoin', 'scoin_package'].includes(value)) return 'Scoin';
  if (['stripe_card', 'credit_card', 'card'].includes(value)) return 'บัตรเครดิต';
  if (['stripe_promptpay', 'promptpay_qr', 'kbank', 'promptpay'].includes(value)) return 'PromptPay';
  if (value === 'free_coupon') return 'คูปอง';
  return 'อื่นๆ';
}

router.get('/', async (req, res) => {
  try {
    const [
      summary,
      recentPaymentsRes,
      expiringRes,
      deploymentsRes,
      revenueDailyRes,
      paymentStatusRes,
      periodStatsRes,
      channelStatsRes,
      subscriptionsRes
    ] = await Promise.all([
      getAdminSummary(),
      query(`
        SELECT
          id,
          payer_name,
          payer_email,
          package_name_snapshot,
          final_amount,
          payment_status,
          payment_method,
          created_at
        FROM payments
        WHERE package_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 8
      `),
      query(`
        SELECT
          u.full_name,
          u.email,
          s.package_name_snapshot,
          s.end_at
        FROM user_subscriptions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.status = 'active'
          AND s.end_at IS NOT NULL
        ORDER BY s.end_at ASC
        LIMIT 6
      `),
      query(`
        SELECT
          bs.session_code,
          bs.status,
          bs.symbol,
          bs.lot_in_use,
          bs.ports_in_use,
          u.full_name,
          vn.node_name
        FROM bot_sessions bs
        LEFT JOIN users u ON u.id = bs.user_id
        LEFT JOIN vps_nodes vn ON vn.id = bs.node_id
        ORDER BY bs.updated_at DESC
        LIMIT 6
      `).catch(() => ({ rows: [] })),
      query(`
        SELECT
          TO_CHAR(COALESCE(paid_at, created_at), 'YYYY-MM-DD') AS label,
          COALESCE(SUM(final_amount), 0)::numeric AS total
        FROM payments
        WHERE payment_status = 'paid'
          AND package_id IS NOT NULL
          AND COALESCE(paid_at, created_at) >= NOW() - INTERVAL '14 day'
        GROUP BY 1
        ORDER BY 1 ASC
      `),
      query(`
        SELECT
          COALESCE(NULLIF(LOWER(payment_status), ''), 'unknown') AS status,
          COUNT(*)::int AS count
        FROM payments
        WHERE package_id IS NOT NULL
        GROUP BY 1
        ORDER BY count DESC
      `),
      query(`
        SELECT
          COUNT(*) FILTER (
            WHERE payment_status = 'paid'
              AND DATE(COALESCE(paid_at, created_at)) = CURRENT_DATE
          )::int AS today_count,
          COALESCE(SUM(final_amount) FILTER (
            WHERE payment_status = 'paid'
              AND DATE(COALESCE(paid_at, created_at)) = CURRENT_DATE
          ), 0)::numeric AS today_revenue,
          COUNT(*) FILTER (
            WHERE payment_status = 'paid'
              AND DATE_TRUNC('month', COALESCE(paid_at, created_at)) = DATE_TRUNC('month', CURRENT_DATE)
          )::int AS month_count,
          COALESCE(SUM(final_amount) FILTER (
            WHERE payment_status = 'paid'
              AND DATE_TRUNC('month', COALESCE(paid_at, created_at)) = DATE_TRUNC('month', CURRENT_DATE)
          ), 0)::numeric AS month_revenue
        FROM payments
        WHERE package_id IS NOT NULL
      `),
      query(`
        SELECT
          CASE
            WHEN LOWER(COALESCE(payment_method, '')) IN ('scoin', 'scoin_package') THEN 'Scoin'
            WHEN LOWER(COALESCE(payment_method, '')) IN ('stripe_card', 'credit_card', 'card') THEN 'บัตรเครดิต'
            WHEN LOWER(COALESCE(payment_method, '')) IN ('stripe_promptpay', 'promptpay_qr', 'kbank', 'promptpay') THEN 'PromptPay'
            WHEN LOWER(COALESCE(payment_method, '')) = 'free_coupon' THEN 'คูปอง'
            ELSE 'อื่นๆ'
          END AS channel,
          COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS count
        FROM payments
        WHERE package_id IS NOT NULL
        GROUP BY 1
        ORDER BY count DESC
      `),
      query(`
        SELECT COUNT(*)::int AS active
        FROM user_subscriptions
        WHERE status = 'active'
      `).catch(() => ({ rows: [{ active: 0 }] }))
    ]);

    const periodStats = periodStatsRes.rows[0] || {};
    const paymentStatusBreakdown = (paymentStatusRes.rows || []).map((row) => ({
      status: row.status,
      label: paymentStatusLabel(row.status),
      count: Number(row.count || 0)
    }));
    const channelBreakdown = (channelStatsRes.rows || []).map((row) => ({
      channel: row.channel,
      count: Number(row.count || 0)
    }));
    const recentPayments = (recentPaymentsRes.rows || []).map((row) => ({
      ...row,
      status_label: paymentStatusLabel(row.payment_status),
      channel_label: dashboardPaymentChannelLabel(row.payment_method)
    }));

    return res.render('admin/dashboard', baseView(req, {
      pageTitle: 'Admin Dashboard',
      pageCss: 'admin-dashboard.css',
      currentPath: '/admin',
      summary,
      periodStats,
      paymentStatusBreakdown,
      channelBreakdown,
      activeSubscriptions: Number(subscriptionsRes.rows[0]?.active || 0),
      recentPayments,
      expiringSubscriptions: expiringRes.rows,
      recentDeployments: deploymentsRes.rows,
      revenueDaily: fillDashboardDailySeries(revenueDailyRes.rows, 14),
      dashboardNow: new Date().toLocaleString('th-TH', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    }));
  } catch (error) {
    console.error(error);
    return res.status(500).send(error.message || 'Admin dashboard error');
  }
});

const USER_PAGE_SIZE = 15;

function buildUsersWhere({ q = '', status = '', role = '', identity = '' }, params) {
  const where = [];

  const searchText = String(q || '').trim();
  if (searchText) {
    params.push(`%${searchText}%`);
    const idx = params.length;
    where.push(`(
      CAST(u.id AS TEXT) ILIKE $${idx}
      OR COALESCE(u.display_id,'') ILIKE $${idx}
      OR COALESCE(u.email,'') ILIKE $${idx}
      OR COALESCE(u.phone,'') ILIKE $${idx}
      OR COALESCE(u.full_name,'') ILIKE $${idx}
      OR COALESCE(u.first_name,'') ILIKE $${idx}
      OR COALESCE(u.last_name,'') ILIKE $${idx}
    )`);
  }

  const statusText = String(status || '').trim();
  if (statusText) {
    params.push(statusText);
    where.push(`COALESCE(u.status,'active') = $${params.length}`);
  }

  const roleText = String(role || '').trim();
  if (roleText) {
    params.push(roleText);
    where.push(`COALESCE(u.role,'user') = $${params.length}`);
  }

  const identityText = String(identity || '').trim();
  if (identityText === 'verified') {
    where.push(`COALESCE(u.identity_verified, FALSE) = TRUE`);
  } else if (identityText === 'pending') {
    where.push(`COALESCE(u.identity_verified, FALSE) = FALSE`);
  }

  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

const USERS_LIST_SQL = `
  SELECT
    u.id,
    u.display_id,
    u.full_name,
    u.first_name,
    u.last_name,
    u.email,
    u.phone,
    u.role,
    u.provider,
    u.status,
    u.email_verified,
    COALESCE(u.identity_verified, FALSE) AS identity_verified,
    u.identity_verified_at,
    u.last_login_at,
    u.created_at,
    s.id AS subscription_id,
    s.package_name_snapshot AS active_package_name,
    s.end_at AS package_end_at,
    s.source_channel,
    iv.full_name AS identity_full_name,
    iv.document_type,
    iv.national_id,
    iv.passport_number,
    iv.date_of_birth,
    iv.document_expiry_date,
    iv.document_image_path,
    iv.address_line,
    iv.subdistrict,
    iv.district,
    iv.province,
    iv.postal_code,
    iv.phone AS identity_phone,
    iv.verify_email,
    iv.verified_at AS identity_row_verified_at,
    ba.bank_name,
    ba.account_name AS bank_account_name,
    ba.account_number_masked,
    ba.verify_email AS bank_verify_email,
    ba.status AS bank_status,
    COALESCE(ba.is_verified, FALSE) AS bank_is_verified,
    ba.verified_at AS bank_verified_at,
    ba.created_at AS bank_created_at,
    ba.updated_at AS bank_updated_at
  FROM users u
  LEFT JOIN LATERAL (
    SELECT id, package_name_snapshot, end_at, source_channel
    FROM user_subscriptions us
    WHERE us.user_id = u.id
    ORDER BY COALESCE(us.end_at, us.created_at) DESC NULLS LAST, us.id DESC
    LIMIT 1
  ) s ON TRUE
  LEFT JOIN user_identity_verifications iv ON iv.user_id = u.id
  LEFT JOIN user_bank_accounts ba ON ba.user_id = u.id
`;

router.get('/users', async (req, res) => {
  try {
    const filters = {
      q: String(req.query.q || '').trim(),
      status: String(req.query.status || '').trim(),
      role: String(req.query.role || '').trim(),
      identity: String(req.query.identity || '').trim()
    };
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const listParams = [];
    const whereClause = buildUsersWhere(filters, listParams);
    const offset = (page - 1) * USER_PAGE_SIZE;

    const [result, countRes, counts] = await Promise.all([
      query(
        `${USERS_LIST_SQL}
         ${whereClause}
         ORDER BY u.created_at DESC
         LIMIT ${USER_PAGE_SIZE} OFFSET ${offset}`,
        listParams
      ),
      query(
        `SELECT COUNT(*)::int AS total FROM users u ${whereClause}`,
        listParams
      ),
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status = 'banned')::int AS banned,
          COUNT(*) FILTER (WHERE COALESCE(identity_verified, FALSE) = TRUE)::int AS identity_verified
        FROM users
      `)
    ]);

    const totalRows = Number(countRes.rows[0]?.total || 0);
    const totalPages = Math.max(Math.ceil(totalRows / USER_PAGE_SIZE), 1);

    return res.render('admin/users', baseView(req, {
      pageTitle: 'Users',
      pageCss: 'admin-users.css',
      currentPath: '/admin/users',
      users: result.rows,
      bankAccounts: result.rows,
      filters,
      counts: counts.rows[0] || {
        total: 0,
        active: 0,
        banned: 0,
        identity_verified: 0
      },
      pagination: {
        currentPage: Math.min(page, totalPages),
        totalPages,
        totalRows,
        pageSize: USER_PAGE_SIZE
      }
    }));

  } catch (error) {
    console.error(error);
    req.session.error = 'โหลดข้อมูลผู้ใช้ไม่สำเร็จ';
    return res.redirect('/admin');
  }
});

router.get('/users/export.xlsx', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const role = String(req.query.role || '').trim();
    const identity = String(req.query.identity || '').trim();

    const params = [];
    const where = [];

    if (q) {
      params.push(`%${q}%`);
      const idx = params.length;
      where.push(`(
        CAST(u.id AS TEXT) ILIKE $${idx}
        OR COALESCE(u.display_id,'') ILIKE $${idx}
        OR COALESCE(u.email,'') ILIKE $${idx}
        OR COALESCE(u.phone,'') ILIKE $${idx}
        OR COALESCE(u.full_name,'') ILIKE $${idx}
        OR COALESCE(u.first_name,'') ILIKE $${idx}
        OR COALESCE(u.last_name,'') ILIKE $${idx}
      )`);
    }

    if (status) {
      params.push(status);
      where.push(`COALESCE(u.status,'active') = $${params.length}`);
    }

    if (role) {
      params.push(role);
      where.push(`COALESCE(u.role,'user') = $${params.length}`);
    }

    if (identity === 'verified') {
      where.push(`COALESCE(u.identity_verified, FALSE) = TRUE`);
    } else if (identity === 'pending') {
      where.push(`COALESCE(u.identity_verified, FALSE) = FALSE`);
    }

    const result = await query(
      `
      SELECT
        u.id,
        COALESCE(iv.full_name, u.full_name, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,''))) AS full_name,
        u.email,
        COALESCE(iv.phone, u.phone) AS phone,
        u.role,
        u.provider,
        COALESCE(u.status,'active') AS status,
        CASE WHEN COALESCE(u.email_verified, FALSE) THEN 'Yes' ELSE 'No' END AS email_verified,
        CASE WHEN COALESCE(u.identity_verified, FALSE) THEN 'Yes' ELSE 'No' END AS identity_verified,
        u.identity_verified_at,
        iv.address_line,
        iv.subdistrict,
        iv.district,
        iv.province,
        iv.postal_code,
        iv.verify_email,
        s.package_name_snapshot AS active_package_name,
        s.source_channel,
        s.end_at AS package_end_at,
        u.last_login_at,
        u.created_at
      FROM users u
      LEFT JOIN LATERAL (
        SELECT package_name_snapshot, end_at, source_channel
        FROM user_subscriptions us
        WHERE us.user_id = u.id
        ORDER BY COALESCE(us.end_at, us.created_at) DESC NULLS LAST, us.id DESC
        LIMIT 1
      ) s ON TRUE
      LEFT JOIN user_identity_verifications iv ON iv.user_id = u.id
      LEFT JOIN user_bank_accounts ba ON ba.user_id = u.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.created_at DESC
      `,
      params
    );

    const rows = result.rows.map((u) => ({
      ID: u.display_id || u.id,
      Name: u.full_name || '-',
      Email: u.email || '-',
      Phone: u.phone || '-',
      AddressLine: u.address_line || '-',
      Subdistrict: u.subdistrict || '-',
      District: u.district || '-',
      Province: u.province || '-',
      PostalCode: u.postal_code || '-',
      VerifyEmail: u.verify_email || '-',
      Role: u.role || 'user',
      Provider: u.provider || '-',
      Status: u.status || 'active',
      EmailVerified: u.email_verified,
      IdentityVerified: u.identity_verified,
      Package: u.active_package_name || '-',
      SourceChannel: u.source_channel || '-',
      PackageEndAt: u.package_end_at ? new Date(u.package_end_at).toLocaleString('th-TH') : '-',
      IdentityVerifiedAt: u.identity_verified_at ? new Date(u.identity_verified_at).toLocaleString('th-TH') : '-',
      LastLoginAt: u.last_login_at ? new Date(u.last_login_at).toLocaleString('th-TH') : '-',
      CreatedAt: u.created_at ? new Date(u.created_at).toLocaleString('th-TH') : '-'
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);

    worksheet['!cols'] = [
      { wch: 8 }, { wch: 24 }, { wch: 30 }, { wch: 16 }, { wch: 32 },
      { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 28 },
      { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 16 },
      { wch: 22 }, { wch: 16 }, { wch: 22 }, { wch: 22 }, { wch: 22 }, { wch: 22 }
    ];

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Users');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="admin-users-${new Date().toISOString().slice(0, 10)}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    return res.send(buffer);
  } catch (error) {
    console.error('users export error:', error);
    req.session.error = 'Export Excel ไม่สำเร็จ';
    return res.redirect('/admin/users');
  }
});

router.get('/users/:id/edit', async (req, res) => {
  const [userRes, subscriptionRes] = await Promise.all([
    query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [req.params.id]),
    query(`SELECT * FROM user_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.id])
  ]);

  return res.render('admin/user-edit', baseView(req, {
    pageTitle: 'Edit User',
    currentPath: '/admin/users',
    editUser: userRes.rows[0],
    subscription: subscriptionRes.rows[0] || null
  }));
});

router.post('/users/:id/update', async (req, res) => {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    await ensureScoinMarketAdminColumns(client);

    await client.query(
      `UPDATE users
       SET full_name = $2,
           first_name = $3,
           last_name = $4,
           email = $5,
           phone = $6,
           role = $7,
           provider = $8,
           status = $9,
           updated_at = NOW()
       WHERE id = $1`,
      [
        req.params.id,
        String(req.body.full_name || '').trim(),
        String(req.body.first_name || '').trim(),
        String(req.body.last_name || '').trim(),
        String(req.body.email || '').trim().toLowerCase(),
        String(req.body.phone || '').trim(),
        String(req.body.role || 'user').trim(),
        String(req.body.provider || 'web').trim(),
        String(req.body.status || 'active').trim()
      ]
    );

    if (req.body.subscription_id) {
      await client.query(
        `UPDATE user_subscriptions
         SET source_channel = $2,
             package_name_snapshot = $3,
             end_at = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [
          req.body.subscription_id,
          String(req.body.source_channel || 'web').trim(),
          String(req.body.package_name_snapshot || '').trim(),
          req.body.package_end_at || null
        ]
      );
    }

    await client.query('COMMIT');
    req.session.success = 'บันทึกข้อมูลผู้ใช้เรียบร้อยแล้ว';
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(error);
    req.session.error = 'แก้ไขข้อมูลผู้ใช้ไม่สำเร็จ';
  } finally {
    client.release();
  }

  return res.redirect('/admin/users');
});

router.post('/users/:id/ban', async (req, res) => {
  await query(`UPDATE users SET status = 'banned', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  req.session.success = `แบนผู้ใช้ #${req.params.id} เรียบร้อยแล้ว`;
  return res.redirect('/admin/users');
});

router.post('/users/:id/unban', async (req, res) => {
  await query(`UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1`, [req.params.id]);
  req.session.success = `ปลดแบนผู้ใช้ #${req.params.id} เรียบร้อยแล้ว`;
  return res.redirect('/admin/users');
});

router.post(['/users/:id/delete-package', '/users/:id/remove-package'], async (req, res) => {
  const userId = req.params.id;
  const subscriptionId = String(req.body.subscription_id || '').trim();

  try {
    let result;

    if (subscriptionId) {
      result = await query(
        `DELETE FROM user_subscriptions
         WHERE id = $1 AND user_id = $2
         RETURNING id, package_name_snapshot`,
        [subscriptionId, userId]
      );
    } else {
      result = await query(
        `DELETE FROM user_subscriptions
         WHERE id = (
           SELECT id
           FROM user_subscriptions
           WHERE user_id = $1
           ORDER BY COALESCE(end_at, created_at) DESC NULLS LAST, id DESC
           LIMIT 1
         )
         RETURNING id, package_name_snapshot`,
        [userId]
      );
    }

    if (!result.rows.length) {
      req.session.error = `ไม่พบแพ็กเกจของผู้ใช้ #${userId}`;
    } else {
      req.session.success = `ลบแพ็กเกจของผู้ใช้ #${userId} เรียบร้อยแล้ว`;
    }
  } catch (error) {
    console.error('delete user package error:', error);
    req.session.error = 'ลบแพ็กเกจผู้ใช้ไม่สำเร็จ';
  }

  return res.redirect('/admin/users');
});

router.post('/users/:id/delete', async (req, res) => {
  await query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
  req.session.success = `ลบผู้ใช้ #${req.params.id} เรียบร้อยแล้ว`;
  return res.redirect('/admin/users');
});

router.get('/packages', async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
  const perPage = 10;
  const offset = (page - 1) * perPage;

  const [packagesRes, counts] = await Promise.all([
    query(`
      SELECT
        p.*,
        psr.reward_type,
        psr.reward_scoin,
        COALESCE(psr.is_enabled, TRUE) AS scoin_reward_enabled,
        COALESCE(psr.customer_reward_percent, 40) AS customer_reward_percent,
        COALESCE(psr.first_referral_percent, 60) AS first_referral_percent,
        COALESCE(psr.level1_percent, 8) AS level1_percent,
        COALESCE(psr.level2_percent, 5) AS level2_percent,
        COALESCE(psr.level3_percent, 3) AS level3_percent,
        COALESCE(psr.level4_percent, 2) AS level4_percent,
        COALESCE(psr.level5_percent, 2) AS level5_percent,
        COALESCE(psr.company_profit_percent, 35) AS company_profit_percent,
        COALESCE(psr.network_bonus_percent, 20) AS network_bonus_percent,
        COALESCE(psr.buyback_reserve_percent, 20) AS buyback_reserve_percent,
        COALESCE(psr.burn_liquidity_percent, 10) AS burn_liquidity_percent,
        COALESCE(psr.promotion_percent, 10) AS promotion_percent,
        COALESCE(psr.system_marketing_percent, 5) AS system_marketing_percent,
        COALESCE(psr.reward_scoin, ROUND((COALESCE(p.price,0) * COALESCE(psr.customer_reward_percent,40) / 100)::numeric, 4)) AS customer_reward_scoin,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.first_referral_percent,60) / 100)::numeric, 4) AS first_referral_bonus_scoin,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.network_bonus_percent,20) / 100)::numeric, 4) AS network_bonus_pool_scoin,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.company_profit_percent,35) / 100)::numeric, 2) AS company_profit_thb,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.buyback_reserve_percent,20) / 100)::numeric, 2) AS buyback_reserve_thb,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.burn_liquidity_percent,10) / 100)::numeric, 2) AS burn_liquidity_thb,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.promotion_percent,10) / 100)::numeric, 2) AS promotion_thb,
        ROUND((COALESCE(p.price,0) * COALESCE(psr.system_marketing_percent,5) / 100)::numeric, 2) AS system_marketing_thb
      FROM packages p
      LEFT JOIN package_scoin_rewards psr ON psr.package_id = p.id
      ORDER BY COALESCE(p.sort_order,0) ASC, COALESCE(p.updated_at, p.created_at) DESC NULLS LAST, p.id DESC
      LIMIT $1 OFFSET $2`,
      [perPage, offset]
    ),
    query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_enabled IS TRUE)::int AS enabled FROM packages`)
  ]);

  const total = Number(counts.rows[0]?.total || 0);
  const totalPages = Math.max(Math.ceil(total / perPage), 1);

  return res.render('admin/packages', baseView(req, {
    pageTitle: 'Packages',
    currentPath: '/admin/packages',
    packages: packagesRes.rows,
    counts: counts.rows[0] || { total: 0, enabled: 0 },
    pagination: { page, perPage, total, totalPages }
  }));
});

router.post('/packages/create', async (req, res) => {
  const price = Number(req.body.price || 0);
  const customerPercent = Number(req.body.customer_reward_percent || 40);
  const firstReferralPercent = Number(req.body.first_referral_percent || 60);
  const level1Percent = Number(req.body.level1_percent || 8);
  const level2Percent = Number(req.body.level2_percent || 5);
  const level3Percent = Number(req.body.level3_percent || 3);
  const level4Percent = Number(req.body.level4_percent || 2);
  const level5Percent = Number(req.body.level5_percent || 2);
  const companyProfitPercent = Number(req.body.company_profit_percent || 35);
  const networkBonusPercent = Number(req.body.network_bonus_percent || (level1Percent + level2Percent + level3Percent + level4Percent + level5Percent));
  const buybackReservePercent = Number(req.body.buyback_reserve_percent || 20);
  const burnLiquidityPercent = Number(req.body.burn_liquidity_percent || 10);
  const promotionPercent = Number(req.body.promotion_percent || 10);
  const systemMarketingPercent = Number(req.body.system_marketing_percent || 5);
  const rewardScoin = req.body.reward_scoin !== undefined && String(req.body.reward_scoin).trim() !== ''
    ? Number(req.body.reward_scoin || 0)
    : Number((price * customerPercent / 100).toFixed(4));

  const created = await query(
    `INSERT INTO packages (
      package_code, group_name, name_th, name_en, summary_th, summary_en,
      days, price, lot_min, lot_max, ports_min, ports_max,
      profit_label_th, profit_label_en, support_th, support_en,
      is_enabled, is_popular, sort_order
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING id`,
    [
      String(req.body.package_code || randomUUID().slice(0, 8)).trim() || null,
      String(req.body.group_name || 'BASIC').trim().toUpperCase(),
      String(req.body.name_th || '').trim(),
      String(req.body.name_en || '').trim(),
      String(req.body.summary_th || '').trim(),
      String(req.body.summary_en || '').trim(),
      Number(req.body.days || 0),
      price,
      Number(req.body.lot_min || 0),
      Number(req.body.lot_max || 0),
      Number(req.body.ports_min || 0),
      Number(req.body.ports_max || 0),
      String(req.body.profit_label_th || '').trim(),
      String(req.body.profit_label_en || '').trim(),
      String(req.body.support_th || '').trim(),
      String(req.body.support_en || '').trim(),
      req.body.is_enabled === 'on',
      req.body.is_popular === 'on',
      Number(req.body.sort_order || 0)
    ]
  );

  const packageId = created.rows[0]?.id;
  if (packageId) {
    await query(
      `INSERT INTO package_scoin_rewards (package_id, reward_type, reward_scoin, is_enabled, customer_reward_percent, first_referral_percent, level1_percent, level2_percent, level3_percent, level4_percent, level5_percent, company_profit_percent, network_bonus_percent, buyback_reserve_percent, burn_liquidity_percent, promotion_percent, system_marketing_percent, created_at, updated_at)
       VALUES ($1, 'fixed', $2, TRUE, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW(), NOW())
       ON CONFLICT (package_id)
       DO UPDATE SET reward_type = EXCLUDED.reward_type,
                     reward_scoin = EXCLUDED.reward_scoin,
                     is_enabled = TRUE,
                     customer_reward_percent = EXCLUDED.customer_reward_percent,
                     first_referral_percent = EXCLUDED.first_referral_percent,
                     level1_percent = EXCLUDED.level1_percent,
                     level2_percent = EXCLUDED.level2_percent,
                     level3_percent = EXCLUDED.level3_percent,
                     level4_percent = EXCLUDED.level4_percent,
                     level5_percent = EXCLUDED.level5_percent,
                     company_profit_percent = EXCLUDED.company_profit_percent,
                     network_bonus_percent = EXCLUDED.network_bonus_percent,
                     buyback_reserve_percent = EXCLUDED.buyback_reserve_percent,
                     burn_liquidity_percent = EXCLUDED.burn_liquidity_percent,
                     promotion_percent = EXCLUDED.promotion_percent,
                     system_marketing_percent = EXCLUDED.system_marketing_percent,
                     updated_at = NOW()`,
      [packageId, rewardScoin, customerPercent, firstReferralPercent, level1Percent, level2Percent, level3Percent, level4Percent, level5Percent, companyProfitPercent, networkBonusPercent, buybackReservePercent, burnLiquidityPercent, promotionPercent, systemMarketingPercent]
    );
  }

  req.session.success = 'เพิ่มแพ็กเกจเรียบร้อยแล้ว';
  return res.redirect('/admin/packages');
});

router.post('/packages/:id/update', async (req, res) => {
  const price = Number(req.body.price || 0);
  const customerPercent = Number(req.body.customer_reward_percent || 40);
  const firstReferralPercent = Number(req.body.first_referral_percent || 60);
  const level1Percent = Number(req.body.level1_percent || 8);
  const level2Percent = Number(req.body.level2_percent || 5);
  const level3Percent = Number(req.body.level3_percent || 3);
  const level4Percent = Number(req.body.level4_percent || 2);
  const level5Percent = Number(req.body.level5_percent || 2);
  const companyProfitPercent = Number(req.body.company_profit_percent || 35);
  const networkBonusPercent = Number(req.body.network_bonus_percent || (level1Percent + level2Percent + level3Percent + level4Percent + level5Percent));
  const buybackReservePercent = Number(req.body.buyback_reserve_percent || 20);
  const burnLiquidityPercent = Number(req.body.burn_liquidity_percent || 10);
  const promotionPercent = Number(req.body.promotion_percent || 10);
  const systemMarketingPercent = Number(req.body.system_marketing_percent || 5);
  const rewardScoin = req.body.reward_scoin !== undefined && String(req.body.reward_scoin).trim() !== ''
    ? Number(req.body.reward_scoin || 0)
    : Number((price * customerPercent / 100).toFixed(4));

  await query(
    `UPDATE packages
     SET package_code = $2,
         group_name = $3,
         name_th = $4,
         name_en = $5,
         summary_th = $6,
         summary_en = $7,
         days = $8,
         price = $9,
         lot_min = $10,
         lot_max = $11,
         ports_min = $12,
         ports_max = $13,
         profit_label_th = $14,
         profit_label_en = $15,
         support_th = $16,
         support_en = $17,
         is_enabled = $18,
         is_popular = $19,
         sort_order = $20,
         updated_at = NOW()
     WHERE id = $1`,
    [
      req.params.id,
      String(req.body.package_code || '').trim() || null,
      String(req.body.group_name || 'BASIC').trim().toUpperCase(),
      String(req.body.name_th || '').trim(),
      String(req.body.name_en || '').trim(),
      String(req.body.summary_th || '').trim(),
      String(req.body.summary_en || '').trim(),
      Number(req.body.days || 0),
      price,
      Number(req.body.lot_min || 0),
      Number(req.body.lot_max || 0),
      Number(req.body.ports_min || 0),
      Number(req.body.ports_max || 0),
      String(req.body.profit_label_th || '').trim(),
      String(req.body.profit_label_en || '').trim(),
      String(req.body.support_th || '').trim(),
      String(req.body.support_en || '').trim(),
      req.body.is_enabled === 'on',
      req.body.is_popular === 'on',
      Number(req.body.sort_order || 0)
    ]
  );

  await query(
    `INSERT INTO package_scoin_rewards (package_id, reward_type, reward_scoin, is_enabled, customer_reward_percent, first_referral_percent, level1_percent, level2_percent, level3_percent, level4_percent, level5_percent, company_profit_percent, network_bonus_percent, buyback_reserve_percent, burn_liquidity_percent, promotion_percent, system_marketing_percent, created_at, updated_at)
     VALUES ($1, 'fixed', $2, TRUE, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW(), NOW())
     ON CONFLICT (package_id)
     DO UPDATE SET reward_type = EXCLUDED.reward_type,
                   reward_scoin = EXCLUDED.reward_scoin,
                   is_enabled = TRUE,
                   customer_reward_percent = EXCLUDED.customer_reward_percent,
                   first_referral_percent = EXCLUDED.first_referral_percent,
                   level1_percent = EXCLUDED.level1_percent,
                   level2_percent = EXCLUDED.level2_percent,
                   level3_percent = EXCLUDED.level3_percent,
                   level4_percent = EXCLUDED.level4_percent,
                   level5_percent = EXCLUDED.level5_percent,
                   company_profit_percent = EXCLUDED.company_profit_percent,
                   network_bonus_percent = EXCLUDED.network_bonus_percent,
                   buyback_reserve_percent = EXCLUDED.buyback_reserve_percent,
                   burn_liquidity_percent = EXCLUDED.burn_liquidity_percent,
                   promotion_percent = EXCLUDED.promotion_percent,
                   system_marketing_percent = EXCLUDED.system_marketing_percent,
                   updated_at = NOW()`,
    [req.params.id, rewardScoin, customerPercent, firstReferralPercent, level1Percent, level2Percent, level3Percent, level4Percent, level5Percent, companyProfitPercent, networkBonusPercent, buybackReservePercent, burnLiquidityPercent, promotionPercent, systemMarketingPercent]
  );

  req.session.success = 'อัปเดตแพ็กเกจเรียบร้อยแล้ว';
  return res.redirect('/admin/packages');
});

router.post('/packages/:id/toggle', async (req, res) => {
  try {
    const result = await query(
      `UPDATE packages
       SET is_enabled = NOT COALESCE(is_enabled, TRUE),
           updated_at = NOW()
       WHERE id = $1
       RETURNING is_enabled`,
      [req.params.id]
    );

    if (!result.rows.length) {
      req.session.error = 'ไม่พบแพ็กเกจ';
    } else {
      req.session.success = result.rows[0].is_enabled
        ? 'เปิดแพ็กเกจแล้ว'
        : 'ปิดแพ็กเกจแล้ว';
    }
  } catch (error) {
    console.error('toggle package error:', error);
    req.session.error = 'เปิด/ปิดแพ็กเกจไม่สำเร็จ';
  }

  return res.redirect('/admin/packages');
});

router.post('/packages/:id/delete', async (req, res) => {
  await query(`DELETE FROM packages WHERE id = $1`, [req.params.id]);
  req.session.success = 'ลบแพ็กเกจเรียบร้อยแล้ว';
  return res.redirect('/admin/packages');
});

async function autoCancelExpiredPayments() {
  try {
    await autoCancelPendingPackagePaymentsOnce();

    await query(`
      UPDATE scoin_market_orders
      SET status='rejected',
          cancelled_at=NOW(),
          auto_cancelled_at=NOW(),
          updated_at=NOW()
      WHERE order_type='sell'
        AND status='pending'
        AND created_at < NOW() - INTERVAL '24 hours'
    `);
  } catch (e) {
    console.error(
      `autoCancelExpiredPayments: timeout=${PACKAGE_PAYMENT_PENDING_TIMEOUT_SEC}s`,
      e.message
    );
  }
}

const PAYMENTS_PAGE_SIZE = 10;

function paymentDisplayId(row = {}) {
  const raw = String(row.display_id || '').trim();
  if (raw) return raw.replace(/^#+/, '');
  if (row.id) return `PM${String(row.id).padStart(6, '0')}`;
  return '-';
}

function paymentChannelLabel(method = '') {
  const value = String(method || '').trim().toLowerCase();
  if (['stripe_promptpay', 'promptpay_qr', 'kbank', 'promptpay'].includes(value)) return 'PromptPay';
  if (['stripe_card', 'credit_card', 'card'].includes(value)) return 'บัตรเครดิต';
  if (value === 'scoin' || value === 'scoin_package') return 'Scoin';
  if (value === 'free_coupon') return 'คูปองฟรี';
  return method || '-';
}

function paymentStatusLabel(status = '') {
  const s = String(status || '').trim().toLowerCase();
  if (!s || s === '-') return '-';
  if (s === 'paid') return 'ชำระแล้ว';
  if (s === 'pending') return 'รอตรวจสอบ';
  if (['waiting', 'wait_payment', 'unpaid'].includes(s)) return 'รอชำระ';
  if (s === 'cancelled' || s === 'canceled') return 'ยกเลิก';
  if (s === 'failed') return 'ไม่สำเร็จ';
  if (s === 'refunded') return 'คืนเงิน';
  if (s === 'approved') return 'อนุมัติแล้ว';
  if (s === 'rejected') return 'ปฏิเสธ';
  if (s === 'completed' || s === 'success') return 'สำเร็จ';
  return status || '-';
}

function formatPaymentUserAddress(row = {}) {
  const parts = [
    row.address_line,
    row.subdistrict,
    row.district,
    row.province,
    row.postal_code
  ].map((part) => String(part || '').trim()).filter(Boolean);
  return parts.join(' ') || '-';
}

function formatPaymentDateLabel(row = {}) {
  const value = row.paid_at || row.created_at;
  if (!value) return '-';
  try {
    return new Date(value).toLocaleDateString('th-TH', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });
  } catch (e) {
    return '-';
  }
}

const CASH_PAYMENT_SELECT_SQL = `
  SELECT
    p.*,
    u.full_name,
    u.email,
    u.phone,
    u.display_id AS user_display_id,
    pk.name_th AS package_name_th,
    pk.name_en AS package_name_en,
    iv.full_name AS identity_full_name,
    iv.address_line,
    iv.subdistrict,
    iv.district,
    iv.province,
    iv.postal_code,
    iv.phone AS identity_phone,
    iv.verify_email,
    COALESCE(st.scoin_paid_amount, NULLIF(p.raw_payload->'scoin_payment'->>'scoin_amount', '')::numeric) AS scoin_paid_amount
  FROM payments p
  LEFT JOIN users u ON u.id = p.user_id
  LEFT JOIN packages pk ON pk.id = p.package_id
  LEFT JOIN user_identity_verifications iv ON iv.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT ABS(stx.amount)::numeric AS scoin_paid_amount
    FROM scoin_transactions stx
    WHERE stx.ref_payment_id = p.id
      AND stx.tx_type = 'package_purchase_scoin'
    ORDER BY stx.created_at DESC, stx.id DESC
    LIMIT 1
  ) st ON TRUE
`;

async function buildCashPaymentAdminView(row = {}, options = {}) {
  let receiptUrl = options.receiptUrl ?? null;
  if (options.includeReceipt && receiptUrl === null) {
    receiptUrl = await getStripeReceiptUrlForPayment(row).catch(() => null);
  }

  const fullName = String(row.identity_full_name || row.full_name || row.payer_name || '').trim() || '-';
  const email = String(row.payer_email || row.email || row.verify_email || '').trim() || '-';
  const phone = String(row.identity_phone || row.phone || '').trim() || '-';
  const amount = Number(row.final_amount ?? row.amount ?? 0);
  const payload = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};

  return {
    id: row.id,
    display_id: paymentDisplayId(row),
    date: formatPaymentDateLabel(row),
    full_name: fullName,
    address: formatPaymentUserAddress(row),
    phone,
    email,
    type: 'แพ็กเกจ',
    item: String(row.package_name_snapshot || row.package_name_th || row.package_name_en || '').trim() || '-',
    amount,
    amount_label: `฿${amount.toLocaleString('th-TH')}`,
    channel: paymentChannelLabel(row.payment_method),
    status: paymentStatusLabel(row.payment_status),
    payment_ref: String(row.payment_ref || '').trim() || '-',
    receipt_url: receiptUrl || null,
    receipt_snapshot_url: String(payload.stripe_receipt_snapshot || '').trim() || null
  };
}

async function fetchPaymentRowsBySection(section, filters, options = {}) {
  const params = [];
  const where = buildAdminPaymentWhere(section, filters, params);
  const ids = Array.isArray(options.ids) ? options.ids.filter(Boolean) : [];
  let extraWhere = '';
  if (ids.length) {
    params.push(ids);
    extraWhere = ` AND p.id = ANY($${params.length}::bigint[])`;
  }
  const limit = Math.min(Math.max(Number(options.limit || 5000), 1), 5000);
  const result = await query(
    `${CASH_PAYMENT_SELECT_SQL}
     ${where}${extraWhere}
     ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC
     LIMIT ${limit}`,
    params
  );
  return result.rows;
}

async function fetchCashPaymentRows(filters, options = {}) {
  return fetchPaymentRowsBySection('cash', filters, options);
}

async function fetchScoinPaymentRows(filters, options = {}) {
  return fetchPaymentRowsBySection('scoin', filters, options);
}

const SCOIN_SELL_SELECT_SQL = `
  SELECT
    o.*,
    u.email,
    u.phone,
    COALESCE(NULLIF(u.full_name, ''), u.email) AS full_name,
    ba.bank_name,
    ba.account_name,
    ba.account_number_masked
  FROM scoin_market_orders o
  LEFT JOIN users u ON u.id = o.user_id
  LEFT JOIN user_bank_accounts ba ON ba.id = o.bank_account_id
`;

function buildScoinSellWhere(filters, params, options = {}) {
  const clauses = [`o.order_type = 'sell'`];
  const search = String(filters.sell_q || '').trim();
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    clauses.push(`(
      COALESCE(u.full_name, '') ILIKE $${idx}
      OR COALESCE(u.email, '') ILIKE $${idx}
      OR COALESCE(o.display_id, '') ILIKE $${idx}
      OR CAST(o.id AS TEXT) ILIKE $${idx}
      OR COALESCE(ba.bank_name, '') ILIKE $${idx}
      OR COALESCE(ba.account_name, '') ILIKE $${idx}
      OR COALESCE(ba.account_number_masked, '') ILIKE $${idx}
      OR COALESCE(o.status, '') ILIKE $${idx}
    )`);
  }
  if (options.paidOutOnly) {
    params.push('paid');
    clauses.push(`LOWER(COALESCE(o.payout_status, '')) = $${params.length}`);
  }
  return `WHERE ${clauses.join(' AND ')}`;
}

async function fetchScoinSellRows(filters, options = {}) {
  const params = [];
  const where = buildScoinSellWhere(filters, params, {
    paidOutOnly: !!options.paidOutOnly
  });
  const ids = Array.isArray(options.ids) ? options.ids.filter(Boolean) : [];
  let extraWhere = '';
  if (ids.length) {
    params.push(ids);
    extraWhere = ` AND o.id = ANY($${params.length}::bigint[])`;
  }
  const limit = Math.min(Math.max(Number(options.limit || 5000), 1), 5000);
  const result = await query(
    `${SCOIN_SELL_SELECT_SQL}
     ${where}${extraWhere}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${limit}`,
    params
  );
  return result.rows;
}

async function fetchScoinSellSection(filters, page) {
  const params = [];
  const where = buildScoinSellWhere(filters, params);
  const limit = PAYMENTS_PAGE_SIZE;
  const offset = (page - 1) * limit;
  const [rowsRes, countRes] = await Promise.all([
    query(
      `${SCOIN_SELL_SELECT_SQL}
       ${where}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    query(
      `SELECT COUNT(*)::int AS total
       FROM scoin_market_orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN user_bank_accounts ba ON ba.id = o.bank_account_id
       ${where}`,
      params
    )
  ]);
  const totalRows = Number(countRes.rows[0]?.total || 0);
  return {
    rows: rowsRes.rows,
    totalRows,
    totalPages: Math.max(Math.ceil(totalRows / limit), 1)
  };
}

function buildScoinSellAdminView(row = {}) {
  const displayId = String(row.display_id || (`SCSELL${String(row.id || '').padStart(6, '0')}`)).replace(/^#+/, '');
  const account = [row.account_name, row.account_number_masked].filter(Boolean).join(' ');
  return {
    id: row.id,
    display_id: displayId,
    date: formatPaymentDateLabel(row),
    full_name: String(row.full_name || '-').trim() || '-',
    email: String(row.email || '-').trim() || '-',
    scoin_amount: Number(row.scoin_amount || 0),
    scoin_label: Number(row.scoin_amount || 0).toLocaleString('th-TH'),
    net_amount: Number(row.net_amount_thb || 0),
    net_label: `฿${Number(row.net_amount_thb || 0).toLocaleString('th-TH')}`,
    gross_label: `฿${Number(row.gross_amount_thb || 0).toLocaleString('th-TH')}`,
    fee_label: `฿${Number(row.fee_amount_thb || 0).toLocaleString('th-TH')}`,
    bank: String(row.bank_name || '-').trim() || '-',
    account: account || '-',
    status: paymentStatusLabel(row.status),
    payout_status: paymentStatusLabel(row.payout_status === 'paid' ? 'paid' : row.payout_status) === 'ชำระแล้ว'
      ? 'โอนแล้ว'
      : (String(row.payout_status || '').toLowerCase() === 'pending' ? 'รอโอน' : paymentStatusLabel(row.payout_status)),
    slip_url: row.host_transfer_slip_url || null,
    payout_ref: row.payout_ref || '-'
  };
}

async function buildScoinPaymentAdminView(row = {}, options = {}) {
  const view = await buildCashPaymentAdminView(row, options);
  view.channel = 'Scoin';
  view.scoin_amount = Number(row.scoin_paid_amount || 0);
  view.scoin_label = Number(row.scoin_paid_amount || 0).toLocaleString('th-TH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  });
  return view;
}

function isScoinPackagePaymentRow(row = {}) {
  const method = String(row.payment_method || '').trim().toLowerCase();
  const ref = String(row.payment_ref || '').trim().toUpperCase();
  return method === 'scoin'
    || method === 'scoin_package'
    || ref.startsWith('SCOIN-PKG-')
    || !!(row.raw_payload && row.raw_payload.scoin_payment);
}

function buildAdminPaymentFilters(req) {
  return {
    q: String(req.query.q || '').trim(),
    scoin_q: String(req.query.scoin_q || '').trim(),
    sell_q: String(req.query.sell_q || '').trim(),
    status: String(req.query.status || 'all').trim().toLowerCase(),
    method: String(req.query.method || 'all').trim().toLowerCase(),
    month: Number(req.query.month || 0) || null,
    year: Number(req.query.year || 0) || null
  };
}

function buildAdminPaymentWhere(section, filters, params) {
  const clauses = ['p.package_id IS NOT NULL'];

  if (section === 'cash') {
    clauses.push(`LOWER(COALESCE(p.payment_method, '')) NOT IN ('scoin', 'scoin_package', 'free_coupon')`);
    clauses.push(`UPPER(COALESCE(p.payment_ref, '')) NOT LIKE 'SCOIN-PKG-%'`);
  } else {
    clauses.push(`(
      LOWER(COALESCE(p.payment_method, '')) IN ('scoin', 'scoin_package')
      OR UPPER(COALESCE(p.payment_ref, '')) LIKE 'SCOIN-PKG-%'
      OR COALESCE(p.raw_payload->'scoin_payment', 'null'::jsonb) <> 'null'::jsonb
    )`);
  }

  const searchText = section === 'scoin'
    ? String(filters.scoin_q || '').trim()
    : String(filters.q || '').trim();

  if (searchText) {
    params.push(`%${searchText}%`);
    const idx = params.length;
    clauses.push(`(
      COALESCE(p.payer_name, '') ILIKE $${idx}
      OR COALESCE(u.full_name, '') ILIKE $${idx}
      OR COALESCE(p.package_name_snapshot, '') ILIKE $${idx}
      OR CAST(p.final_amount AS TEXT) ILIKE $${idx}
      OR COALESCE(p.payment_status, '') ILIKE $${idx}
      OR COALESCE(p.payment_method, '') ILIKE $${idx}
      OR COALESCE(p.payer_email, '') ILIKE $${idx}
      OR COALESCE(u.email, '') ILIKE $${idx}
      OR COALESCE(p.display_id, '') ILIKE $${idx}
      OR COALESCE(p.payment_ref, '') ILIKE $${idx}
      OR CAST(p.id AS TEXT) ILIKE $${idx}
    )`);
  }

  if (filters.status && filters.status !== 'all') {
    params.push(filters.status);
    clauses.push(`LOWER(COALESCE(p.payment_status, '')) = $${params.length}`);
  }

  if (section === 'cash') {
    if (filters.method && filters.method !== 'all') {
      if (filters.method === 'promptpay_qr') {
        clauses.push(`LOWER(COALESCE(p.payment_method, '')) IN ('stripe_promptpay', 'promptpay_qr', 'kbank', 'promptpay')`);
      } else if (filters.method === 'card') {
        clauses.push(`LOWER(COALESCE(p.payment_method, '')) IN ('stripe_card', 'credit_card', 'card')`);
      } else {
        params.push(filters.method);
        clauses.push(`LOWER(COALESCE(p.payment_method, '')) = $${params.length}`);
      }
    }

    if (filters.month) {
      params.push(filters.month);
      clauses.push(`EXTRACT(MONTH FROM COALESCE(p.paid_at, p.created_at)) = $${params.length}`);
    }

    if (filters.year) {
      params.push(filters.year);
      clauses.push(`EXTRACT(YEAR FROM COALESCE(p.paid_at, p.created_at)) = $${params.length}`);
    }
  }

  return `WHERE ${clauses.join(' AND ')}`;
}

async function fetchAdminPaymentSection(section, filters, page) {
  const params = [];
  const where = buildAdminPaymentWhere(section, filters, params);
  const limit = PAYMENTS_PAGE_SIZE;
  const offset = (page - 1) * limit;

  const [rowsRes, countRes] = await Promise.all([
    query(
      `${CASH_PAYMENT_SELECT_SQL}
       ${where}
       ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    query(
      `SELECT COUNT(*)::int AS total
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       ${where}`,
      params
    )
  ]);

  const totalRows = Number(countRes.rows[0]?.total || 0);
  return {
    rows: rowsRes.rows,
    totalRows,
    totalPages: Math.max(Math.ceil(totalRows / limit), 1)
  };
}

router.get('/payments', async (req, res) => {
  try {
    await autoCancelExpiredPayments();

    const filters = buildAdminPaymentFilters(req);
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const scoinPage = Math.max(parseInt(req.query.scoin_page || '1', 10) || 1, 1);
    const sellPage = Math.max(parseInt(req.query.sell_page || '1', 10) || 1, 1);
    const deleteLogPage = Math.max(parseInt(req.query.delete_log_page || '1', 10) || 1, 1);
    const deleteLogLimit = 10;
    const deleteLogOffset = (deleteLogPage - 1) * deleteLogLimit;

    const [
      cashSection,
      scoinSection,
      countsRes,
      sellSection,
      deleteLogsRes,
      deleteLogCountRes
    ] = await Promise.all([
      fetchAdminPaymentSection('cash', filters, page),
      fetchAdminPaymentSection('scoin', filters, scoinPage),
      query(`
        SELECT
          COUNT(*) FILTER (
            WHERE package_id IS NOT NULL
              AND LOWER(COALESCE(payment_method, '')) NOT IN ('scoin', 'scoin_package', 'free_coupon')
              AND UPPER(COALESCE(payment_ref, '')) NOT LIKE 'SCOIN-PKG-%'
          )::int AS cash_total,
          COUNT(*) FILTER (
            WHERE package_id IS NOT NULL
              AND LOWER(COALESCE(payment_method, '')) NOT IN ('scoin', 'scoin_package', 'free_coupon')
              AND UPPER(COALESCE(payment_ref, '')) NOT LIKE 'SCOIN-PKG-%'
              AND payment_status = 'paid'
          )::int AS cash_paid,
          COALESCE(SUM(final_amount) FILTER (
            WHERE package_id IS NOT NULL
              AND LOWER(COALESCE(payment_method, '')) NOT IN ('scoin', 'scoin_package', 'free_coupon')
              AND UPPER(COALESCE(payment_ref, '')) NOT LIKE 'SCOIN-PKG-%'
              AND payment_status = 'paid'
          ), 0)::numeric AS cash_revenue,
          COUNT(*) FILTER (
            WHERE package_id IS NOT NULL
              AND (
                LOWER(COALESCE(payment_method, '')) IN ('scoin', 'scoin_package')
                OR UPPER(COALESCE(payment_ref, '')) LIKE 'SCOIN-PKG-%'
              )
          )::int AS scoin_total
        FROM payments
      `),
      fetchScoinSellSection(filters, sellPage),
      query(`
        SELECT
          l.*,
          COALESCE(l.payload_json->>'display_id', '') AS payment_display_id
        FROM payment_delete_logs l
        ORDER BY l.deleted_at DESC, l.id DESC
        LIMIT ${deleteLogLimit} OFFSET ${deleteLogOffset}
      `).catch(() => ({ rows: [] })),
      query(`
        SELECT COUNT(*)::int AS total
        FROM payment_delete_logs
      `).catch(() => ({ rows: [{ total: 0 }] }))
    ]);

    const counts = countsRes.rows[0] || {};
    const deleteLogTotalRows = Number(deleteLogCountRes.rows[0]?.total || 0);
    const deleteLogTotalPages = Math.max(Math.ceil(deleteLogTotalRows / deleteLogLimit), 1);

    return res.render('admin/payments', baseView(req, {
      pageTitle: 'Payments',
      currentPath: '/admin/payments',
      pageCss: 'admin-payments.css',
      payments: cashSection.rows,
      scoinPackagePayments: scoinSection.rows,
      filters,
      counts: {
        total: Number(counts.cash_total || 0),
        paid: Number(counts.cash_paid || 0),
        revenue: Number(counts.cash_revenue || 0),
        scoinTotal: Number(counts.scoin_total || 0)
      },
      scoinSellOrders: sellSection.rows,
      deleteLogs: deleteLogsRes?.rows || [],
      page,
      scoinPage,
      sellPage,
      deleteLogPage,
      deleteLogTotalPages,
      deleteLogTotalRows,
      totalPages: cashSection.totalPages,
      totalRows: cashSection.totalRows,
      scoinTotalPages: scoinSection.totalPages,
      scoinTotalRows: scoinSection.totalRows,
      sellTotalPages: sellSection.totalPages,
      sellTotalRows: sellSection.totalRows,
      paymentDisplayId,
      paymentChannelLabel,
      isScoinPackagePaymentRow
    }));
  } catch (error) {
    console.error('payments page error:', error);
    req.session.error = error.message || 'โหลดรายการชำระเงินไม่สำเร็จ';
    return res.redirect('/admin');
  }
});

router.get('/payments/:id/detail.json', async (req, res) => {
  try {
    const paymentRes = await query(
      `${CASH_PAYMENT_SELECT_SQL}
       WHERE p.id = $1
       LIMIT 1`,
      [req.params.id]
    );
    const payment = paymentRes.rows[0];
    if (!payment) {
      return res.status(404).json({ ok: false, error: 'ไม่พบรายการชำระเงิน' });
    }

    const view = await buildCashPaymentAdminView(payment, { includeReceipt: true });
    const snapshotUrl = await ensurePaymentReceiptSnapshotById(payment.id).catch(() => null);
    if (snapshotUrl) {
      view.receipt_snapshot_url = snapshotUrl;
    }

    return res.json({ ok: true, payment: view });
  } catch (error) {
    console.error('payment detail json error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'โหลดรายละเอียดไม่สำเร็จ' });
  }
});

router.get('/payments/:id/receipt.json', async (req, res) => {
  try {
    const paymentRes = await query(
      `${CASH_PAYMENT_SELECT_SQL}
       WHERE p.id = $1
       LIMIT 1`,
      [req.params.id]
    );
    const payment = paymentRes.rows[0];
    if (!payment) {
      return res.status(404).json({ ok: false, error: 'ไม่พบรายการชำระเงิน' });
    }

    const view = await buildCashPaymentAdminView(payment, { includeReceipt: true });
    const snapshotUrl = await ensurePaymentReceiptSnapshotById(payment.id).catch(() => null);
    if (snapshotUrl) {
      view.receipt_snapshot_url = snapshotUrl;
    }

    return res.json({
      ok: true,
      receipt_url: view.receipt_url,
      receipt_page_url: `/admin/payments/${payment.id}/receipt`,
      receipt_snapshot_url: view.receipt_snapshot_url || snapshotUrl || null,
      payment: view
    });
  } catch (error) {
    console.error('payment receipt json error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'โหลดสลิปไม่สำเร็จ' });
  }
});

router.get('/payments/sell/receipts/bulk', async (req, res) => {
  try {
    const filters = buildAdminPaymentFilters(req);
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value))
      .filter(Boolean);
    const rows = await fetchScoinSellRows(filters, {
      ids: ids.length ? ids : null,
      limit: ids.length ? ids.length : 5000,
      paidOutOnly: !ids.length
    });

    const receipts = rows.map((row) => buildScoinSellReceiptView(row));
    if (!receipts.length) {
      return res.status(404).send('ไม่พบใบเสร็จที่พิมพ์ได้');
    }

    const embed = String(req.query.embed || '').trim() === '1';
    return res.render('admin/scoin-sell-receipt-bulk', { receipts, embed });
  } catch (error) {
    console.error('scoin sell bulk receipt error:', error);
    return res.status(500).send('โหลดใบเสร็จไม่สำเร็จ');
  }
});

router.get('/payments/sell/:id/receipt', async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(404).send('ไม่พบรายการ');
    }
    const rows = await fetchScoinSellRows({}, { ids: [id], limit: 1 });
    const row = rows[0];
    if (!row) {
      return res.status(404).send('ไม่พบรายการขาย Scoin');
    }
    const receipt = buildScoinSellReceiptView(row);
    const embed = String(req.query.embed || '').trim() === '1';
    const autoPrint = String(req.query.print || '').trim() === '1';
    return res.render('admin/scoin-sell-receipt', { receipt, embed, autoPrint });
  } catch (error) {
    console.error('scoin sell receipt page error:', error);
    return res.status(500).send('โหลดใบเสร็จไม่สำเร็จ');
  }
});

router.get('/payments/receipts/bulk', async (req, res) => {
  try {
    const section = String(req.query.section || 'cash').trim().toLowerCase();
    const filters = buildAdminPaymentFilters(req);
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value))
      .filter(Boolean);

    if (!ids.length && section === 'cash') {
      filters.status = 'paid';
    }

    if (!ids.length && section === 'scoin') {
      filters.status = 'paid';
    }

    const fetchRows = section === 'scoin' ? fetchScoinPaymentRows : fetchCashPaymentRows;
    const rows = await fetchRows(filters, {
      ids: ids.length ? ids : null,
      limit: ids.length ? ids.length : 5000
    });

    const receipts = [];
    for (const row of rows) {
      if (String(row.payment_status || '').toLowerCase() !== 'paid') continue;
      receipts.push(await buildPaymentReceiptView(row));
    }

    if (!receipts.length) {
      return res.status(404).send('ไม่พบใบเสร็จที่พิมพ์ได้');
    }

    const embed = String(req.query.embed || '').trim() === '1';
    const autoPrint = String(req.query.print || '').trim() === '1';
    return res.render('admin/payment-receipt-bulk', { receipts, embed, autoPrint });
  } catch (error) {
    console.error('payment bulk receipt error:', error);
    return res.status(500).send('โหลดใบเสร็จไม่สำเร็จ');
  }
});

router.get('/payments/:id/receipt', async (req, res) => {
  try {
    const receipt = await buildPaymentReceiptViewById(req.params.id);
    if (!receipt) {
      return res.status(404).send('ไม่พบใบเสร็จหรือรายการยังไม่ชำระเงิน');
    }
    const embed = String(req.query.embed || '').trim() === '1';
    const autoPrint = String(req.query.print || '').trim() === '1';
    return res.render('admin/payment-receipt', { receipt, embed, autoPrint });
  } catch (error) {
    console.error('payment receipt page error:', error);
    return res.status(500).send('โหลดใบเสร็จไม่สำเร็จ');
  }
});

router.get('/payments/cash/bulk.json', async (req, res) => {
  try {
    const filters = buildAdminPaymentFilters(req);
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value))
      .filter(Boolean);
    const rows = await fetchCashPaymentRows(filters, {
      ids: ids.length ? ids : null,
      limit: ids.length ? ids.length : 5000
    });
    const items = await Promise.all(
      rows.map((row) => buildCashPaymentAdminView(row, { includeReceipt: true }))
    );
    return res.json({ ok: true, items, total: items.length });
  } catch (error) {
    console.error('cash bulk json error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'โหลดรายการไม่สำเร็จ' });
  }
});

router.get('/payments/scoin/bulk.json', async (req, res) => {
  try {
    const filters = buildAdminPaymentFilters(req);
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value))
      .filter(Boolean);
    const rows = await fetchScoinPaymentRows(filters, {
      ids: ids.length ? ids : null,
      limit: ids.length ? ids.length : 5000
    });
    const items = await Promise.all(
      rows.map((row) => buildScoinPaymentAdminView(row, { includeReceipt: false }))
    );
    return res.json({ ok: true, items, total: items.length });
  } catch (error) {
    console.error('scoin bulk json error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'โหลดรายการไม่สำเร็จ' });
  }
});

router.get('/payments/sell/bulk.json', async (req, res) => {
  try {
    const filters = buildAdminPaymentFilters(req);
    const ids = String(req.query.ids || '')
      .split(',')
      .map((value) => Number(value))
      .filter(Boolean);
    const rows = await fetchScoinSellRows(filters, {
      ids: ids.length ? ids : null,
      limit: ids.length ? ids.length : 5000
    });
    const items = rows.map((row) => buildScoinSellAdminView(row));
    return res.json({ ok: true, items, total: items.length });
  } catch (error) {
    console.error('sell bulk json error:', error);
    return res.status(500).json({ ok: false, error: error.message || 'โหลดรายการไม่สำเร็จ' });
  }
});

router.post('/payments/:id/delete', async (req, res) => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const paymentRes = await client.query(
      `SELECT * FROM payments WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (!paymentRes.rows.length) {
      await client.query('ROLLBACK');
      req.session.error = 'ไม่พบรายการชำระเงินที่ต้องการลบ';
      return res.redirect('/admin/payments');
    }

    const payment = paymentRes.rows[0];
    const currentUser = req.user || req.session.user || {};

    await client.query(
      `INSERT INTO payment_delete_logs (
        payment_id,
        deleted_by_user_id,
        deleted_by_name,
        deleted_by_email,
        reason,
        payload_json
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        payment.id,
        currentUser.id || null,
        String(currentUser.full_name || currentUser.name || 'Admin'),
        String(currentUser.email || ''),
        String(req.body.delete_reason || 'ลบจากหน้า admin/payments'),
        JSON.stringify(payment)
      ]
    );

    await client.query(`DELETE FROM payments WHERE id = $1`, [req.params.id]);

    await client.query('COMMIT');
    req.session.success = 'ลบรายการชำระเงินและบันทึกประวัติการลบเรียบร้อยแล้ว';
    return res.redirect('/admin/payments');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('payments delete error:', error);
    req.session.error = error.message || 'ลบรายการชำระเงินไม่สำเร็จ';
    return res.redirect('/admin/payments');
  } finally {
    client.release();
  }
});

router.post('/payments/:id/approve', async (req, res) => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const paymentRes = await client.query(
      `SELECT *
       FROM payments
       WHERE id = $1
       LIMIT 1`,
      [req.params.id]
    );

    if (!paymentRes.rows.length) {
      await client.query('ROLLBACK');
      req.session.error = 'ไม่พบรายการชำระเงิน';
      return res.redirect('/admin/payments');
    }

    const paymentRow = paymentRes.rows[0];

    if (String(paymentRow.payment_status || '') === 'paid') {
      await client.query('ROLLBACK');
      req.session.error = 'รายการนี้ชำระเงินแล้ว';
      return res.redirect('/admin/payments');
    }

    await client.query(
      `UPDATE payments
       SET payment_status = 'paid',
           paid_at = COALESCE(paid_at, NOW()),
           auto_confirmed_at = COALESCE(auto_confirmed_at, NOW()),
           auto_confirm_note = COALESCE(NULLIF(auto_confirm_note, ''), 'Admin manual approve'),
           updated_at = NOW()
       WHERE id = $1`,
      [paymentRow.id]
    );

    if (paymentRow.package_id) {
      const pkgRes = await client.query(
        `SELECT * FROM packages WHERE id = $1 LIMIT 1`,
        [paymentRow.package_id]
      );

      if (pkgRes.rows.length) {
        await applyPaidPackageSubscription({
          client,
          userId: paymentRow.user_id,
          packageRow: pkgRes.rows[0],
          sourceChannel: `payment:${paymentRow.id}`
        });
      }
    }

    await client.query('COMMIT');

    await distributeScoinEconomy({
      userId: paymentRow.user_id,
      paymentId: paymentRow.id,
      packageId: paymentRow.package_id,
      amountThb: Number(paymentRow.final_amount || paymentRow.amount || 0),
      paymentMethod: paymentRow.payment_method,
      paymentRef: paymentRow.payment_ref,
      rawPayload: paymentRow.raw_payload
    });

    req.session.success = 'อนุมัติการชำระเงินสำเร็จแล้ว';
    return res.redirect(req.body.return_to || '/admin/payments');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('approve payment error:', error);
    req.session.error = error.message || 'อนุมัติการชำระเงินไม่สำเร็จ';
    return res.redirect(req.body.return_to || '/admin/payments');
  } finally {
    client.release();
  }
});

router.post('/payments/:id/cancel', async (req, res) => {
  try {
    await query(
      `UPDATE payments
       SET payment_status = 'cancelled',
           updated_at = NOW()
       WHERE id = $1`,
      [req.params.id]
    );
    req.session.success = 'ยกเลิกรายการชำระเงินแล้ว';
    return res.redirect(req.body.return_to || '/admin/payments');
  } catch (error) {
    console.error('cancel payment error:', error);
    req.session.error = error.message || 'ยกเลิกรายการไม่สำเร็จ';
    return res.redirect(req.body.return_to || '/admin/payments');
  }
});

router.get('/news-settings', async (req, res) => {
  const result = await query(`SELECT * FROM news_settings WHERE id = 1 LIMIT 1`);
  return res.render('admin/news-settings', baseView(req, {
    pageTitle: 'News Settings',
    currentPath: '/admin/news-settings',
    settings: result.rows[0] || {}
  }));
});

router.post('/news-settings', async (req, res) => {
  try {
    await query(
      `UPDATE news_settings
       SET
         news_api_key = $1,
         openai_api_key = $2,
         openai_model = $3,
         news_per_day = $4,
         news_per_page = $5,
         category_economy = $6,
         category_finance = $7,
         category_investment = $8,
         category_currency = $9,
         auto_update_enabled = $10,
         ai_analysis_enabled = $11,
         auto_translate_enabled = $12,
         updated_at = NOW()
       WHERE id = 1`,
      [
        String(req.body.news_api_key || '').trim(),
        String(req.body.openai_api_key || '').trim(),
        String(req.body.openai_model || 'gpt-5.4-mini').trim(),
        Number(req.body.news_per_day || 10),
        Number(req.body.news_per_page || 12),
        req.body.category_economy === 'on',
        req.body.category_finance === 'on',
        req.body.category_investment === 'on',
        req.body.category_currency === 'on',
        req.body.auto_update_enabled === 'on',
        req.body.ai_analysis_enabled === 'on',
        req.body.auto_translate_enabled === 'on'
      ]
    );

    req.session.success = 'บันทึก News Settings แล้ว';
    return res.redirect('/admin/news-settings');
  } catch (error) {
    console.error('save news settings error:', error);
    req.session.error = 'บันทึก News Settings ไม่สำเร็จ';
    return res.redirect('/admin/news-settings');
  }
});

router.post('/news-sync', async (req, res) => {
  try {
    await syncNewsNow();
    return res.redirect('/news?lang=' + (req.session?.lang || 'th'));
  } catch (error) {
    console.error('news sync error:', error);
    return res.redirect('/admin?error=news-sync');
  }
});

router.get('/mt5-port-scoin', async (req, res) => {
  try {
    const settings = await getMt5PortScoinPrices();
    const statsRes = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(port_type, ''))) = 'temporary')::int AS temporary,
        COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(port_type, ''))) = 'permanent')::int AS permanent,
        COALESCE(SUM(price_scoin), 0) AS total_scoin
      FROM vps_system.mt5_extra_ports
      WHERE COALESCE(is_active, TRUE) = TRUE
    `).catch(() => ({ rows: [{}] }));

    return res.render('admin/mt5-port-scoin', baseView(req, {
      pageTitle: 'ตั้งค่าราคา Port Scoin',
      currentPath: '/admin/mt5-port-scoin',
      settings,
      stats: statsRes.rows[0] || {},
      fmtDate: formatThaiDateTime
    }));
  } catch (error) {
    console.error('mt5 port scoin settings page error:', error);
    req.session.error = 'โหลดหน้าตั้งค่าราคา Port Scoin ไม่สำเร็จ';
    return res.redirect('/admin');
  }
});

router.post('/mt5-port-scoin', async (req, res) => {
  try {
    const temporary = Number(req.body.temporary_scoin);
    const permanent = Number(req.body.permanent_scoin);
    if (!Number.isFinite(temporary) || temporary < 0 || !Number.isFinite(permanent) || permanent < 0) {
      req.session.error = 'กรุณากรอกราคา Scoin เป็นตัวเลข 0 ขึ้นไป';
      return res.redirect('/admin/mt5-port-scoin');
    }
    await updateMt5PortScoinPrices({ temporary, permanent });
    req.session.success = 'บันทึกราคาซื้อ Port Scoin แล้ว';
    return res.redirect('/admin/mt5-port-scoin');
  } catch (error) {
    console.error('save mt5 port scoin settings error:', error);
    req.session.error = 'บันทึกราคา Port Scoin ไม่สำเร็จ';
    return res.redirect('/admin/mt5-port-scoin');
  }
});

router.get('/ai-settings', async (req, res) => {
  const result = await query(`SELECT * FROM ai_settings WHERE id = 1 LIMIT 1`);
  return res.render('admin/ai-settings', baseView(req, {
    pageTitle: 'AI Chat Settings',
    currentPath: '/admin/ai-settings',
    settings: result.rows[0] || {}
  }));
});

router.post('/ai-settings', async (req, res) => {
  try {
    await query(
      `UPDATE ai_settings
       SET
         openai_api_key = $1,
         model_name = $2,
         bot_name = $3,
         persona_th = $4,
         forbidden_topics_th = $5,
         conversation_instructions_th = $6,
         admin_persona_th = $7,
         app_persona_th = $8,
         is_enabled = $9,
         save_chat_history = $10,
         hide_system_structure = $11,
         updated_at = NOW()
       WHERE id = (SELECT id FROM ai_settings ORDER BY id ASC LIMIT 1)`,
      [
        String(req.body.openai_api_key || ''),
        String(req.body.model_name || 'gpt-5.4-mini'),
        String(req.body.bot_name || 'สายฝน'),
        String(req.body.persona_th || 'สุภาพ ลงท้ายด้วยคำว่าค่ะ'),
        String(req.body.forbidden_topics_th || ''),
        String(req.body.conversation_instructions_th || ''),
        String(req.body.admin_persona_th || ''),
        String(req.body.app_persona_th || ''),
        !!req.body.is_enabled,
        !!req.body.save_chat_history,
        !!req.body.hide_system_structure
      ]
    );

    req.session.success = 'บันทึก AI Settings เรียบร้อยแล้ว';
    return res.redirect('/admin/ai-settings');
  } catch (error) {
    console.error('SAVE AI SETTINGS ERROR:', error);
    req.session.error = error.message || 'บันทึก AI Settings ไม่สำเร็จ';
    return res.redirect('/admin/ai-settings');
  }
});

const COUPON_PAGE_SIZE = 10;

function buildCouponListWhere({ used = false, search = '', type = 'all' }, params) {
  const clauses = [];
  if (used) {
    clauses.push('EXISTS (SELECT 1 FROM coupon_usages cu WHERE cu.coupon_id = c.id)');
  } else {
    clauses.push('NOT EXISTS (SELECT 1 FROM coupon_usages cu WHERE cu.coupon_id = c.id)');
  }

  const searchText = String(search || '').trim();
  if (searchText) {
    params.push(`%${searchText}%`);
    const idx = params.length;
    clauses.push(`(
      COALESCE(c.coupon_code, '') ILIKE $${idx}
      OR COALESCE(c.coupon_name, '') ILIKE $${idx}
      OR COALESCE(c.coupon_type, '') ILIKE $${idx}
      OR COALESCE(c.print_note, '') ILIKE $${idx}
      OR COALESCE(c.note, '') ILIKE $${idx}
      OR COALESCE(c.description, '') ILIKE $${idx}
      OR CAST(c.id AS TEXT) ILIKE $${idx}
      OR COALESCE(c.display_id, '') ILIKE $${idx}
    )`);
  }

  const couponType = String(type || 'all').trim().toLowerCase();
  if (couponType && couponType !== 'all') {
    params.push(couponType);
    clauses.push(`LOWER(COALESCE(c.coupon_type, '')) = $${params.length}`);
  }

  return `WHERE ${clauses.join(' AND ')}`;
}

async function fetchCouponSection({ used = false, search = '', type = 'all', page = 1 }) {
  const params = [];
  const where = buildCouponListWhere({ used, search, type }, params);
  const limit = COUPON_PAGE_SIZE;
  const safePage = Math.max(Number(page || 1), 1);
  const offset = (safePage - 1) * limit;

  const [rowsRes, countRes] = await Promise.all([
    query(
      `SELECT c.*
       FROM coupons c
       ${where}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    ),
    query(
      `SELECT COUNT(*)::int AS total
       FROM coupons c
       ${where}`,
      params
    )
  ]);

  const totalRows = Number(countRes.rows[0]?.total || 0);
  return {
    rows: rowsRes.rows,
    totalRows,
    currentPage: safePage,
    totalPages: Math.max(Math.ceil(totalRows / limit), 1)
  };
}

router.get('/coupons', async (req, res) => {
  const filterValues = {
    q: String(req.query.q || '').trim(),
    type: String(req.query.type || 'all').trim().toLowerCase(),
    used_q: String(req.query.used_q || req.query.used_coupon || '').trim()
  };
  const unusedPage = Math.max(parseInt(req.query.unused_page || '1', 10) || 1, 1);
  const usedPage = Math.max(parseInt(req.query.used_page || '1', 10) || 1, 1);
  const usagePage = Math.max(parseInt(req.query.usage_page || '1', 10) || 1, 1);

  const [
    unusedSection,
    usedSection,
    usageRes,
    usageHistorySection,
    couponStatsRes
  ] = await Promise.all([
    fetchCouponSection({
      used: false,
      search: filterValues.q,
      type: filterValues.type,
      page: unusedPage
    }),
    fetchCouponSection({
      used: true,
      search: filterValues.used_q,
      type: 'all',
      page: usedPage
    }),
    query(`
      SELECT
        cu.id,
        cu.used_at,
        cu.note,
        c.coupon_code,
        c.coupon_name,
        c.coupon_type,
        u.full_name,
        u.email,
        COALESCE(NULLIF(TRIM(p.display_id), ''), NULLIF(TRIM(p.order_no), ''), p.id::text) AS payment_code
      FROM coupon_usages cu
      LEFT JOIN coupons c ON c.id = cu.coupon_id
      LEFT JOIN users u ON u.id = cu.user_id
      LEFT JOIN payments p ON p.id = cu.payment_id
      ORDER BY cu.used_at DESC
      LIMIT 8
    `),
    (async () => {
      const params = [];
      const whereParts = [];
      if (filterValues.used_q) {
        params.push(`%${filterValues.used_q}%`);
        const idx = params.length;
        whereParts.push(`(
          COALESCE(c.coupon_code, '') ILIKE $${idx}
          OR COALESCE(NULLIF(TRIM(u.full_name), ''), u.email, '') ILIKE $${idx}
          OR COALESCE(NULLIF(TRIM(p.display_id), ''), NULLIF(TRIM(p.order_no), ''), p.id::text, '') ILIKE $${idx}
        )`);
      }
      const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      const limit = COUPON_PAGE_SIZE;
      const offset = (usagePage - 1) * limit;
      const [rowsRes, countRes] = await Promise.all([
        query(
          `SELECT
            cu.id,
            cu.used_at AS created_at,
            cu.note,
            c.coupon_code,
            COALESCE(NULLIF(TRIM(u.full_name), ''), u.email, '-') AS username,
            COALESCE(NULLIF(TRIM(p.display_id), ''), NULLIF(TRIM(p.order_no), ''), p.id::text) AS payment_code
          FROM coupon_usages cu
          LEFT JOIN coupons c ON c.id = cu.coupon_id
          LEFT JOIN users u ON u.id = cu.user_id
          LEFT JOIN payments p ON p.id = cu.payment_id
          ${where}
          ORDER BY cu.used_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
          params
        ),
        query(
          `SELECT COUNT(*)::int AS total
           FROM coupon_usages cu
           LEFT JOIN coupons c ON c.id = cu.coupon_id
           LEFT JOIN users u ON u.id = cu.user_id
           LEFT JOIN payments p ON p.id = cu.payment_id
           ${where}`,
          params
        )
      ]);
      const totalRows = Number(countRes.rows[0]?.total || 0);
      return {
        rows: rowsRes.rows,
        totalRows,
        currentPage: usagePage,
        totalPages: Math.max(Math.ceil(totalRows / limit), 1)
      };
    })(),
    query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM coupon_usages cu WHERE cu.coupon_id = coupons.id)
        )::int AS unused,
        COUNT(*) FILTER (
          WHERE EXISTS (SELECT 1 FROM coupon_usages cu WHERE cu.coupon_id = coupons.id)
        )::int AS used,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(coupon_type, '')) = 'free')::int AS free_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(coupon_type, '')) = 'discount')::int AS discount_count
      FROM coupons
    `)
  ]);

  const stats = couponStatsRes.rows[0] || {};

  return res.render('admin/coupons', baseView(req, {
    pageTitle: 'Coupons',
    pageCss: 'admin-coupons.css',
    currentPath: '/admin/coupons',
    coupons: unusedSection.rows,
    usedCouponsList: usedSection.rows,
    usages: usageRes.rows,
    latestCouponUsages: usageHistorySection.rows,
    filterValues,
    usedCouponQuery: filterValues.used_q,
    unusedPagination: {
      currentPage: unusedSection.currentPage,
      totalPages: unusedSection.totalPages,
      totalRows: unusedSection.totalRows
    },
    usedPagination: {
      currentPage: usedSection.currentPage,
      totalPages: usedSection.totalPages,
      totalRows: usedSection.totalRows
    },
    usagePagination: {
      currentPage: usageHistorySection.currentPage,
      totalPages: usageHistorySection.totalPages,
      totalRows: usageHistorySection.totalRows
    },
    couponStats: {
      total: Number(stats.total || 0),
      unused: Number(stats.unused || 0),
      used: Number(stats.used || 0),
      free: Number(stats.free_count || 0),
      discount: Number(stats.discount_count || 0)
    }
  }));
});

router.post('/coupons/create', async (req, res) => {
  const total = Math.max(1, Math.min(200, Number(req.body.generate_total || 1)));
  const prefix = String(req.body.prefix || 'AVL').trim().toUpperCase();
  const couponName = String(req.body.coupon_name || '').trim();
  const couponType = String(req.body.coupon_type || 'discount').trim().toLowerCase();
  const discountMode = String(req.body.discount_mode || 'amount').trim().toLowerCase();

  const freeDays = couponType === 'free' ? Number(req.body.free_days || 0) : 0;
  const freePackageGroup = couponType === 'free'
    ? String(req.body.free_package_group || '').trim().toUpperCase()
    : null;

  const discountAmount = couponType === 'discount' && discountMode === 'amount'
    ? Number(req.body.discount_amount || 0)
    : 0;

  const discountPercent = couponType === 'discount' && discountMode === 'percent'
    ? Number(req.body.discount_percent || 0)
    : 0;

  if (couponType === 'free') {
    if (!['BASIC', 'PRO', 'ADVANCED'].includes(freePackageGroup)) {
      req.session.error = 'กรุณาเลือกระดับแพ็กเกจสำหรับคูปองฟรี';
      return res.redirect('/admin/coupons');
    }

    if (freeDays <= 0) {
      req.session.error = 'กรุณากำหนดจำนวนวันฟรี';
      return res.redirect('/admin/coupons');
    }
  }

  if (couponType === 'discount') {
    if (!['amount', 'percent'].includes(discountMode)) {
      req.session.error = 'กรุณาเลือกประเภทส่วนลด บาท หรือ %';
      return res.redirect('/admin/coupons');
    }

    if (discountMode === 'amount' && discountAmount <= 0) {
      req.session.error = 'กรุณากรอกส่วนลดแบบบาท';
      return res.redirect('/admin/coupons');
    }

    if (discountMode === 'percent' && (discountPercent <= 0 || discountPercent > 100)) {
      req.session.error = 'กรุณากรอกส่วนลดแบบ % ระหว่าง 1-100';
      return res.redirect('/admin/coupons');
    }
  }

  const generatedCodes = [];

  for (let n = 0; n < total; n += 1) {
    const code = `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    generatedCodes.push(code);

    await query(
      `INSERT INTO coupons (
        coupon_name,
        coupon_code,
        coupon_type,
        discount_mode,
        discount_amount,
        discount_percent,
        is_free,
        free_days,
        free_package_group,
        usage_limit,
        expires_at,
        is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,TRUE)`,
      [
        couponName,
        code,
        couponType,
        discountMode,
        discountAmount,
        discountPercent,
        couponType === 'free',
        freeDays,
        freePackageGroup,
        req.body.expires_at || null
      ]
    );
  }

  req.session.success = `สร้างคูปองเรียบร้อยแล้ว ${generatedCodes.length} โค้ด`;
  req.session.generatedCoupons = {
    title: couponName,
    generatedAt: new Date().toISOString(),
    note: String(req.body.print_note || '').trim(),
    codes: generatedCodes
  };

  return res.redirect('/admin/coupons');
});

router.get('/coupons/print/latest', async (req, res) => {
  const latest = req.session.generatedCoupons;
  if (!latest?.codes?.length) {
    req.session.error = 'ยังไม่มีคูปองที่สร้างล่าสุดสำหรับพิมพ์';
    return res.redirect('/admin/coupons');
  }

  return res.render('admin/coupons-print', baseView(req, {
    pageTitle: 'Print Coupons',
    pageCss: 'admin-coupons.css',
    currentPath: '/admin/coupons',
    printData: latest
  }));
});

router.post('/coupons/:id/delete', async (req, res) => {
  await query(`DELETE FROM coupons WHERE id = $1`, [req.params.id]);
  req.session.success = 'ลบคูปองเรียบร้อยแล้ว';
  return res.redirect('/admin/coupons');
});


router.get('/vps', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = 10;
    const offset = (page - 1) * limit;

    const [countRes, nodesRes, sessionsRes] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM vps_nodes`),
      query(`
        SELECT *
        FROM vps_nodes
        ORDER BY status ASC, node_name ASC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      query(`SELECT * FROM bot_sessions ORDER BY updated_at DESC LIMIT 100`).catch(() => ({ rows: [] }))
    ]);

    const allNodesRes = await query(`SELECT * FROM vps_nodes`);

    const totalRows = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / limit));

    const vpsSummary = {
      totalNodes: allNodesRes.rows.length,
      onlineNodes: allNodesRes.rows.filter(s => s.status === 'available').length,
      offlineNodes: allNodesRes.rows.filter(s => s.status === 'offline').length,
      usedPorts: allNodesRes.rows.reduce((a,b)=>a+Number(b.used_ports||0),0),
      totalPorts: allNodesRes.rows.reduce((a,b)=>a+Number(b.max_ports||0),0),
      usedLot: allNodesRes.rows.reduce((a,b)=>a+Number(b.used_lot||0),0),
      totalLot: allNodesRes.rows.reduce((a,b)=>a+Number(b.max_lot||0),0),
      runningBots: sessionsRes.rows.filter(s=>s.status==='running').length,
      stoppedBots: sessionsRes.rows.filter(s=>s.status==='stopped').length,
      errorBots: sessionsRes.rows.filter(s=>s.status==='error').length
    };

    return res.render('admin/vps', baseView(req, {
      pageTitle: 'VPS / MT5',
      currentPath: '/admin/vps',
      nodes: nodesRes.rows || [],
      vpsSummary,
      logs: [],
      pagination: {
        page,
        limit,
        totalRows,
        totalPages
      }
    }));
  } catch (err) {
    console.error('ADMIN VPS ERROR:', err);
    return res.status(500).send('ADMIN VPS ERROR');
  }
});

router.post('/vps/port-health', async (req, res) => {
  try {
    const body = req.body || {};
    const metrics = body.metrics || {};
    const ports = Array.isArray(body.ports) ? body.ports : [];

    const nodeRes = await query(`
      SELECT id FROM vps_nodes
      WHERE computer_name = $1 OR node_name = $1
      ORDER BY id ASC
      LIMIT 1
    `, [metrics.computer_name || '']);

    const nodeId = nodeRes.rows[0]?.id;
    if (!nodeId) return res.json({ ok: false, error: 'node_not_found' });

    for (const p of ports) {
      await query(`
        INSERT INTO vps_system.vps_port_health
          (node_id, port_number, folder_path, running, pid, updated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
        ON CONFLICT (node_id, port_number)
        DO UPDATE SET
          folder_path = EXCLUDED.folder_path,
          running = EXCLUDED.running,
          pid = EXCLUDED.pid,
          updated_at = NOW()
      `, [
        nodeId,
        Number(p.portNumber),
        p.folderPath || '',
        !!p.running,
        JSON.stringify(p.pid || [])
      ]);


      // ✅ Sync สถานะจริงลงตารางกลาง: terminal64.exe รันอยู่ = used/full, ไม่รัน = free
      // ใช้เฉพาะ health จาก Agent จึงไม่ค้างเป็น "เต็ม" ถ้า process หายไปแล้ว
      const livePortNo = Number(p.portNumber || 0);
      const liveStatus = !!p.running ? 'used' : 'free';
      if (livePortNo > 0) {
        await query(`
          UPDATE vps_allocations
          SET status=$3,
              updated_at=NOW()
          WHERE node_id=$1
            AND COALESCE(
              NULLIF((regexp_match(COALESCE(port_name, ''), '(?i)PORT[-_ ]*([0-9]+)$'))[1], '')::int,
              NULLIF(regexp_replace(COALESCE(port_number::text, ''), '[^0-9]', '', 'g'), '')::int,
              0
            )=$2
            AND LOWER(COALESCE(status,'free')) NOT IN ('disabled','off','deleted','locked')
        `, [nodeId, livePortNo, liveStatus]).catch(() => {});
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('PORT HEALTH ERROR:', err);
    return res.json({ ok: false, error: err.message });
  }
});

router.get('/vps/:id/ports', async (req, res) => {
  try {
    const nodeId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = 20;
    const offset = (page - 1) * limit;

    const nodeRes = await query(`
      SELECT *
      FROM vps_nodes
      WHERE id = $1
      LIMIT 1
    `, [nodeId]);

    if (!nodeRes.rows.length) {
      return res.redirect('/admin/vps');
    }

    // ใช้สถานะสดจาก Python Agent ที่สแกน terminal64.exe จริงเท่านั้น
    // ห้ามใช้ status ใน vps_allocations เพราะอาจค้างเป็น used/full จากของเก่า
    const healthRes = await query(`
      SELECT port_number, folder_path, running, pid, updated_at
      FROM vps_system.vps_port_health
      WHERE node_id = $1
        AND updated_at > NOW() - INTERVAL '2 minutes'
    `, [nodeId]).catch(() => ({ rows: [] }));

    const liveMap = {};
    for (const hp of (healthRes.rows || [])) {
      const portNo = Number(hp.port_number || 0);
      if (!portNo) continue;
      const key = 'PORT' + String(portNo).padStart(2, '0');
      liveMap[key] = {
        portNumber: portNo,
        folderPath: hp.folder_path,
        running: hp.running === true,
        pid: hp.pid || []
      };
    }

    const [countRes, portsRes] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total FROM vps_allocations WHERE node_id = $1`, [nodeId]),
      query(`
        SELECT p.*,
               u.full_name,
               u.email
        FROM vps_allocations p
        LEFT JOIN users u ON u.id = p.user_id
        WHERE p.node_id = $1
        ORDER BY p.id ASC
        LIMIT $2 OFFSET $3
      `, [nodeId, limit, offset])
    ]);

// สถานะหน้านี้อิงจาก terminal64.exe ที่ Agent สแกนจริงเท่านั้น
const usedAccountMap = {};

const ports = (portsRes.rows || []).map((p) => {
  const match = String(p.port_name || p.display_name || p.port_number || '').match(/PORT[-\s]?(\d+)/i);
  const portNo = match ? Number(match[1]) : Number(p.port_number || 0);
  const key = 'PORT' + String(portNo).padStart(2, '0');

  const live = liveMap[key];

  if (live?.running) {
    return {
      ...p,
      status: 'used',
      live_status: 'used',
      live_pid: live?.pid || null,
      is_running: !!live?.running,
      mt5_login: null
    };
  }

  return {
    ...p,
    status: 'free',
    live_status: 'free',
    is_running: false
  };
});

    const totalRows = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / limit));

    return res.render('admin/vps-ports', baseView(req, {
      pageTitle: 'Port ของ Windows VPS',
      currentPath: '/admin/vps',
      node: nodeRes.rows[0],
      ports,
      pagination: {
        page,
        limit,
        totalRows,
        totalPages
      }
    }));
  } catch (err) {
    console.error('ADMIN VPS PORTS ERROR:', err);
    return res.redirect('/admin/vps');
  }
});

router.post('/vps/create', async (req, res) => {
  await query(
    `INSERT INTO vps_nodes (
      node_name,
      ip_address,
      max_lot,
      max_ports,
      used_lot,
      used_ports,
      ping_ms,
      speed_mbps,
      status,
      last_error,
      last_check_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
    [
      String(req.body.node_name || '').trim(),
      String(req.body.ip_address || '').trim(),
      Number(req.body.max_lot || 0),
      Number(req.body.max_ports || 0),
      Number(req.body.used_lot || 0),
      Number(req.body.used_ports || 0),
      Number(req.body.ping_ms || 0),
      Number(req.body.speed_mbps || 0),
      String(req.body.status || 'available').trim(),
      String(req.body.last_error || '').trim()
    ]
  );

  req.session.success = 'เพิ่ม VPS node แล้ว';
  return res.redirect('/admin/vps');
});








router.get('/vps/:id/edit', async (req, res) => {
  try {
    const id = req.params.id;
    const nodeRes = await query(`SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1`, [id]);
    if (!nodeRes.rows.length) return res.redirect('/admin/vps');

    let agentTemplate = '';
    try {
      agentTemplate = require('fs').readFileSync('/root/trading-avelqua/storage/vps-agent/agent-current.ps1', 'utf8');
    } catch (_) {}

    let queryNotice = null;
    if (req.query.saved === '1') queryNotice = { type: 'success', text: 'บันทึก VPS เรียบร้อยแล้ว' };
    else if (req.query.token === 'updated') queryNotice = { type: 'info', text: 'สร้าง Agent TOKEN ใหม่เรียบร้อยแล้ว' };
    else if (req.query.updated_powershell === '1') queryNotice = { type: 'info', text: 'อัปเดต agent.ps1 เรียบร้อยแล้ว' };
    else if (req.query.agent_update === 'sent') queryNotice = { type: 'info', text: 'ส่งคำสั่งอัปเดต Agent แล้ว' };

    return res.render('admin/vps-node-form', baseView(req, {
      pageTitle: 'แก้ไข Windows VPS',
      pageCss: 'admin-vps-edit.css',
      currentPath: '/admin/vps',
      mode: 'edit',
      node: nodeRes.rows[0],
      agentTemplate,
      queryNotice,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://trading.avelqua.com'
    }));
  } catch (err) {
    console.error('VPS EDIT PAGE ERROR:', err);
    req.session.error = 'โหลดหน้าแก้ไข VPS ไม่สำเร็จ: ' + err.message;
    return res.redirect('/admin/vps');
  }
});

router.post('/vps/:id/update', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const maxLot = Number(b.max_lots || b.max_lot || 0);
    const cpuAlarm = Number(b.cpu_alarm || b.alarm_cpu_percent || 80);
    const ramAlarm = Number(b.ram_alarm || b.alarm_ram_percent || 85);
    const pingAlarm = Number(b.ping_alarm || b.alarm_ping_ms || 150);
    const botFolder = String(b.bot_folder || b.allowed_folder || '').trim();

    await query(`
      UPDATE vps_nodes
      SET node_name=$2, ip_address=$3, max_ports=$4,
          max_lot=$5, max_lots=$5,
          cpu_alarm=$6, ram_alarm=$7, ping_alarm=$8,
          bot_folder=$9, allowed_folder=$9,
          agent_folder=$10, agent_url=$11, updated_at=NOW()
      WHERE id=$1
    `, [
      id,
      String(b.node_name || '').trim(),
      String(b.ip_address || '').trim(),
      Number(b.max_ports || 0),
      maxLot, cpuAlarm, ramAlarm, pingAlarm,
      botFolder,
      String(b.agent_folder || '').trim(),
      String(b.agent_url || '').trim()
    ]);

    req.session.success = 'บันทึก VPS เรียบร้อยแล้ว';
    return res.redirect('/admin/vps/' + id + '/edit?saved=1');
  } catch (err) {
    console.error('VPS UPDATE SAVE ERROR:', err);
    req.session.error = 'บันทึก VPS ไม่สำเร็จ: ' + err.message;
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
});



router.get('/ai-history', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    const result = await query(`
      SELECT
        s.*,
        u.full_name,
        u.email,
        COALESCE(msg.message_count, 0) AS message_count
      FROM ai_chat_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN (
        SELECT session_key, COUNT(*)::int AS message_count
        FROM ai_chat_messages
        GROUP BY session_key
      ) msg ON msg.session_key = s.session_key
      WHERE (
        $1 = ''
        OR s.session_key ILIKE '%' || $1 || '%'
        OR COALESCE(u.full_name, '') ILIKE '%' || $1 || '%'
        OR COALESCE(u.email, '') ILIKE '%' || $1 || '%'
      )
      ORDER BY s.updated_at DESC
      LIMIT 200
    `, [q]);

    return res.render('admin/ai-history', baseView(req, {
      pageTitle: 'AI History',
      currentPath: '/admin/ai-history',
      sessions: result.rows,
      q
    }));
  } catch (error) {
    console.error('ai history error:', error);
    return res.status(500).send(error.message || 'AI history error');
  }
});

router.get('/ai-history/:sessionKey', async (req, res) => {
  try {
    const sessionKey = req.params.sessionKey;

    const sessionResult = await query(`
      SELECT s.*, u.full_name, u.email
      FROM ai_chat_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.session_key = $1
      LIMIT 1
    `, [sessionKey]);

    if (!sessionResult.rows.length) {
      return res.status(404).send('Session not found');
    }

    const messagesResult = await query(`
      SELECT *
      FROM ai_chat_messages
      WHERE session_key = $1
      ORDER BY created_at ASC
    `, [sessionKey]);

    return res.render('admin/ai-history-detail', baseView(req, {
      pageTitle: 'AI History Detail',
      currentPath: '/admin/ai-history',
      sessionInfo: sessionResult.rows[0],
      messages: messagesResult.rows
    }));
  } catch (error) {
    console.error('ai history detail error:', error);
    return res.status(500).send(error.message || 'AI history detail error');
  }
});

router.get('/scoin-market', async (req, res) => {
  try {
    await ensureScoinCirculationSchema();
    const circulationSummary = await getCirculationSummary();

    const [
  settingsRes,
  realtimeChartRes,
  hostWalletRes,
  economySettingsRes,
  treasuryRes,
  economyLogsRes,
  circulationLogsRes,
  ordersRes,
  transactionsRes,
  walletsRes,
  priceHistoryRes
] = await Promise.all([
      query(`SELECT * FROM scoin_settings WHERE id = 1 LIMIT 1`),

query(`
  WITH hourly AS (
    SELECT generate_series(
      date_trunc('hour', NOW() - INTERVAL '23 hours'),
      date_trunc('hour', NOW()),
      INTERVAL '1 hour'
    ) AS bucket
  ), order_flow AS (
    SELECT
      date_trunc('hour', created_at) AS bucket,
      COALESCE(SUM(CASE WHEN order_type = 'buy' THEN scoin_amount ELSE 0 END),0) AS buy_scoin,
      COALESCE(SUM(CASE WHEN order_type = 'sell' THEN scoin_amount ELSE 0 END),0) AS sell_scoin,
      COALESCE(SUM(CASE WHEN order_type = 'buy' THEN gross_amount_thb ELSE 0 END),0) AS buy_thb,
      COALESCE(SUM(CASE WHEN order_type = 'sell' THEN gross_amount_thb ELSE 0 END),0) AS sell_thb,
      COALESCE(SUM(fee_amount_thb),0) AS fee_thb,
      COUNT(*) AS order_count
    FROM scoin_market_orders
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY 1
  ), base AS (
    SELECT COALESCE((SELECT current_price_thb FROM scoin_settings WHERE id = 1), 0.10) AS current_price
  )
  SELECT
    TO_CHAR(h.bucket, 'HH24:00') AS label,
    h.bucket AS chart_time,
    COALESCE(of.buy_scoin, 0) AS buy_scoin,
    COALESCE(of.sell_scoin, 0) AS sell_scoin,
    COALESCE(of.buy_thb, 0) AS buy_thb,
    COALESCE(of.sell_thb, 0) AS sell_thb,
    COALESCE(of.fee_thb, 0) AS fee_thb,
    COALESCE(of.order_count, 0) AS order_count,
    ROUND((base.current_price * (1 + LEAST(0.15, GREATEST(-0.15,
      (COALESCE(of.buy_scoin,0) - COALESCE(of.sell_scoin,0)) / NULLIF((COALESCE(of.buy_scoin,0) + COALESCE(of.sell_scoin,0)),0) * 0.03
    ))))::numeric, 4) AS flow_price_thb
  FROM hourly h
  CROSS JOIN base
  LEFT JOIN order_flow of ON of.bucket = h.bucket
  ORDER BY h.bucket ASC
`).catch(() => ({ rows: [] })),

query(`
  SELECT *
  FROM system_wallets
  WHERE wallet_type = 'host_scoin'
  LIMIT 1
`).catch(() => ({ rows: [] })),

      query(`
        SELECT *
        FROM scoin_economy_settings
        ORDER BY id DESC
        LIMIT 1
      `).catch(() => ({ rows: [] })),

      query(`
        SELECT *
        FROM scoin_treasury_wallets
        ORDER BY id ASC
      `).catch(() => ({ rows: [] })),

      query(`
        SELECT *
        FROM scoin_economy_logs
        ORDER BY created_at DESC
        LIMIT 100
      `).catch(() => ({ rows: [] })),

      query(`
        SELECT
          l.*,
          u.email,
          COALESCE(NULLIF(u.full_name, ''), u.email) AS full_name
        FROM scoin_circulation_logs l
        LEFT JOIN users u ON u.id = l.user_id
        ORDER BY l.created_at DESC
        LIMIT 200
      `).catch(() => ({ rows: [] })),

      query(`
        SELECT
          o.*,
          u.email,
          COALESCE(NULLIF(u.full_name, ''), u.email) AS full_name,
          ba.bank_name,
          ba.account_name,
          ba.account_number_masked,
          ba.is_verified AS bank_is_verified
        FROM scoin_market_orders o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN user_bank_accounts ba ON ba.id = o.bank_account_id
        ORDER BY o.created_at DESC
        LIMIT 200
      `),

      query(`
        SELECT
          st.*,
          u.email,
          COALESCE(NULLIF(u.full_name, ''), u.email) AS full_name
        FROM scoin_transactions st
        LEFT JOIN users u ON u.id = st.user_id
        ORDER BY st.created_at DESC
        LIMIT 200
      `),

      query(`
        SELECT
          w.*,
          u.email,
          COALESCE(NULLIF(u.full_name, ''), u.email) AS full_name
        FROM scoin_wallets w
        LEFT JOIN users u ON u.id = w.user_id
        ORDER BY w.created_at DESC
        LIMIT 200
      `),

      query(`
        SELECT *
        FROM scoin_price_history
        ORDER BY created_at DESC
        LIMIT 30
      `)
    ]);

    return res.render('admin/scoin-market', baseView(req, {
      pageTitle: 'Scoin Market',
      currentPath: '/admin/scoin-market',
      scoinSettings: settingsRes.rows[0] || null,
      economySettings: economySettingsRes.rows[0] || null,
      treasuryWallets: treasuryRes.rows || [],
      economyLogs: economyLogsRes.rows || [],
      circulationLogs: circulationLogsRes.rows || [],
      circulationSummary,
      orders: ordersRes.rows,
      transactions: transactionsRes.rows,
      wallets: walletsRes.rows,
      priceHistory: (priceHistoryRes.rows || []).reverse(),
	realtimeChart: realtimeChartRes.rows || [],
	hostWallet: hostWalletRes.rows[0] || null
    }));
  } catch (error) {
    console.error('admin scoin market error:', error);
    req.session.error = 'โหลดตลาด Scoin ไม่สำเร็จ';
    return res.redirect('/admin');
  }
});


router.get('/scoin-market/export/:type', async (req, res) => {
  try {
    await ensureScoinMarketAdminColumns();
    await ensureScoinCirculationSchema();
    const type = String(req.params.type || '').toLowerCase();
    const cfg = await scoinBuildExportQuery(type);
    if (!cfg) return res.status(404).send('Export type not found or table not found');

    const result = await query(cfg.sql);
    const rows = (result.rows || []).map((row) => {
      const out = { ...row };
      if ('created_at' in out) out.created_at = scoinExcelDate(out.created_at);
      if ('is_active' in out) out.is_active = out.is_active === null || out.is_active === undefined ? '' : (out.is_active ? 'active' : 'inactive');
      return out;
    });

    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ report: 'ไม่มีข้อมูล' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.sheet);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="scoin-${type}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.send(buf);
  } catch (error) {
    console.error('scoin export error:', error);
    return res.status(500).send(`Export failed: ${error.message || error}`);
  }
});

router.post('/scoin-market/settings', async (req, res) => {
  const client = await getClient();

  try {
    await ensureScoinCirculationSchema(client);
    await client.query('BEGIN');

    const currentSettingsRes = await client.query(`SELECT * FROM scoin_settings WHERE id = 1 LIMIT 1`);
    const currentEconomyRes = await client.query(`
      SELECT *
      FROM scoin_economy_settings
      ORDER BY id DESC
      LIMIT 1
    `);

    const currentSettings = currentSettingsRes.rows[0] || {};
    const currentEconomy = currentEconomyRes.rows[0] || {};

    const mergedMarket = {
      current_price_thb: req.body.current_price_thb !== undefined && req.body.current_price_thb !== ''
        ? Number(req.body.current_price_thb)
        : Number(currentSettings.current_price_thb || 0.10),
      transfer_fee_percent: req.body.transfer_fee_percent !== undefined && req.body.transfer_fee_percent !== ''
        ? Number(req.body.transfer_fee_percent)
        : Number(currentSettings.transfer_fee_percent || 1.20),
      buy_fee_percent: req.body.buy_fee_percent !== undefined && req.body.buy_fee_percent !== ''
        ? Number(req.body.buy_fee_percent)
        : Number(currentSettings.buy_fee_percent || currentSettings.transfer_fee_percent || 3),
      sell_fee_percent: req.body.sell_fee_percent !== undefined && req.body.sell_fee_percent !== ''
        ? Number(req.body.sell_fee_percent)
        : Number(currentSettings.sell_fee_percent || currentSettings.transfer_fee_percent || 3),
      market_supply: req.body.market_supply !== undefined && req.body.market_supply !== ''
        ? Number(req.body.market_supply)
        : Number(currentSettings.market_supply || 0),
      price_change_rate: req.body.price_change_rate !== undefined && req.body.price_change_rate !== ''
        ? Number(req.body.price_change_rate) / 100
        : Number(currentSettings.price_change_rate || 0.03),
      auto_price_enabled: Object.prototype.hasOwnProperty.call(req.body, 'auto_price_enabled')
        ? !!req.body.auto_price_enabled
        : !!currentSettings.auto_price_enabled
    };

    const mergedEconomy = {
      thb_to_scoin_rate: req.body.thb_to_scoin_rate !== undefined && req.body.thb_to_scoin_rate !== ''
        ? Number(req.body.thb_to_scoin_rate)
        : Number(currentEconomy.thb_to_scoin_rate || 0.8),
      company_profit_percent: req.body.company_profit_percent !== undefined && req.body.company_profit_percent !== ''
        ? Number(req.body.company_profit_percent)
        : Number(currentEconomy.company_profit_percent || 35),
      network_bonus_percent: req.body.network_bonus_percent !== undefined && req.body.network_bonus_percent !== ''
        ? Number(req.body.network_bonus_percent)
        : Number(currentEconomy.network_bonus_percent || 20),
      buyback_reserve_percent: req.body.buyback_reserve_percent !== undefined && req.body.buyback_reserve_percent !== ''
        ? Number(req.body.buyback_reserve_percent)
        : Number(currentEconomy.buyback_reserve_percent || 20),
      burn_liquidity_percent: req.body.burn_liquidity_percent !== undefined && req.body.burn_liquidity_percent !== ''
        ? Number(req.body.burn_liquidity_percent)
        : Number(currentEconomy.burn_liquidity_percent || 10),
      promotion_percent: req.body.promotion_percent !== undefined && req.body.promotion_percent !== ''
        ? Number(req.body.promotion_percent)
        : Number(currentEconomy.promotion_percent || 10),
      system_marketing_percent: req.body.system_marketing_percent !== undefined && req.body.system_marketing_percent !== ''
        ? Number(req.body.system_marketing_percent)
        : Number(currentEconomy.system_marketing_percent || 5),
      level_1_percent: req.body.level_1_percent !== undefined && req.body.level_1_percent !== ''
        ? Number(req.body.level_1_percent)
        : Number(currentEconomy.level_1_percent || 8),
      level_2_percent: req.body.level_2_percent !== undefined && req.body.level_2_percent !== ''
        ? Number(req.body.level_2_percent)
        : Number(currentEconomy.level_2_percent || 5),
      level_3_percent: req.body.level_3_percent !== undefined && req.body.level_3_percent !== ''
        ? Number(req.body.level_3_percent)
        : Number(currentEconomy.level_3_percent || 3),
      level_4_percent: req.body.level_4_percent !== undefined && req.body.level_4_percent !== ''
        ? Number(req.body.level_4_percent)
        : Number(currentEconomy.level_4_percent || 2),
      level_5_percent: req.body.level_5_percent !== undefined && req.body.level_5_percent !== ''
        ? Number(req.body.level_5_percent)
        : Number(currentEconomy.level_5_percent || 2),
      daily_buyback_limit_percent: req.body.daily_buyback_limit_percent !== undefined && req.body.daily_buyback_limit_percent !== ''
        ? Number(req.body.daily_buyback_limit_percent)
        : Number(currentEconomy.daily_buyback_limit_percent || 5),
      burn_on_spend_percent: req.body.burn_on_spend_percent !== undefined && req.body.burn_on_spend_percent !== ''
        ? Number(req.body.burn_on_spend_percent)
        : Number(currentEconomy.burn_on_spend_percent || 5),
      is_enabled: Object.prototype.hasOwnProperty.call(req.body, 'economy_enabled')
        ? !!req.body.economy_enabled
        : !!currentEconomy.is_enabled
    };

    await client.query(
      `UPDATE scoin_settings
       SET
         current_price_thb = $1,
         transfer_fee_percent = $2,
         buy_fee_percent = $3,
         sell_fee_percent = $4,
         market_supply = $5,
         auto_price_enabled = $6,
         price_change_rate = $7,
         updated_at = NOW()
       WHERE id = 1`,
      [
        mergedMarket.current_price_thb,
        mergedMarket.transfer_fee_percent,
        mergedMarket.buy_fee_percent,
        mergedMarket.sell_fee_percent,
        mergedMarket.market_supply,
        mergedMarket.auto_price_enabled,
        mergedMarket.price_change_rate
      ]
    );

    if (Object.prototype.hasOwnProperty.call(req.body, 'sync_central_pool') && req.body.sync_central_pool) {
      await lockCentralWallet(client);
      await client.query(`
        UPDATE system_wallets
        SET balance = $2,
            updated_at = NOW()
        WHERE wallet_type = 'host_scoin'
      `, [mergedMarket.market_supply]);
    }

    if (currentEconomy.id) {
      await client.query(
        `UPDATE scoin_economy_settings
         SET
           thb_to_scoin_rate = $1,
           company_profit_percent = $2,
           network_bonus_percent = $3,
           buyback_reserve_percent = $4,
           burn_liquidity_percent = $5,
           promotion_percent = $6,
           system_marketing_percent = $7,
           level_1_percent = $8,
           level_2_percent = $9,
           level_3_percent = $10,
           level_4_percent = $11,
           level_5_percent = $12,
           daily_buyback_limit_percent = $13,
           burn_on_spend_percent = $14,
           is_enabled = $15,
           updated_at = NOW()
         WHERE id = $16`,
        [
          mergedEconomy.thb_to_scoin_rate,
          mergedEconomy.company_profit_percent,
          mergedEconomy.network_bonus_percent,
          mergedEconomy.buyback_reserve_percent,
          mergedEconomy.burn_liquidity_percent,
          mergedEconomy.promotion_percent,
          mergedEconomy.system_marketing_percent,
          mergedEconomy.level_1_percent,
          mergedEconomy.level_2_percent,
          mergedEconomy.level_3_percent,
          mergedEconomy.level_4_percent,
          mergedEconomy.level_5_percent,
          mergedEconomy.daily_buyback_limit_percent,
          mergedEconomy.burn_on_spend_percent,
          mergedEconomy.is_enabled,
          currentEconomy.id
        ]
      );
    }

    await client.query('COMMIT');
    req.session.success = 'บันทึกการตั้งค่า Scoin ทั้งหมดสำเร็จ';
    return res.redirect('/admin/scoin-market');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('save scoin settings error:', error);
    req.session.error = 'บันทึกการตั้งค่า Scoin ไม่สำเร็จ';
    return res.redirect('/admin/scoin-market');
  } finally {
    client.release();
  }
});

router.post('/scoin-market/wallets/create', async (req, res) => {
  try {
    const userId = Number(req.body.user_id || 0);

    if (!userId) {
      req.session.error = 'กรุณาเลือก user ก่อนสร้างรหัสกระเป๋า';
      return res.redirect('/admin/scoin-market');
    }

    const existingWalletRes = await query(
      `SELECT id, wallet_code
       FROM scoin_wallets
       WHERE user_id = $1
       LIMIT 1`,
      [userId]
    );

    if (existingWalletRes.rows.length) {
      req.session.error = `ผู้ใช้นี้มีรหัสกระเป๋าแล้ว: ${existingWalletRes.rows[0].wallet_code}`;
      return res.redirect('/admin/scoin-market');
    }

    let walletCode = '';
    for (let i = 0; i < 20; i += 1) {
      walletCode = generateWalletCode();

      const exists = await query(
        `SELECT id
         FROM scoin_wallets
         WHERE wallet_code = $1
         LIMIT 1`,
        [walletCode]
      );

      if (!exists.rows.length) break;
      walletCode = '';
    }

    if (!walletCode) {
      req.session.error = 'สร้างรหัสกระเป๋าไม่สำเร็จ';
      return res.redirect('/admin/scoin-market');
    }

    await query(
      `INSERT INTO scoin_wallets (
        user_id,
        wallet_code,
        wallet_type,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 'user', TRUE, NOW(), NOW())`,
      [userId, walletCode]
    );

    req.session.success = `สร้างรหัสกระเป๋าสำเร็จ: ${walletCode}`;
    return res.redirect('/admin/scoin-market');
  } catch (error) {
    console.error('create wallet code error:', error);

    if (String(error.code || '') === '23505') {
      req.session.error = 'ผู้ใช้นี้มีรหัสกระเป๋าแล้ว หรือรหัสซ้ำในระบบ';
      return res.redirect('/admin/scoin-market');
    }

    req.session.error = 'สร้างรหัสกระเป๋าไม่สำเร็จ';
    return res.redirect('/admin/scoin-market');
  }
});

router.post('/scoin-market/:id/approve', async (req, res) => {
  const client = await getClient();

  try {
    await ensureScoinCirculationSchema(client);
    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT *
       FROM scoin_market_orders
       WHERE id = $1
       FOR UPDATE`,
      [req.params.id]
    );

    const order = orderRes.rows[0];
    if (!order) throw new Error('ไม่พบคำสั่งตลาด');

    if (String(order.status) !== 'pending') {
      throw new Error('คำสั่งนี้ไม่ได้อยู่ในสถานะ pending');
    }

    const userRes = await client.query(
      `SELECT id, scoin_balance
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [order.user_id]
    );

    const user = userRes.rows[0];
    if (!user) throw new Error('ไม่พบผู้ใช้งาน');

    const scoinAmount = Number(order.scoin_amount || 0);
    let circ = null;

    if (String(order.order_type) === 'buy') {
      await postTransaction(client, {
        userId: user.id,
        direction: 'in',
        amount: scoinAmount,
        txType: 'market_buy',
        idempotencyKey: `market-buy-admin-${order.id}`,
        meta: {
          market_order_id: order.id,
          order_type: order.order_type,
          gross_amount_thb: order.gross_amount_thb,
          fee_amount_thb: order.fee_amount_thb,
          net_amount_thb: order.net_amount_thb
        }
      });

      circ = await applyMarketCirculation(client, order);
    } else if (String(order.order_type) === 'sell') {
      await finalizeSellLock(client, {
        userId: user.id,
        amount: scoinAmount,
        orderId: order.id,
        meta: {
          gross_amount_thb: order.gross_amount_thb,
          fee_amount_thb: order.fee_amount_thb,
          net_amount_thb: order.net_amount_thb
        }
      });

      circ = await applyMarketCirculation(client, order);

      await client.query(
        `INSERT INTO fiat_ledger (
          user_id, order_id, tx_type, amount_thb, status, note, created_at
        )
        VALUES ($1,$2,'scoin_sell_income',$3,'completed',$4,NOW())`,
        [
          order.user_id,
          order.id,
          order.net_amount_thb,
          'เงินบาทเข้าจากการขาย Scoin คืนโฮส'
        ]
      );
    } else {
      throw new Error('ประเภทคำสั่งไม่ถูกต้อง');
    }

    await client.query(
      `UPDATE scoin_market_orders
       SET status = 'approved',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id]
    );

    if (circ && !circ.duplicate) {
      const settingsRes = await client.query(`SELECT * FROM scoin_settings WHERE id = 1 LIMIT 1`);
      await applyAutoPriceAfterTrade(client, {
        order,
        flowType: String(order.order_type || '').toLowerCase(),
        scoinAmount,
        marketSupplyBefore: circ.marketSupplyBefore,
        settings: settingsRes.rows[0] || {}
      });
    }

    await client.query('COMMIT');
    req.session.success = 'อนุมัติคำสั่งตลาด Scoin สำเร็จ';
    return res.redirect('/admin/scoin-market');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('approve scoin market error:', error);
    req.session.error = error.message || 'อนุมัติคำสั่งไม่สำเร็จ';
    return res.redirect('/admin/scoin-market');
  } finally {
    client.release();
  }
});

router.post('/scoin-market/:id/confirm-transfer', async (req, res) => {
  try {
    const admin = req.user || req.session.user || {};

    await query(
      `UPDATE scoin_market_orders
       SET transfer_confirmed_at = NOW(),
           transfer_confirmed_by = $2,
           transfer_note = $3,
           payout_status = COALESCE(NULLIF(payout_status, ''), 'paid'),
           payout_paid_at = COALESCE(payout_paid_at, NOW()),
           payout_by_user_id = COALESCE(payout_by_user_id, $2),
           updated_at = NOW()
       WHERE id = $1
         AND order_type = 'sell'
         AND status = 'approved'`,
      [
        req.params.id,
        admin.id || null,
        String(req.body.transfer_note || '').trim()
      ]
    );

    req.session.success = 'ยืนยันการโอนเงินบาทแล้ว';
    return res.redirect('/admin/payments');
  } catch (error) {
    console.error('confirm transfer error:', error);
    req.session.error = 'ยืนยันการโอนไม่สำเร็จ';
    return res.redirect('/admin/payments');
  }
});

router.post('/scoin-market/:id/host-slip', hostSlipUpload.single('host_slip'), async (req, res) => {
  try {
    if (!req.file) {
      req.session.error = 'กรุณาเลือกไฟล์สลิปการโอน';
      return res.redirect('/admin/payments');
    }

    const slipUrl = `/uploads/host-slips/${req.file.filename}`;
    await query(
      `UPDATE scoin_market_orders
       SET host_transfer_slip_url = $2,
           payout_ref = COALESCE(NULLIF(payout_ref, ''), $3),
           updated_at = NOW()
       WHERE id = $1
         AND order_type = 'sell'`,
      [
        req.params.id,
        slipUrl,
        String(req.body.payout_ref || req.file.originalname || '').trim()
      ]
    );

    req.session.success = 'แนบสลิปการโอนของโฮสเรียบร้อยแล้ว';
    return res.redirect('/admin/payments');
  } catch (error) {
    console.error('host slip upload error:', error);
    req.session.error = error.message || 'แนบสลิปไม่สำเร็จ';
    return res.redirect('/admin/payments');
  }
});

router.post('/scoin-market/:id/reject', async (req, res) => {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      `SELECT *
       FROM scoin_market_orders
       WHERE id = $1
       FOR UPDATE`,
      [req.params.id]
    );

    const order = orderRes.rows[0];
    if (!order) throw new Error('ไม่พบคำสั่งตลาด');
    if (String(order.status) !== 'pending') {
      throw new Error('คำสั่งนี้ไม่ได้อยู่ในสถานะ pending');
    }

    if (String(order.order_type) === 'sell') {
      await releaseSellLock(client, {
        userId: order.user_id,
        amount: Number(order.scoin_amount || 0),
        orderId: order.id,
        reason: 'rejected'
      }).catch((error) => {
        if (!String(error.message || '').includes('Locked Scoin is not enough')) throw error;
      });
    }

    await client.query(
      `UPDATE scoin_market_orders
       SET status = 'rejected',
           updated_at = NOW()
       WHERE id = $1`,
      [order.id]
    );

    await client.query('COMMIT');

    req.session.success = 'ปฏิเสธคำสั่งตลาด Scoin แล้ว';
    return res.redirect('/admin/scoin-market');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('reject scoin market error:', error);
    req.session.error = error.message || 'ปฏิเสธคำสั่งไม่สำเร็จ';
    return res.redirect('/admin/scoin-market');
  } finally {
    client.release();
  }
});


router.post('/scoin-market/:id/delete', async (req, res) => {
  try {
    await query(`DELETE FROM scoin_market_orders WHERE id = $1`, [req.params.id]);
    req.session.success = 'ลบรายการขาย Scoin เรียบร้อยแล้ว';
    return res.redirect('/admin/payments');
  } catch (error) {
    console.error('delete scoin sell order error:', error);
    req.session.error = 'ลบรายการขาย Scoin ไม่สำเร็จ';
    return res.redirect('/admin/payments');
  }
});

router.post('/scoin-market/bulk-delete', async (req, res) => {
  try {
    const ids = String(req.body.ids || '')
      .split(',')
      .map(v => Number(v))
      .filter(Boolean);

    if (!ids.length) {
      req.session.error = 'กรุณาเลือกรายการก่อนลบ';
      return res.redirect('/admin/payments');
    }

    await query(
      `DELETE FROM scoin_market_orders WHERE id = ANY($1::bigint[])`,
      [ids]
    );

    req.session.success = `ลบรายการขาย Scoin ${ids.length} รายการแล้ว`;
    return res.redirect('/admin/payments');
  } catch (error) {
    console.error('bulk delete scoin sell order error:', error);
    req.session.error = 'ลบหลายรายการไม่สำเร็จ';
    return res.redirect('/admin/payments');
  }
});


router.get('/backups', async (req, res) => {
  try {
    const cron = await backupService.cronStatus();
    const backups = backupService.listBackups();
    return res.render('admin/backups', baseView(req, {
      pageTitle: 'Backup / Restore',
      currentPath: '/admin/backups',
      backups,
      cron,
      cronTime: cronTimeFromLine(cron.line),
      backupRoot: backupService.BACKUP_ROOT,
      keepLatest: backupService.KEEP_LATEST,
      formatBytes,
      formatThaiDateTime
    }));
  } catch (error) {
    console.error('admin backups page error:', error);
    req.session.error = 'โหลดหน้า Backup ไม่สำเร็จ: ' + error.message;
    return res.redirect('/admin');
  }
});

router.post('/backups/create', async (req, res) => {
  try {
    const result = await backupService.createBackup();
    req.session.success = `Backup สำเร็จ: ${result.name}`;
  } catch (error) {
    console.error('manual backup error:', error);
    req.session.error = 'Backup ไม่สำเร็จ: ' + error.message;
  }
  return res.redirect('/admin/backups');
});

router.post('/backups/cron', async (req, res) => {
  try {
    if (String(req.body.enabled) === '1') {
      const [hour, minute] = String(req.body.time || '03:00').split(':').map(Number);
      await backupService.installSundayCron(hour, minute);
      req.session.success = 'เปิด/ปรับ Auto Backup ทุกวันอาทิตย์เรียบร้อยแล้ว';
    } else {
      await backupService.removeCron();
      req.session.success = 'ปิด Auto Backup เรียบร้อยแล้ว';
    }
  } catch (error) {
    console.error('backup cron setting error:', error);
    req.session.error = 'ตั้งค่า Auto Backup ไม่สำเร็จ: ' + error.message;
  }
  return res.redirect('/admin/backups');
});

router.post('/backups/restore', async (req, res) => {
  try {
    if (String(req.body.confirm || '') !== 'YES') {
      req.session.error = 'กรุณาติ๊กยืนยันก่อน Restore';
      return res.redirect('/admin/backups');
    }
    const mode = ['all', 'files', 'db'].includes(String(req.body.mode)) ? String(req.body.mode) : 'all';
    const result = await backupService.restoreBackup(req.body.name, mode);
    req.session.success = `Restore สำเร็จ: ${result.restored} | Safety backup ก่อน Restore: ${result.safety_backup}`;
  } catch (error) {
    console.error('backup restore error:', error);
    req.session.error = 'Restore ไม่สำเร็จ: ' + error.message;
  }
  return res.redirect('/admin/backups');
});

router.get('/api/agent/commands', async (req, res) => {
  try {
    const token = req.headers['x-agent-token'];
    if (token !== process.env.AGENT_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await query(`
      SELECT
  id,
  node_id,
  bot_session_id,
  command_type AS command,
  command_payload AS payload,
  status,
  created_at,
  updated_at
FROM agent_commands
      WHERE status='pending'
      ORDER BY created_at ASC
      LIMIT 20
    `);

    res.json({ ok: true, commands: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/api/agent/commands/:id/done', async (req, res) => {
  try {
    const token = req.headers['x-agent-token'];
    if (token !== process.env.AGENT_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await query(
      `UPDATE agent_commands
       SET status='success',
           result_message=$2,
           finished_at=NOW(),
           updated_at=NOW()
       WHERE id=$1`,
      [
        req.params.id,
        JSON.stringify(req.body || {})
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/api/agent/commands', async (req, res) => {
  try {
    const token = req.headers['x-agent-token'];
    if (token !== process.env.AGENT_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const result = await query(`
      SELECT id, command_type
      FROM agent_commands
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 10
    `);

    await query(`
      UPDATE agent_commands
      SET status = 'picked',
          picked_at = NOW()
      WHERE id = ANY($1::bigint[])
    `, [result.rows.map(r => r.id)]);

    return res.json({
      ok: true,
      commands: result.rows
    });

  } catch (e) {
    console.error(e);
    return res.json({ ok: false, error: 'server_error' });
  }
});

router.post('/api/agent/commands/:id/done', async (req, res) => {
  try {
    const token = req.headers['x-agent-token'];
    if (token !== process.env.AGENT_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const status = req.body.ok ? 'success' : 'failed';

    await query(`
      UPDATE agent_commands
      SET status = $2,
          result_message = $3,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [
      req.params.id,
      status,
      JSON.stringify(req.body)
    ]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.json({ ok: false });
  }
});


/* ================= VPS CREATE / EDIT / COMMAND ================= */

router.get('/vps/create', async (req, res) => {
  return res.render('admin/vps-node-form', baseView(req, {
    pageTitle: 'เพิ่ม Windows VPS',
    currentPath: '/admin/vps',
    mode: 'create',
    node: {}
  }));
});


/* ===== VPS EDIT SAVE FINAL ===== */
router.post('/vps/:id/edit', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    console.log('[VPS SAVE FINAL]', id, b);

    await query(`
      UPDATE vps_nodes
      SET node_name=$2,
          ip_address=$3,
          max_ports=$4,
          max_lots=$5,
          cpu_alarm=$6,
          ram_alarm=$7,
          ping_alarm=$8,
          bot_folder=$9,
          agent_folder=$10,
          agent_url=$11,
          updated_at=NOW()
      WHERE id=$1
    `, [
      id,
      b.node_name || '',
      b.ip_address || '',
      Number(b.max_ports || 0),
      Number(b.max_lots || 0),
      Number(b.cpu_alarm || 80),
      Number(b.ram_alarm || 85),
      Number(b.ping_alarm || 150),
      b.bot_folder || '',
      b.agent_folder || '',
      b.agent_url || ''
    ]);

    return res.redirect('/admin/vps/' + id + '/edit?saved=1');
  } catch (err) {
    console.error('[VPS SAVE FINAL ERROR]', err);
    return res.status(500).send(err.message);
  }
});







router.post('/vps/nodes/:id/command', async (req, res) => {
  const { execSync } = require('child_process');
  const id = req.params.id;
  const command = req.body.command;

  try {
    const nodeRes = await query(`SELECT * FROM vps_nodes WHERE id = $1 LIMIT 1`, [id]);
    const node = nodeRes.rows[0];

    if (!node) return res.redirect('/admin/vps');

    if (command === 'connect_check') {
      let isOnline = false;

      try {
        if (node.ip_address) {
          execSync(`ping -c 1 -W 2 ${node.ip_address}`, { stdio: 'ignore' });
          isOnline = true;
        }
      } catch (e) {
        isOnline = false;
      }

      await query(`
        UPDATE vps_nodes
        SET status = $1,
            last_seen_at = NOW(),
            updated_at = NOW()
        WHERE id = $2
      `, [isOnline ? 'online' : 'offline', id]);

      await query(`
        INSERT INTO bot_logs (level, message, node_id, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [
        isOnline ? 'info' : 'error',
        isOnline ? 'เชื่อมต่อ VPS สำเร็จ' : 'เชื่อมต่อ VPS ไม่สำเร็จ',
        id
      ]).catch(() => {});

      return res.redirect('/admin/vps');
    }

    if (command === 'maintenance') {
      await query(`UPDATE vps_nodes SET status='maintenance', updated_at=NOW() WHERE id=$1`, [id]);
      return res.redirect('/admin/vps');
    }

    if (command === 'available' || command === 'online') {
      await query(`UPDATE vps_nodes SET status='online', updated_at=NOW() WHERE id=$1`, [id]);
      return res.redirect('/admin/vps');
    }

    if (command === 'offline') {
      await query(`UPDATE vps_nodes SET status='offline', updated_at=NOW() WHERE id=$1`, [id]);
      return res.redirect('/admin/vps');
    }

    await query(`
      INSERT INTO bot_logs (level, message, node_id, created_at)
      VALUES ('info', $1, $2, NOW())
    `, [`ส่งคำสั่ง ${command} ไปยัง VPS`, id]).catch(() => {});

    return res.redirect('/admin/vps');
  } catch (err) {
    console.error('VPS COMMAND ERROR:', err);
    return res.redirect('/admin/vps');
  }
});


router.post('/vps/:id/delete', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.redirect('/admin/vps');

  await query(
    `
    UPDATE vps_allocations
    SET status='deleted', is_active=FALSE, updated_at=NOW()
    WHERE node_id=$1
  `,
    [id]
  ).catch(() => {});

  await query(`DELETE FROM vps_nodes WHERE id = $1`, [id]);

  req.session.success = 'ลบ VPS เรียบร้อยแล้ว';
  return res.redirect('/admin/vps');
});


router.get('/vps/:id/ports/api/list', requireAdmin, async (req, res) => {
  try {
    await ensureVpsAllocationsAdminColumns();
    const nodeId = Number(req.params.id);
    await expireStaleLockedPorts(nodeId).catch(() => 0);
    await syncStaleAdminAllocations(nodeId).catch(() => 0);

    let ports = await query(`
      SELECT *, node_id AS vps_id
      FROM vps_allocations
      WHERE node_id=$1
      ORDER BY COALESCE(NULLIF(regexp_replace(port_number::text, '[^0-9]', '', 'g'), '')::int, id) ASC
    `, [nodeId]).catch(() => ({ rows: [] }));

    // fallback สำหรับระบบเก่าที่ใช้ตาราง vps_ports
    if (!ports.rows.length) {
      ports = await query(`
        SELECT *
        FROM vps_ports
        WHERE COALESCE(vps_id,node_id)=$1
        ORDER BY port_number ASC
      `, [nodeId]).catch(() => ({ rows: [] }));
    }

    const liveMap = await fetchLiveHealthMap(nodeId);
    const dbUsageMap = await fetchDbMt5UsageMap(nodeId);

    const rows = (ports.rows || []).map((p) => {
      const portNo = parsePortNumber(p);
      const live = lookupLiveHealth(liveMap, portNo);
      const dbUse = lookupDbUsage(dbUsageMap, portNo);
      const adminDisabled = isPortAdminDisabled(p);
      const portName = p.port_name || p.display_name || (`PORT-${String(portNo).padStart(2, '0')}`);
      const basePath =
        p.folder_path || p.base_path || live.folder_path || dbUse.folder_path || `C:\\MT5_PORTS\\${portName}`;

      const state = resolveAdminPortMt5State({
        live,
        dbUse,
        adminDisabled,
        allocationStatus: p.status
      });
      const inUse = state.inUse;
      const locked = state.locked;
      const orphanRunning = state.orphanRunning;
      const mt5Login = state.mt5Login || live?.mt5_login || dbUse?.mt5_login || p.mt5_login || null;
      const rowStatus = adminDisabled
        ? 'disabled'
        : inUse
          ? 'used'
          : locked
            ? 'locked'
            : orphanRunning
              ? 'orphan'
              : 'free';

      if (
        isAgentMt5Running(live) === false
        && !locked
        && (dbUse.running || ['locked', 'used', 'running', 'busy', 'full'].includes(String(p.status || '').toLowerCase()))
      ) {
        reconcilePortIdleWhenAgentFree(nodeId, portNo, basePath).catch(() => {});
      }

      return {
        ...p,
        vps_id: p.vps_id || p.node_id || nodeId,
        port_number: portNo,
        port_name: portName,
        display_name: p.display_name || portName,
        base_path: basePath,
        folder_path: p.folder_path || basePath,
        experts_path: p.experts_path || `${basePath}\\MQL5\\Experts`,
        is_active: !adminDisabled,
        admin_disabled: adminDisabled,
        is_used: inUse,
        is_locked: locked,
        orphan_running: orphanRunning,
        live_status: rowStatus,
        status: rowStatus,
        live_pid: live?.pid || live?.process_id || null,
        live_running: (inUse || orphanRunning) && !adminDisabled,
        usage_source: state.usageSource,
        mt5_login: mt5Login
      };
    });

    // ถ้ามีแถวใดแถวหนึ่งเป็น disabled = แสดงปิดการใช้งานค้างจนกว่า Admin จะกดเปิด
    const portAdminOff = new Map();
    for (const row of rows) {
      const key = Number(row.port_number || 0) || row.id;
      if (row.admin_disabled) portAdminOff.set(key, true);
      else if (!portAdminOff.has(key)) portAdminOff.set(key, false);
    }

    const dedupe = new Map();
    for (const row of rows) {
      const key = Number(row.port_number || 0) || row.id;
      const off = portAdminOff.get(key) === true;
      const rowStatus = off
        ? 'disabled'
        : row.is_used
          ? 'used'
          : row.is_locked
            ? 'locked'
            : row.orphan_running
              ? 'orphan'
              : 'free';
      const normalized = {
        ...row,
        admin_disabled: off,
        is_active: !off,
        is_used: off ? false : row.is_used,
        is_locked: off ? false : row.is_locked,
        orphan_running: off ? false : row.orphan_running,
        status: rowStatus,
        live_status: rowStatus,
        live_running: off ? false : row.live_running
      };
      const prev = dedupe.get(key);
      if (!prev) {
        dedupe.set(key, normalized);
        continue;
      }
      if (normalized.admin_disabled && !prev.admin_disabled) {
        dedupe.set(key, normalized);
      } else if (!normalized.admin_disabled && prev.admin_disabled) {
        /* keep disabled prev */
      } else if (normalized.is_used && !prev.is_used) {
        dedupe.set(key, normalized);
      } else if (Number(normalized.id || 0) > Number(prev.id || 0)) {
        dedupe.set(key, normalized);
      }
    }
    const cleanRows = Array.from(dedupe.values()).sort((a,b) => Number(a.port_number||0) - Number(b.port_number||0));

    const totalPorts = cleanRows.length;
    const activePorts = cleanRows.filter((p) => p.is_used === true && !p.admin_disabled).length;
    const lockedPorts = cleanRows.filter((p) => p.is_locked === true && !p.admin_disabled).length;
    const orphanPorts = cleanRows.filter((p) => p.orphan_running === true && !p.admin_disabled).length;
    const freePorts = cleanRows.filter(
      (p) => !p.admin_disabled && !p.is_used && !p.is_locked && !p.orphan_running
    ).length;

    res.json({
      ok: true,
      stats: {
        total_ports: totalPorts,
        active_ports: activePorts,
        locked_ports: lockedPorts,
        orphan_ports: orphanPorts,
        free_ports: freePorts
      },
      ports: cleanRows
    });
  } catch (err) {
    console.error('VPS PORT LIST ERROR:', err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

router.post('/vps/:id/ports/api/create', async (req, res) => {
  try {
    const nodeId = Number(req.params.id);
    const nodeRes = await query(`SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1`, [nodeId]);
    if (!nodeRes.rows.length) return res.status(404).json({ ok:false, error:'ไม่พบ VPS' });
    const node = nodeRes.rows[0];
    const maxPorts = Math.max(1, Number(node.max_ports || 20));

    const nextRes = await query(`
      SELECT COALESCE(MAX(COALESCE(NULLIF(regexp_replace(port_number::text, '[^0-9]', '', 'g'), '')::int, 0)),0)+1 AS next_no
      FROM vps_allocations
      WHERE node_id=$1
    `, [nodeId]);
    const nextNo = Number(nextRes.rows[0]?.next_no || 1);
    if (nextNo > maxPorts) return res.status(400).json({ ok:false, error:`PORT เต็มแล้ว สูงสุด ${maxPorts} PORT` });

    const nodeName = String(node.node_name || ('VPS-' + nodeId)).replace(/\s+/g,'-').toUpperCase();
    const portName = `${nodeName}-PORT-${String(nextNo).padStart(2,'0')}`;
    const basePath = `C:\\MT5_PORTS\\PORT${String(nextNo).padStart(2,'0')}`;

    const created = await query(`
      INSERT INTO vps_allocations (node_id, port_name, display_name, port_number, max_lot, status, base_path, experts_path, is_active, created_at, updated_at)
      VALUES ($1,$2,$2,$3,$4,'free',$5,$6,TRUE,NOW(),NOW())
      RETURNING *
    `, [nodeId, portName, String(nextNo), Number(req.body.max_lot || 1), basePath, `${basePath}\\MQL5\\Experts`]).catch(async () => {
      return query(`
        INSERT INTO vps_allocations (node_id, port_name, port_number, max_lot, status, created_at, updated_at)
        VALUES ($1,$2,$3,$4,'free',NOW(),NOW())
        RETURNING *
      `, [nodeId, portName, String(nextNo), Number(req.body.max_lot || 1)]);
    });

    return res.json({ ok:true, port: created.rows[0] });
  } catch (err) {
    console.error('VPS PORT CREATE API ERROR:', err);
    return res.status(500).json({ ok:false, error:err.message });
  }
});

function adminSystemPortNos(portNo) {
  const n = Number(portNo || 0);
  if (!n) return [];
  const systemNo = n >= 100 ? n : 100 + n;
  return [...new Set([n, systemNo].filter((x) => x > 0))];
}

async function adminStopPortRow(portRow, sourceTable, portDbId, options = {}) {
  const adminNodeId = Number(portRow.node_id || portRow.vps_id || 0);
  const portNo = parsePortNumber(portRow);
  const portName =
    portRow.port_name || portRow.display_name || `PORT-${String(portNo).padStart(2, '0')}`;
  const folderPath =
    portRow.folder_path || portRow.base_path || `C:\\MT5_PORTS\\${portName}`;
  const mt5Login = String(portRow.mt5_login || portRow.current_mt5_login || '').trim() || null;
  const { systemVpsId } = await resolveSystemVpsId(adminNodeId);
  const systemPortNos = adminSystemPortNos(portNo);
  const primarySystemPort = systemPortNos.find((n) => n >= 100) || portNo;
  const reason = String(options.reason || 'admin_port_stop');
  const nodeIds = [...new Set([adminNodeId, systemVpsId].filter((x) => x > 0))];
  const portNos = systemPortNos.length ? systemPortNos : [portNo];

  const boundAccs = await query(
    `
    SELECT DISTINCT
      a.id,
      a.user_id,
      a.port_slot,
      a.port_id,
      a.assigned_port_no,
      a.windows_port_no,
      a.mt5_login
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE LOWER(COALESCE(a.status, '')) IN ('ready', 'connected', 'checking', 'connecting', 'starting', 'failed')
      AND (
        (a.vps_id = ANY($1::bigint[]) AND COALESCE(a.assigned_port_no, a.windows_port_no) = ANY($2::int[]))
        OR (p.vps_id = ANY($1::bigint[]) AND p.port_no = ANY($2::int[]))
        OR ($3::text <> '' AND TRIM(COALESCE(p.folder_path, '')) = TRIM($3))
      )
  `,
    [nodeIds, portNos, folderPath || '']
  ).catch(() => ({ rows: [] }));

  for (const acc of boundAccs.rows || []) {
    await clearFolderPortBinding({
      userId: acc.user_id,
      accountId: acc.id,
      vpsId: systemVpsId,
      portId: acc.port_id,
      portSlot: acc.port_slot,
      assignedPortNo: acc.assigned_port_no,
      windowsPortNo: acc.windows_port_no,
      folderPath,
      mt5Login: acc.mt5_login,
      reason,
      forceRelease: true
    }).catch(() => {});
  }

  if (systemVpsId) {
    await clearFolderPortBinding({
      vpsId: systemVpsId,
      assignedPortNo: primarySystemPort,
      folderPath,
      mt5Login,
      reason,
      forceRelease: true
    }).catch(() => {});
    await queueForceStopMt5(systemVpsId, primarySystemPort, folderPath, reason).catch(() => false);
  }

  if (nodeIds.length && portNo) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='cancelled',
          vps_id=NULL,
          port_id=NULL,
          assigned_port_no=NULL,
          windows_port_no=NULL,
          last_error='Admin ปิด PORT',
          updated_at=NOW()
      WHERE vps_id = ANY($1::bigint[])
        AND COALESCE(assigned_port_no, windows_port_no) = ANY($2::int[])
        AND LOWER(COALESCE(status, '')) IN ('ready', 'connected', 'checking', 'connecting', 'starting', 'failed')
    `,
      [nodeIds, portNos]
    ).catch(() => {});

    if (folderPath) {
      await query(
        `
        UPDATE vps_system.mt5_accounts a
        SET status='cancelled',
            vps_id=NULL,
            port_id=NULL,
            assigned_port_no=NULL,
            windows_port_no=NULL,
            last_error='Admin ปิด PORT',
            updated_at=NOW()
        FROM vps_system.vps_ports p
        WHERE a.port_id = p.id
          AND TRIM(COALESCE(p.folder_path, '')) = TRIM($1)
          AND LOWER(COALESCE(a.status, '')) IN ('ready', 'connected', 'checking', 'connecting', 'starting', 'failed')
      `,
        [folderPath]
      ).catch(() => {});
    }
  }

  if (sourceTable === 'vps_allocations') {
    await query(`
      UPDATE vps_allocations
      SET status='free', user_id=NULL, mt5_status='stopped', is_active=TRUE, updated_at=NOW()
      WHERE id=$1
    `, [portDbId]).catch(() => {});
    if (adminNodeId && portNo) {
      await setAdminAllocationStatus(adminNodeId, portNo, 'free', portDbId);
    }
  } else {
    await query(`
      UPDATE vps_ports
      SET status='available', mt5_login=NULL, is_active=TRUE, updated_at=NOW()
      WHERE id=$1
    `, [portDbId]).catch(() => {});
  }
}

async function adminDisablePortRow(portRow, sourceTable, portDbId) {
  await adminStopPortRow(portRow, sourceTable, portDbId);

  const adminNodeId = Number(portRow.node_id || portRow.vps_id || 0);
  const portNo = parsePortNumber(portRow);
  const { systemVpsId } = await resolveSystemVpsId(adminNodeId);

  if (sourceTable === 'vps_allocations') {
    await setAdminAllocationStatus(adminNodeId, portNo, 'disabled', portDbId);
    if (adminNodeId && portNo) {
      await query(`
        UPDATE vps_allocations
        SET user_id=NULL, mt5_status='stopped', updated_at=NOW()
        WHERE node_id=$1 AND (${VPS_ALLOC_PORT_NO_SQL})=$2
      `, [adminNodeId, portNo]).catch(() => {});
    }
  } else {
    await query(`
      UPDATE vps_ports
      SET is_active=FALSE, status='disabled', mt5_login=NULL, updated_at=NOW()
      WHERE id=$1
    `, [portDbId]).catch(() => {});
  }

  if (systemVpsId && portNo) {
    await query(`
      UPDATE vps_system.vps_ports
      SET status='disabled', locked_by_user_id=NULL, locked_until=NULL, mt5_login=NULL,
          current_mt5_login=NULL, process_id=NULL, last_error='Admin ปิด PORT', updated_at=NOW()
      WHERE vps_id=$1 AND port_no=$2
    `, [systemVpsId, portNo]).catch(() => {});
  }

  return { enabled: false };
}

async function adminEnablePortRow(portRow, sourceTable, portDbId) {
  const adminNodeId = Number(portRow.node_id || portRow.vps_id || 0);
  const portNo = parsePortNumber(portRow);
  const { systemVpsId } = await resolveSystemVpsId(adminNodeId);

  if (sourceTable === 'vps_allocations') {
    await setAdminAllocationStatus(adminNodeId, portNo, 'free', portDbId);
    if (adminNodeId && portNo) {
      await query(`
        UPDATE vps_allocations
        SET user_id=NULL, mt5_status='stopped', last_error=NULL, updated_at=NOW()
        WHERE node_id=$1 AND (${VPS_ALLOC_PORT_NO_SQL})=$2
      `, [adminNodeId, portNo]).catch(() => {});
    }
  } else {
    await query(`
      UPDATE vps_ports
      SET is_active=TRUE, status='free', updated_at=NOW()
      WHERE id=$1
    `, [portDbId]).catch(() => {});
  }

  if (systemVpsId && portNo) {
    await query(`
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
      WHERE vps_id=$1 AND port_no=$2
    `, [systemVpsId, portNo]).catch(() => {});
  }

  return { enabled: true };
}

async function adminTogglePortRow(portRow, sourceTable, portDbId, forceAction) {
  const act = String(forceAction || '').trim().toLowerCase();
  if (act === 'enable') return adminEnablePortRow(portRow, sourceTable, portDbId);
  if (act === 'disable') return adminDisablePortRow(portRow, sourceTable, portDbId);
  if (isPortAdminDisabled(portRow)) return adminEnablePortRow(portRow, sourceTable, portDbId);
  return adminDisablePortRow(portRow, sourceTable, portDbId);
}

router.post('/vps/ports/api/stop/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    let portRes = await query(`SELECT *, node_id AS vps_id FROM vps_allocations WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
    let tableName = 'vps_allocations';
    if (!portRes.rows.length) {
      portRes = await query(`SELECT * FROM vps_ports WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
      tableName = 'vps_ports';
    }
    if (!portRes.rows.length) return res.status(404).json({ ok: false, error: 'PORT not found' });

    await adminStopPortRow(portRes.rows[0], tableName, id);
    return res.json({ ok: true, message: 'ส่งคำสั่งปิด MT5 และเคลียร์ PORT แล้ว' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/** ปิด-เปิด PORT (ปิด = ห้าม /app/mt5 เลือก + kill MT5 ถ้ามีการใช้งาน) */
router.post('/vps/ports/api/toggle/:id', async (req, res) => {
  try {
    await ensureVpsAllocationsAdminColumns();
    const id = Number(req.params.id);
    const forceAction = String(req.body?.action || req.query?.action || '').trim().toLowerCase();
    let portRes = await query(`SELECT *, node_id AS vps_id FROM vps_allocations WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
    let tableName = 'vps_allocations';
    if (!portRes.rows.length) {
      portRes = await query(`SELECT * FROM vps_ports WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
      tableName = 'vps_ports';
    }
    if (!portRes.rows.length) return res.status(404).json({ ok: false, error: 'PORT not found' });

    const result = await adminTogglePortRow(portRes.rows[0], tableName, id, forceAction);
    const msg = result.enabled
      ? 'เปิดใช้งาน PORT แล้ว — ผู้ใช้สามารถเลือกจาก /app/mt5 ได้'
      : 'ปิดใช้งาน PORT แล้ว — ส่งคำสั่งปิด MT5 และเคลียร์การใช้งานแล้ว';
    return res.json({
      ok: true,
      enabled: result.enabled,
      admin_disabled: !result.enabled,
      message: msg
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/vps/ports/api/delete/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);

    let portRes = await query(`SELECT *, node_id AS vps_id FROM vps_allocations WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
    let tableName = 'vps_allocations';
    if (!portRes.rows.length) {
      portRes = await query(`SELECT * FROM vps_ports WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] }));
      tableName = 'vps_ports';
    }
    if (!portRes.rows.length) return res.status(404).json({ ok:false, error:'PORT not found' });

    const portRow = portRes.rows[0];
    const nodeId = Number(portRow.node_id || portRow.vps_id || 0);

    if (nodeId) {
      await adminStopPortRow(portRow, tableName, id, { reason: 'admin_delete_port' });
    }

    let r;
    if (tableName === 'vps_allocations') {
      r = await query(`DELETE FROM vps_allocations WHERE id=$1 RETURNING *`, [id]).catch(() => ({ rows: [] }));
    } else {
      r = await query(`DELETE FROM vps_ports WHERE id=$1 RETURNING *`, [id]).catch(() => ({ rows: [] }));
    }
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'PORT not found' });
    return res.json({
      ok: true,
      message: 'ลบ PORT แล้ว — ส่งคำสั่งปิด MT5 และเคลียร์การจองโฟลเดอร์บน VPS แล้ว'
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:err.message });
  }
});

router.post('/vps/:id/ports/api/action', async (req, res) => {
  try {
    const nodeId = Number(req.params.id);
    const action = String(req.body.action || 'dashboard');
    await query(`
      INSERT INTO vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at)
      VALUES ($1,$1,$2,$3::jsonb,'pending',NOW())
    `, [nodeId, action, JSON.stringify(req.body || { action })]);
    return res.json({ ok:true });
  } catch (err) {
    return res.status(500).json({ ok:false, error:err.message });
  }
});

router.use(requireAdmin);

/* ================= VPS HISTORY / ERROR / ALARM ================= */
router.get('/vps/errors', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = 10;
    const offset = (page - 1) * limit;
    const statusFilter = String(req.query.status || 'all').toLowerCase();
    const nodeId = req.query.node_id ? Number(req.query.node_id) : 0;

    const levelExpr = "LOWER(COALESCE(NULLIF(vnl.event_level,''), NULLIF(vnl.level,''), 'normal'))";
    const where = [];
    const params = [];

    if (statusFilter !== 'all') {
      params.push(statusFilter);
      where.push(`${levelExpr} = $${params.length}`);
    }

    if (nodeId > 0) {
      params.push(nodeId);
      where.push(`vnl.node_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await query(`
      SELECT COUNT(*)::int AS total
      FROM vps_node_logs vnl
      ${whereSql}
    `, params);

    const summaryRes = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(NULLIF(event_level,''), NULLIF(level,''), 'normal')) = 'normal')::int AS normal_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(NULLIF(event_level,''), NULLIF(level,''), 'normal')) = 'alarm')::int AS alarm_count,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(NULLIF(event_level,''), NULLIF(level,''), 'normal')) = 'error')::int AS error_count
      FROM vps_node_logs
    `);

    const nodesRes = await query(`
      SELECT id, node_name, ip_address
      FROM vps_nodes
      ORDER BY id DESC
    `).catch(() => ({ rows: [] }));

    const logsRes = await query(`
      SELECT
        vnl.*,
        COALESCE(NULLIF(vnl.event_level,''), NULLIF(vnl.level,''), 'normal') AS event_level,
        vn.node_name,
        vn.ip_address
      FROM vps_node_logs vnl
      LEFT JOIN vps_nodes vn ON vn.id = vnl.node_id
      ${whereSql}
      ORDER BY vnl.created_at DESC NULLS LAST, vnl.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const totalRows = countRes.rows[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / limit));

    return res.render('admin/vps-errors', baseView(req, {
      pageTitle: 'VPS History / Error / Alarm',
      currentPath: '/admin/vps/errors',
      logs: logsRes.rows || [],
      nodes: nodesRes.rows || [],
      summary: summaryRes.rows[0] || {},
      filters: { status: statusFilter, node_id: nodeId },
      pagination: { page, limit, totalRows, totalPages }
    }));
  } catch (err) {
    console.error('ADMIN VPS HISTORY PAGE:', err);
    return res.status(500).send('VPS errors page error: ' + err.message);
  }
});

router.get('/vps/errors/export', async (req, res) => {
  try {
    const statusFilter = String(req.query.status || 'all').toLowerCase();
    const nodeId = req.query.node_id ? Number(req.query.node_id) : 0;
    const where = [];
    const params = [];

    if (statusFilter !== 'all') {
      params.push(statusFilter);
      where.push(`LOWER(vnl.event_level) = $${params.length}`);
    }

    if (nodeId > 0) {
      params.push(nodeId);
      where.push(`vnl.node_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const logsRes = await query(`
      SELECT
        vnl.created_at,
        COALESCE(vnl.event_level, 'normal') AS event_level,
        COALESCE(vnl.status, '-') AS status,
        COALESCE(vn.node_name, '-') AS node_name,
        COALESCE(vn.ip_address, '-') AS ip_address,
        COALESCE(vnl.computer_name, '-') AS computer_name,
        COALESCE(vnl.service_name, '-') AS service_name,
        COALESCE(vnl.cpu_percent::text, '0') AS cpu_percent,
        COALESCE(vnl.ram_percent::text, '0') AS ram_percent,
        COALESCE(vnl.ping_ms::text, '0') AS ping_ms,
        COALESCE(vnl.net_down_mbps::text, '0') AS net_down_mbps,
        COALESCE(vnl.net_up_mbps::text, '0') AS net_up_mbps,
        COALESCE(vnl.last_error, '') AS last_error
      FROM vps_node_logs vnl
      LEFT JOIN vps_nodes vn ON vn.id = vnl.node_id
      ${whereSql}
      ORDER BY vnl.created_at DESC NULLS LAST, vnl.id DESC
    `, params).catch(() => ({ rows: [] }));

    const rows = logsRes.rows || [];
    const header = ['วันที่', 'ประเภท', 'สถานะ', 'VPS', 'IP', 'Computer', 'Service', 'CPU%', 'RAM%', 'Ping ms', 'Down Mbps', 'Up Mbps', 'Error/Alarm'];

    const csv = [
      header.join(','),
      ...rows.map(r => [
        r.created_at ? new Date(r.created_at).toLocaleString('th-TH') : '-',
        r.event_level || '-',
        r.status || '-',
        r.node_name || '-',
        r.ip_address || '-',
        r.computer_name || '-',
        r.service_name || '-',
        r.cpu_percent || '0',
        r.ram_percent || '0',
        r.ping_ms || '0',
        r.net_down_mbps || '0',
        r.net_up_mbps || '0',
        String(r.last_error || '').replace(/"/g, '""')
      ].map(v => `"${v}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vps-history-error-alarm.csv"');
    return res.send('\ufeff' + csv);
  } catch (err) {
    console.error('EXPORT VPS HISTORY:', err);
    return res.status(500).send('Export error');
  }
});

/* ================= VPS PORT CREATE ================= */
router.get('/vps/ports/create', async (req, res) => {
  try {
    const nodeId = req.query.node_id || '';

    const nodesRes = await query(`
      SELECT id, node_name, ip_address, max_ports, used_ports, status
      FROM vps_nodes
      ORDER BY node_name ASC
    `);

    return res.render('admin/vps-port-form', baseView(req, {
      pageTitle: 'เพิ่ม Port',
      currentPath: '/admin/vps',
      mode: 'create',
      port: { node_id: nodeId },
      nodes: nodesRes.rows || []
    }));
  } catch (err) {
    console.error('VPS PORT CREATE PAGE ERROR:', err);
    return res.redirect('/admin/vps');
  }
});



router.post('/vps/ports/create', async (req, res) => {
  try {
    let { node_id, port_name, port_number, max_lot, status } = req.body;

    if (!node_id) {
      const firstNode = await query(`
        SELECT id FROM vps_nodes
        ORDER BY id ASC
        LIMIT 1
      `);

      if (!firstNode.rows.length) {
        return res.status(400).send('ยังไม่มี VPS กรุณาเพิ่ม VPS ก่อน');
      }

      node_id = firstNode.rows[0].id;
    }

    const nodeRes = await query(`
      SELECT *
      FROM vps_nodes
      WHERE id = $1
      LIMIT 1
    `, [node_id]);

    if (!nodeRes.rows.length) {
      return res.status(400).send('ไม่พบ VPS ที่เลือก');
    }

    const node = nodeRes.rows[0];

    if (Number(node.used_ports || 0) >= Number(node.max_ports || 0)) {
      return res.status(400).send('Port เต็มแล้ว ไม่สามารถเพิ่มได้');
    }

    const nextRes = await query(`
      SELECT COALESCE(MAX(NULLIF(regexp_replace(port_number::text, '[^0-9]', '', 'g'), '')::int), 30000) + 1 AS next_port
      FROM vps_allocations
      WHERE node_id = $1
    `, [node_id]).catch(() => ({ rows: [{ next_port: 30001 }] }));

    port_number = String(port_number || '').trim() || String(nextRes.rows[0]?.next_port || 30001);
    port_name = String(port_name || '').trim() || `MT5-PORT-${port_number}`;
    max_lot = Number(max_lot || 1.0);
    status = status || 'available';

    await query(`
      INSERT INTO vps_allocations (
        node_id,
        port_name,
        port_number,
        max_lot,
        status,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
    `, [
      node_id,
      port_name,
      port_number,
      max_lot,
      status
    ]);

    await query(`
      UPDATE vps_nodes
      SET used_ports = COALESCE(used_ports,0) + 1,
          updated_at = NOW()
      WHERE id = $1
    `, [node_id]).catch(() => {});

    return res.redirect(`/admin/vps/${node_id}/ports`);
  } catch (err) {
    console.error('VPS PORT CREATE ERROR:', err);
    return res.status(500).send('เพิ่ม Port ไม่สำเร็จ: ' + err.message);
  }
});



/* ================= VPS PORT EDIT ================= */
router.get('/vps/ports/:id/edit', async (req, res) => {
  try {
    const id = req.params.id;

    const portRes = await query(`
      SELECT *
      FROM vps_allocations
      WHERE id = $1
      LIMIT 1
    `, [id]);

    if (!portRes.rows.length) {
      return res.redirect('/admin/vps');
    }

    const nodesRes = await query(`
      SELECT id, node_name, ip_address
      FROM vps_nodes
      ORDER BY node_name ASC
    `);

    return res.render('admin/vps-port-form', baseView(req, {
      pageTitle: 'แก้ไข Port',
      currentPath: '/admin/vps',
      mode: 'edit',
      port: portRes.rows[0],
      nodes: nodesRes.rows || []
    }));
  } catch (err) {
    console.error('PORT EDIT PAGE ERROR:', err);
    return res.redirect('/admin/vps');
  }
});

router.post('/vps/ports/:id/update', async (req, res) => {
  try {
    const id = req.params.id;
    const {
      node_id,
      port_name,
      port_number,
      max_lot,
      status
    } = req.body;

    await query(`
      UPDATE vps_allocations
      SET node_id = $1,
          port_name = $2,
          port_number = $3,
          max_lot = $4,
          status = $5,
          updated_at = NOW()
      WHERE id = $6
    `, [
      node_id,
      port_name,
      port_number,
      Number(max_lot || 0),
      status,
      id
    ]);

    return res.redirect('/admin/vps/' + node_id + '/ports');
  } catch (err) {
    console.error('PORT UPDATE ERROR:', err);
    return res.status(500).send('แก้ไข Port ไม่สำเร็จ');
  }
});


router.post(['/api/vps-agent/port-health', '/port-health'], async (req, res) => {
  try {
    const body = req.body || {};
    const metrics = body.metrics || {};
    const ports = Array.isArray(body.ports) ? body.ports : [];

    const nodeRes = await query(`
      SELECT id FROM vps_nodes
      WHERE computer_name = $1 OR node_name = $1
      ORDER BY id ASC
      LIMIT 1
    `, [metrics.computer_name || '']);

    const nodeId = nodeRes.rows[0]?.id;
    if (!nodeId) return res.json({ ok:false, error:'node_not_found' });

    for (const p of ports) {
      const portNo = Number(p.portNumber || p.port_number || 0);
      const folderPath = String(p.folderPath || p.folder_path || '').trim();

      if (!portNo) continue;

      await query(`
        INSERT INTO vps_system.vps_port_health
          (node_id, port_number, folder_path, running, pid, updated_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,NOW())
        ON CONFLICT (node_id, port_number)
        DO UPDATE SET
          folder_path = EXCLUDED.folder_path,
          running = EXCLUDED.running,
          pid = EXCLUDED.pid,
          updated_at = NOW()
      `, [
        nodeId,
        portNo,
        folderPath,
        !!p.running,
        JSON.stringify(p.pid || [])
      ]);
    }

    return res.json({ ok:true, received: ports.length });
  } catch (err) {
    console.error('PORT HEALTH API ERROR:', err);
    return res.status(500).json({ ok:false, error:err.message });
  }
});

/* ================= VPS AGENT API ================= */
router.post('/api/vps-agent/heartbeat', async (req, res) => {
  try {
const API_TOKEN = 'avelqua-vps-2026';
if ((req.body?.token || '') !== API_TOKEN) {
  return res.status(401).json({ ok:false, error:'invalid token' });
}
    const {
      token,
      node_id,
      cpu_percent,
      ram_percent,
      net_down_mbps,
      net_up_mbps,
      ping_ms,
      status,
      last_error
    } = req.body || {};

    if (!node_id) {
      return res.status(400).json({ ok: false, error: 'missing node_id' });
    }

    await query(`
      UPDATE vps_nodes
      SET cpu_percent = $1,
          ram_percent = $2,
          net_down_mbps = $3,
          net_up_mbps = $4,
          ping_ms = $5,
          status = $6,
          last_error = $7,
          last_seen_at = NOW(),
          updated_at = NOW()
      WHERE id = $8
    `, [
      Number(cpu_percent || 0),
      Number(ram_percent || 0),
      Number(net_down_mbps || 0),
      Number(net_up_mbps || 0),
      Number(ping_ms || 0),
      status || 'online',
      last_error || null,
      node_id
    ]);

    return res.json({ ok: true });
  } catch (err) {
    console.error('VPS AGENT HEARTBEAT ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/vps-agent/commands/next', async (req, res) => {
  return res.json({ ok: true, command: null });
});

router.post('/api/vps-agent/commands/result', async (req, res) => {
  try {
const API_TOKEN = 'avelqua-vps-2026';
if ((req.body?.token || '') !== API_TOKEN) {
  return res.status(401).json({ ok:false, error:'invalid token' });
}
    const { node_id, command, result, error } = req.body || {};

    await query(`
      INSERT INTO bot_logs (level, message, node_id, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [
      error ? 'error' : 'info',
      `${command || 'command'}: ${error || result || 'done'}`,
      node_id || null
    ]).catch(() => {});

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});





// ========================= VPS AGENT TOKEN UPDATE =========================


// ========================= VPS REGENERATE TOKEN =========================


// ========================= VPS COMMAND =========================
router.post('/vps/nodes/:id/command', async (req, res) => {
  try {
    const command = req.body.command || '';

    await query(`
      INSERT INTO vps_agent_commands (node_id, command_type, payload, status, created_at)
      VALUES ($1,$2,$3,'pending',NOW())
    `, [
      req.params.id,
      command,
      JSON.stringify(req.body || {})
    ]);

    req.session.success = 'ส่งคำสั่งไปยัง VPS แล้ว';
    return res.redirect('back');
  } catch (err) {
    console.error('VPS COMMAND ERROR:', err);
    req.session.error = 'ส่งคำสั่งไม่สำเร็จ';
    return res.redirect('back');
  }
});


// ================= VPS UPDATE POWERSHELL TO WINDOWS AGENT =================







router.post('/vps/:id/update-powershell', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const psCode = String(req.body.powershell_code || '');
    console.log('[UPDATE POWERSHELL HIT]', id, 'LEN=', psCode.length, 'HAS15=', psCode.includes('MAX_LOG_DAYS = 15'));

    if (!psCode.trim()) {
      req.session.error = 'PowerShell ว่าง';
      return res.redirect('/admin/vps/' + id + '/edit');
    }

    await query(`
      UPDATE vps_nodes
      SET agent_powershell_code=$2,
          agent_powershell_updated_at=NOW(),
          updated_at=NOW()
      WHERE id=$1
    `, [id, psCode]);

    await query(`
      INSERT INTO vps_agent_commands
      (vps_id, node_id, command_type, payload, status, created_at)
      VALUES ($1,$1,'update_agent_script',$2::jsonb,'pending',NOW())
    `, [
      id,
      JSON.stringify({
        agent_path: 'C:\\avelqua-windows-agent\\agent.ps1',
        content: psCode
      })
    ]);

    req.session.success = 'บันทึก PowerShell แล้ว';
    if (req.headers.accept && req.headers.accept.includes('application/json')) return res.json({ ok:true });
    return res.redirect('/admin/vps/' + id + '/edit?updated_powershell=1');
  } catch (err) {
    console.error('UPDATE POWERSHELL ERROR:', err);
    req.session.error = err.message;
    if (req.headers.accept && req.headers.accept.includes('application/json')) return res.status(500).json({ ok:false, error:err.message });
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
});



/* ================= VPS TOKEN + PRO AGENT UPDATE ================= */
async function regenerateVpsAgentToken(req, res) {
  try {
    const crypto = require('crypto');
    const id = Number(req.params.id);
    const newToken = crypto.randomBytes(32).toString('hex');

    const oldRes = await query('SELECT agent_token FROM vps_nodes WHERE id=$1 LIMIT 1', [id]);
    const oldToken = oldRes.rows[0]?.agent_token || '';

    const hash = (v) => v ? crypto.createHash('sha256').update(String(v)).digest('hex') : '';

    await query(`
      UPDATE vps_nodes
      SET agent_token=$2,
          agent_token_updated_at=NOW(),
          updated_at=NOW()
      WHERE id=$1
    `, [id, newToken]);

    const { systemVpsId } = await resolveSystemVpsId(id);
    if (systemVpsId) {
      await query(`
        UPDATE vps_system.vps_nodes
        SET agent_token=$2, updated_at=NOW()
        WHERE id=$1
      `, [systemVpsId, newToken]).catch(() => {});
    }

    const admin = req.user || req.session.user || {};

    await query(`
      INSERT INTO vps_agent_token_logs (
        node_id, old_token_hash, new_token_hash,
        old_token_tail, new_token_tail,
        created_by_user_id, created_by_email,
        ip_address, user_agent, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    `, [
      id,
      hash(oldToken),
      hash(newToken),
      oldToken ? oldToken.slice(-8) : '',
      newToken.slice(-8),
      admin.id || null,
      admin.email || '',
      req.ip || '',
      req.headers['user-agent'] || ''
    ]);

    req.session.success = 'สร้าง Agent TOKEN ใหม่แล้ว และ revoke token เก่าเรียบร้อย';
    return res.redirect('/admin/vps/' + id + '/edit?token=updated');
  } catch (err) {
    console.error('REGENERATE VPS TOKEN ERROR:', err);
    req.session.error = 'สร้าง TOKEN ไม่สำเร็จ: ' + err.message;
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
}

router.post('/vps/:id/regenerate-token', regenerateVpsAgentToken);
router.post('/vps/:id/update-agent-token', regenerateVpsAgentToken);

router.post('/vps/:id/update-agent-file', async (req, res) => {
  try {
    const id = Number(req.params.id);

    await query(`
      INSERT INTO vps_agent_commands
      (vps_id, node_id, command_type, payload, status, created_at)
      VALUES ($1,$1,'update_agent_from_url',$2::jsonb,'pending',NOW())
    `, [
      id,
      JSON.stringify({
        url: 'https://trading.avelqua.com/agent/agent.ps1',
        agent_path: 'C:\\\\avelqua-windows-agent\\\\agent.ps1',
        service_name: 'AvelquaAgent'
      })
    ]);

    req.session.success = 'ส่งคำสั่งอัปเดต Agent จากไฟล์กลางไปยัง VPS แล้ว';
    return res.redirect('/admin/vps/' + id + '/edit?agent_update=sent');
  } catch (err) {
    console.error('UPDATE AGENT FILE ERROR:', err);
    req.session.error = err.message;
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
});

router.post('/vps/update-agent-all', async (req, res) => {
  try {
    const nodes = await query('SELECT id FROM vps_nodes ORDER BY id ASC');

    for (const n of nodes.rows) {
      await query(`
        INSERT INTO vps_agent_commands
        (vps_id, node_id, command_type, payload, status, created_at)
        VALUES ($1,$1,'update_agent_from_url',$2::jsonb,'pending',NOW())
      `, [
        n.id,
        JSON.stringify({
          url: 'https://trading.avelqua.com/agent/agent.ps1',
          agent_path: 'C:\\\\avelqua-windows-agent\\\\agent.ps1',
          service_name: 'AvelquaAgent'
        })
      ]);
    }

    req.session.success = 'ส่งคำสั่งอัปเดต Agent ไปทุก VPS แล้ว';
    return res.redirect('/admin/vps');
  } catch (err) {
    console.error('UPDATE ALL AGENT ERROR:', err);
    req.session.error = err.message;
    return res.redirect('/admin/vps');
  }
});



// ================= PORT DASHBOARD API =================
router.get('/vps/:id/ports/api/dashboard', async (req, res) => {
  const vpsId = req.params.id;

  try {
    const ports = await query(`
      SELECT *
      FROM vps_ports
      WHERE vps_id = $1
      ORDER BY port_number ASC
    `, [vpsId]);

    return res.json({
      ok: true,
      ports: ports.rows
    });
  } catch (err) {
    console.error('PORT DASHBOARD API ERROR:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});





async function getAdminPortById(portId) {
  let r = await query(`SELECT *, node_id AS vps_id FROM vps_allocations WHERE id=$1 LIMIT 1`, [portId]).catch(() => ({ rows: [] }));
  if (!r.rows.length) {
    r = await query(`SELECT * FROM vps_ports WHERE id=$1 LIMIT 1`, [portId]).catch(() => ({ rows: [] }));
  }
  return r.rows[0] || null;
}

function normalizeAdminPort(port) {
  const no = Number(String(port.port_number || port.port || port.port_name || '').replace(/[^0-9]/g, '') || 0);
  const portCode = 'PORT' + String(no || 1).padStart(2, '0');
  const base = port.base_path || port.folder_path || `C:\\MT5_PORTS\\${port.display_name || port.port_name || portCode}`;
  return {
    ...port,
    vps_id: port.vps_id || port.node_id,
    port_number: no,
    port_name: port.port_name || port.display_name || portCode,
    base_path: base,
    experts_path: port.experts_path || `${base}\\MQL5\\Experts`
  };
}

// ===== VPS PORT FILE MANAGER PAGE/API =====
router.get('/vps/:vpsId/ports/:portId/files', async (req,res)=>{
  const port = await getAdminPortById(req.params.portId);
  if (!port) return res.status(404).send('PORT not found');
  res.render('admin/vps-port-files', { port: normalizeAdminPort(port) });
});

router.get('/vps/ports/:portId/files/api/cache', async (req,res)=>{
  const r = await query('SELECT * FROM vps_port_file_cache WHERE port_id=$1 ORDER BY filename ASC',[req.params.portId]);
  res.json({ok:true, files:r.rows});
});

router.post('/vps/ports/:portId/files/api/path', async (req,res)=>{
  const experts = String(req.body.experts_path || '').trim();
  await query('UPDATE vps_allocations SET experts_path=$1 WHERE id=$2',[experts, req.params.portId]).catch(()=>{});
  await query('UPDATE vps_ports SET experts_path=$1 WHERE id=$2',[experts, req.params.portId]).catch(()=>{});
  res.json({ok:true});
});

router.post('/vps/ports/:portId/files/api/command', async (req,res)=>{
  const portRow = await getAdminPortById(req.params.portId);
  if (!portRow) return res.status(404).json({ok:false,error:'PORT not found'});

  const p = normalizeAdminPort(portRow);
  const ctype = String(req.body.command || '').trim();
  const cmd = await query(`
    INSERT INTO vps_agent_commands (vps_id, node_id, port_id, command_type, command, payload, status, lock_key, created_at)
    VALUES ($1,$1,$2,$3,$3,$4::jsonb,'pending',$5,NOW())
    RETURNING id
  `, [p.vps_id, p.id, ctype, JSON.stringify({
    port: p.port_number,
    filename:req.body.filename || '',
    file_path:req.body.filename || '',
    path:req.body.path || '',
    target:p.experts_path,
    folder_path:p.base_path,
    port_name:p.port_name,
    full_path: req.body.filename ? `${p.experts_path}\\${req.body.filename}` : p.base_path
  }), `PORT_${p.id}_FILE`]);

  res.json({ok:true, command_id: cmd.rows[0].id});
});

router.post('/vps/ports/:portId/files/api/write', async (req,res)=>{
  const portRow = await getAdminPortById(req.params.portId);
  if (!portRow) return res.status(404).json({ok:false,error:'PORT not found'});

  const p = normalizeAdminPort(portRow);
  const cmd = await query(`
    INSERT INTO vps_agent_commands (vps_id, node_id, port_id, command_type, command, payload, status, lock_key, created_at)
    VALUES ($1,$1,$2,'port_write_file','port_write_file',$3::jsonb,'pending',$4,NOW())
    RETURNING id
  `, [p.vps_id, p.id, JSON.stringify({
    port: p.port_number,
    filename:req.body.filename,
    file_path:req.body.filename,
    content:req.body.content,
    target:p.experts_path,
    port_name:p.port_name,
    full_path: `${p.experts_path}\\${req.body.filename}`
  }), `PORT_${p.id}_FILE`]);

  res.json({ok:true, command_id: cmd.rows[0].id});
});


module.exports = router;

/* ================= PRO AGENT UPDATE ================= */





// ===== VPS PORT CRUD =====
async function getVpsName(vpsId) {
  const tables = ['vps_nodes', 'vps_servers', 'vps'];
  const cols = ['name', 'vps_name', 'server_name', 'title'];

  for (const t of tables) {
    for (const c of cols) {
      try {
        const r = await query(`SELECT ${c} AS name FROM ${t} WHERE id=$1 LIMIT 1`, [vpsId]);
        if (r.rows && r.rows[0] && r.rows[0].name) return String(r.rows[0].name);
      } catch (_) {}
    }
  }
  return 'VPS-' + vpsId;
}

// ===== VPS PORT UPDATE =====
router.post('/vps/ports/api/update/:id', async (req, res) => {
  try {
    const portNumber = Number(req.body.port_number);
    if (!portNumber || portNumber < 1 || portNumber > 20) {
      return res.status(400).json({ ok:false, error:'PORT ต้องเป็น 1-20' });
    }

    const portName = 'PORT' + String(portNumber).padStart(2,'0');
    const basePath = `C:\\MT5_PORTS\\${portName}`;
    const expertsPath = `${basePath}\\MQL5\\Experts`;

    await query(`
      UPDATE vps_ports
      SET port_number=$1, port_name=$2, base_path=$3, experts_path=$4
      WHERE id=$5
    `, [portNumber, portName, basePath, expertsPath, req.params.id]);

    res.json({ ok:true });
  } catch (err) {
    console.error('VPS PORT UPDATE ERROR:', err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

// ===== SEND FILE TO WINDOWS =====
router.post('/vps/ports/:id/files/api/upload', upload.single('file'), async (req,res)=>{
  try {
    const portId = req.params.id;
    const portRow = await getAdminPortById(portId);
    if (!portRow) return res.status(404).json({ ok:false, error:'port not found' });
    if (!req.file) return res.status(400).json({ ok:false, error:'file required' });

    const port = normalizeAdminPort(portRow);
    const filename = req.file.originalname;
    const contentB64 = fs.readFileSync(req.file.path).toString('base64');
    fs.unlink(req.file.path, () => {});

    const cmd = await query(`
      INSERT INTO vps_agent_commands (vps_id, node_id, port_id, command_type, command, payload, status, lock_key, created_at)
      VALUES ($1,$1,$2,'port_upload_file','port_upload_file',$3::jsonb,'pending',$4,NOW())
      RETURNING id
    `, [
      port.vps_id,
      portId,
      JSON.stringify({
        port: port.port_number,
        filename,
        content_b64: contentB64,
        target: port.experts_path,
        port_name: port.port_name,
        full_path: `${port.experts_path}\\${filename}`
      }),
      `PORT_${portId}_FILE`
    ]);

    res.json({ ok:true, command_id: cmd.rows[0].id });
  } catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

// ===== AGENT GET COMMAND =====
router.get('/agent/:vps_id/next', async (req,res)=>{
  const vpsId = req.params.vps_id;

  const r = await query(`
    SELECT * FROM vps_agent_commands
    WHERE vps_id=$1 AND status='pending'
    ORDER BY id ASC LIMIT 1
  `,[vpsId]);

  if (!r.rows.length) return res.json({});

  const cmd = r.rows[0];

  await query('UPDATE vps_agent_commands SET status=$1 WHERE id=$2',['processing',cmd.id]);

  res.json(cmd);
});

// ===== AGENT DONE =====
router.post('/agent/done/:id', async (req,res)=>{
  await query('UPDATE vps_agent_commands SET status=$1 WHERE id=$2',['done',req.params.id]);
  res.json({ok:true});
});

// ===== PAGE FILE MANAGER =====
router.get('/vps/:vpsId/ports/:portId/files', async (req,res)=>{
  const rawPort = await getAdminPortById(req.params.portId);
  if (!rawPort) return res.status(404).send('PORT not found');
  res.render('admin/vps-port-files', { port: normalizeAdminPort(rawPort) });
});

// ===== CONNECT WINDOWS PORT FOLDER =====
router.post('/vps/ports/:portId/files/api/connect-folder', async (req, res) => {
  try {
    const rawPort = await getAdminPortById(req.params.portId);
    if (!rawPort) return res.status(404).json({ ok:false, error:'PORT not found' });

    const port = normalizeAdminPort(rawPort);
    const folder = port.experts_path || (`C:\\MT5_PORTS\\${port.port_name}\\MQL5\\Experts`);

    await query(`
      INSERT INTO vps_agent_commands
        (vps_id, port_id, command_type, payload, status)
      VALUES
        ($1,$2,'list_files',$3,'pending')
    `, [
      port.vps_id,
      port.id,
      JSON.stringify({ folder_path: folder })
    ]);

    res.json({ ok:true, message:'ส่งคำสั่งเชื่อมโฟลเดอร์ไป Windows Agent แล้ว' });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

router.get('/vps/ports/:portId/files/api/windows-files', async (req, res) => {
  try {
    const r = await query(`
      SELECT result, error, status, updated_at
      FROM vps_agent_commands
      WHERE port_id=$1
        AND command_type='list_files'
      ORDER BY id DESC
      LIMIT 1
    `, [req.params.portId]);

    if (!r.rows.length) return res.json({ ok:true, files:[], status:'no_data' });

    const row = r.rows[0];
    let files = [];

if (row.result) {
  if (Array.isArray(row.result)) {
    files = row.result;
  } else if (Array.isArray(row.result.files)) {
    files = row.result.files;
  } else if (Array.isArray(row.result.items)) {
    files = row.result.items;
  } else if (Array.isArray(row.result.data)) {
    files = row.result.data;
  } else if (row.result.result && Array.isArray(row.result.result.files)) {
    files = row.result.result.files;
  }
}

// normalize ให้หน้าเว็บใช้ได้ทุก format จาก Windows Agent
files = files.map(f => {
  if (typeof f === 'string') {
    const parts = f.split(/[\\\\/]/);
    return {
      filename: parts[parts.length - 1],
      full_path: f,
      type: 'file'
    };
  }

  const fullPath =
    f.full_path ||
    f.FullName ||
    f.fullname ||
    f.path ||
    f.Path ||
    f.file_path ||
    f.FilePath ||
    '';

  const filename =
    f.filename ||
    f.name ||
    f.Name ||
    f.file ||
    f.File ||
    (fullPath ? String(fullPath).split(/[\\\\/]/).pop() : 'unknown');

  return {
    filename,
    full_path: fullPath,
    type: f.type || f.Type || f.mode || '',
    size_bytes: f.size_bytes || f.Length || f.length || 0,
    updated_at: f.updated_at || f.LastWriteTime || f.lastWriteTime || ''
  };
});


    res.json({
      ok:true,
      status: row.status,
      error: row.error,
      updated_at: row.updated_at,
      files
    });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

// ===== PORT FILE EDITOR + LOCK MT5 =====
router.post('/vps/ports/:portId/files/api/read-file', async (req, res) => {
  try {
    const portRow = await getAdminPortById(req.params.portId);
    if (!portRow) return res.status(404).json({ ok:false, error:'PORT not found' });

    const p = normalizeAdminPort(portRow);
    const filename = String(req.body.filename || '').trim();
    if (!filename) return res.status(400).json({ ok:false, error:'filename required' });

    const cmd = await query(`
      INSERT INTO vps_agent_commands
        (vps_id, port_id, command_type, command, payload, status, lock_key)
      VALUES
        ($1,$2,'port_read_file','port_read_file',$3,'pending',$4)
      RETURNING id
    `, [
      p.vps_id,
      p.id,
      JSON.stringify({
        filename,
        target: p.experts_path,
        port_name: p.port_name,
        full_path: `${p.experts_path}\\${filename}`
      }),
      `PORT_${p.id}_FILE`
    ]);

    res.json({ ok:true, command_id: cmd.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

router.get('/vps/ports/files/api/command/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT id,status,result,error,updated_at
      FROM vps_agent_commands
      WHERE id=$1
    `, [req.params.id]);

    if (!r.rows.length) return res.status(404).json({ ok:false, error:'command not found' });
    res.json({ ok:true, command:r.rows[0] });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

router.post('/vps/ports/:portId/files/api/save-file', async (req, res) => {
  try {
    const portRow = await getAdminPortById(req.params.portId);
    if (!portRow) return res.status(404).json({ ok:false, error:'PORT not found' });

    const p = normalizeAdminPort(portRow);
    const filename = String(req.body.filename || '').trim();
    const content = String(req.body.content || '');

    if (!filename) return res.status(400).json({ ok:false, error:'filename required' });

    const cmd = await query(`
      INSERT INTO vps_agent_commands
        (vps_id, port_id, command_type, command, payload, status, lock_key)
      VALUES
        ($1,$2,'port_write_file','port_write_file',$3::jsonb,'pending',$4)
      RETURNING id
    `, [
      p.vps_id,
      p.id,
      JSON.stringify({
        port: p.port_number,
        filename,
        file_path: filename,
        content,
        target: p.experts_path,
        port_name: p.port_name,
        full_path: `${p.experts_path}\\${filename}`
      }),
      `PORT_${p.id}_FILE`
    ]);

    res.json({ ok:true, command_id: cmd.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

router.post('/vps/ports/:portId/files/api/lock-mt5', async (req, res) => {
  try {
    const portRow = await getAdminPortById(req.params.portId);
    if (!portRow) return res.status(404).json({ ok:false, error:'PORT not found' });

    const p = normalizeAdminPort(portRow);

    const cmd = await query(`
      INSERT INTO vps_agent_commands
        (vps_id, port_id, command_type, command, payload, status, lock_key)
      VALUES
        ($1,$2,'port_lock_mt5','port_lock_mt5',$3,'pending',$4)
      RETURNING id
    `, [
      p.vps_id,
      p.id,
      JSON.stringify({
        port_name: p.port_name,
        base_path: p.base_path,
        experts_path: p.experts_path
      }),
      `MT5_PORT_${p.id}`
    ]);

    res.json({ ok:true, command_id: cmd.rows[0].id });
  } catch (err) {
    res.status(500).json({ ok:false, error:err.message });
  }
});

// ===== VPS DASHBOARD SUMMARY =====
router.get('/vps/api/summary', async (req, res) => {
  try {
    const vps = await query(`
      SELECT 
        COUNT(*)::int AS total_vps,
        COUNT(*) FILTER (WHERE COALESCE(status,'') ILIKE '%online%')::int AS online_vps
      FROM vps_nodes
    `);

    const ports = await query(`
      SELECT 
        COUNT(*)::int AS total_ports,
        COUNT(*) FILTER (WHERE COALESCE(is_active,true)=true)::int AS active_ports
      FROM vps_ports
    `);

    let errors = { rows:[{ error_count:0 }] };
    try {
      errors = await query(`
        SELECT COUNT(*)::int AS error_count
        FROM vps_agent_logs
        WHERE created_at > NOW() - INTERVAL '24 hours'
          AND (
            COALESCE(level,'') ILIKE '%error%'
            OR COALESCE(level,'') ILIKE '%alarm%'
            OR COALESCE(message,'') ILIKE '%error%'
            OR COALESCE(message,'') ILIKE '%alarm%'
          )
      `);
    } catch (_) {}

    res.json({
      ok: true,
      total_vps: vps.rows[0]?.total_vps || 0,
      online_vps: vps.rows[0]?.online_vps || 0,
      total_ports: ports.rows[0]?.total_ports || 0,
      active_ports: ports.rows[0]?.active_ports || 0,
      active_lot: 0,
      max_lot: 40,
      error_alarm: errors.rows[0]?.error_count || 0
    });
  } catch (err) {
    console.error('VPS SUMMARY ERROR:', err);
    res.status(500).json({ ok:false, error:err.message });
  }
});

// ===== VPS DASHBOARD SUMMARY =====
router.get('/vps/api/summary', async (req, res) => {
  try {
    const vps = await query(`
      SELECT 
        COUNT(*)::int AS total_vps,
        COUNT(*) FILTER (WHERE COALESCE(status,'') ILIKE '%online%')::int AS online_vps
      FROM vps_nodes
    `);

    const ports = await query(`
      SELECT 
        COUNT(*)::int AS total_ports,
        COUNT(*) FILTER (WHERE COALESCE(is_active,true)=true)::int AS active_ports
      FROM vps_ports
    `);

    res.json({
      ok: true,
      total_vps: vps.rows[0]?.total_vps || 0,
      online_vps: vps.rows[0]?.online_vps || 0,
      total_ports: ports.rows[0]?.total_ports || 0,
      active_ports: ports.rows[0]?.active_ports || 0,
      active_lot: 0,
      max_lot: 40,
      error_alarm: 0
    });
  } catch (err) {
    console.error('VPS SUMMARY ERROR:', err);
    res.status(500).json({ ok:false, error:err.message });
  }
});
