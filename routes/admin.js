const express = require('express');
const { randomUUID } = require('crypto');
const { query, getClient } = require('../config/database');
const requireAdmin = require('../middleware/admin');
const XLSX = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const upload = multer({ dest: '/tmp' });


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
  parsePortNumber
} = require('../lib/adminVpsBridge');

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
  distributeScoinEconomy
} = require('../services/scoinService');

const { syncNewsNow } = require('../services/newsSyncService');

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

router.get('/', async (req, res) => {
  try {
    const [summary, recentPaymentsRes, expiringRes, deploymentsRes, revenueDaily] = await Promise.all([
      getAdminSummary(),
      query(`
        SELECT
          payer_name,
          payer_email,
          package_name_snapshot,
          final_amount,
          payment_status,
          payment_method,
          created_at
        FROM payments
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
          COALESCE(SUM(final_amount),0)::numeric AS total
        FROM payments
        WHERE COALESCE(paid_at, created_at) >= NOW() - INTERVAL '14 day'
        GROUP BY 1
        ORDER BY 1 ASC
      `)
    ]);

    return res.render('admin/dashboard', baseView(req, {
      pageTitle: 'Admin Dashboard',
      currentPath: '/admin',
      summary,
      recentPayments: recentPaymentsRes.rows,
      expiringSubscriptions: expiringRes.rows,
      recentDeployments: deploymentsRes.rows,
      revenueDaily: revenueDaily.rows
    }));
  } catch (error) {
    console.error(error);
    return res.status(500).send(error.message || 'Admin dashboard error');
  }
});

router.get('/users', async (req, res) => {
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

    const sql = `
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
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY u.created_at DESC
      LIMIT 500
    `;

    const [result, counts] = await Promise.all([
      query(sql, params),
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active,
          COUNT(*) FILTER (WHERE status = 'banned')::int AS banned,
          COUNT(*) FILTER (WHERE COALESCE(identity_verified, FALSE) = TRUE)::int AS identity_verified
        FROM users
      `)
    ]);

    return res.render('admin/users', baseView(req, {
  pageTitle: 'Users',
  currentPath: '/admin/users',
  users: result.rows,
  bankAccounts: result.rows,
  filters: { q, status, role, identity },
  counts: counts.rows[0] || {
    total: 0,
    active: 0,
    banned: 0,
    identity_verified: 0
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
        COALESCE(psr.customer_reward_percent, 80) AS customer_reward_percent,
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
        COALESCE(psr.reward_scoin, ROUND((COALESCE(p.price,0) * COALESCE(psr.customer_reward_percent,80) / 100)::numeric, 4)) AS customer_reward_scoin,
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
  const customerPercent = Number(req.body.customer_reward_percent || 80);
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
  const customerPercent = Number(req.body.customer_reward_percent || 80);
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
    await query(`
      UPDATE payments
      SET payment_status='cancelled',
          updated_at=NOW()
      WHERE payment_status IN ('pending','waiting','unpaid')
      AND created_at < NOW() - INTERVAL '20 minutes'
    `);

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
    console.error('autoCancelExpiredPayments:', e.message);
  }
}

router.get('/payments', async (req, res) => {
  try {
await autoCancelExpiredPayments();
    const q = String(req.query.q || '').trim();
const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
const limit = 10;
const offset = (page - 1) * limit;

const params = [];
let where = '';

    if (q) {
      params.push(`%${q}%`);
      where = `WHERE
        COALESCE(p.payer_name,'') ILIKE $1
        OR COALESCE(u.full_name,'') ILIKE $1
        OR COALESCE(p.package_name_snapshot,'') ILIKE $1
        OR CAST(p.final_amount AS TEXT) ILIKE $1
        OR COALESCE(p.payment_status,'') ILIKE $1
        OR COALESCE(p.payment_method,'') ILIKE $1
        OR COALESCE(p.payer_email,'') ILIKE $1
        OR COALESCE(p.display_id,'') ILIKE $1
      `;
    }

    const [result, counts, scoinSellOrdersRes] = await Promise.all([
      query(
        `SELECT
          p.*,
          u.full_name,
          u.email
         FROM payments p
         LEFT JOIN users u ON u.id = p.user_id
         ${where}
         ORDER BY COALESCE(p.paid_at, p.created_at) DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
          COALESCE(SUM(final_amount) FILTER (WHERE payment_status = 'paid'),0)::numeric AS revenue
        FROM payments
      `),
      query(`
  SELECT
    o.*,
    u.email,
    COALESCE(NULLIF(u.full_name, ''), u.email) AS full_name,
    ba.bank_name,
    ba.account_name,
    ba.account_number_masked
  FROM scoin_market_orders o
  LEFT JOIN users u ON u.id = o.user_id
  LEFT JOIN user_bank_accounts ba ON ba.id = o.bank_account_id
  WHERE o.order_type = 'sell'
  ORDER BY o.created_at DESC
  LIMIT 10
`).catch(() => ({ rows: [] }))
    ]);

    return res.render('admin/payments', baseView(req, {
      pageTitle: 'Payments',
      currentPath: '/admin/payments',
      payments: result.rows,
      filters: { q },
      counts: counts.rows[0] || { total: 0, paid: 0, revenue: 0 },
      scoinSellOrders: scoinSellOrdersRes?.rows || [],
page,
totalPages: Math.max(Math.ceil(Number(counts.rows[0]?.total || 0) / limit), 1),
totalRows: Number(counts.rows[0]?.total || 0)
    }));
  } catch (error) {
    console.error('payments page error:', error);
    req.session.error = error.message || 'โหลดรายการชำระเงินไม่สำเร็จ';
    return res.redirect('/admin');
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
           paid_at = NOW(),
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
    const pkg = pkgRes.rows[0];

    const subRes = await client.query(
      `SELECT * FROM user_subscriptions
       WHERE user_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [paymentRow.user_id]
    );

    const oldSub = subRes.rows[0];
    const now = new Date();

    let startDate = now;
    let endDate = new Date();

    if (oldSub && oldSub.end_at && new Date(oldSub.end_at) > now) {
      startDate = new Date(oldSub.start_at || now);
      endDate = new Date(oldSub.end_at);
    }

    endDate.setDate(endDate.getDate() + Number(pkg.days || 0));

    if (oldSub) {
      await client.query(
        `UPDATE user_subscriptions
         SET package_id=$1,
             package_name_snapshot=$2,
             start_at=$3,
             end_at=$4,
             updated_at=NOW()
         WHERE id=$5`,
        [
          pkg.id,
          pkg.name_th || pkg.name_en || pkg.name,
          startDate,
          endDate,
          oldSub.id
        ]
      );
    } else {
      await client.query(
        `INSERT INTO user_subscriptions
         (
           user_id,
           package_id,
           package_name_snapshot,
           start_at,
           end_at,
           created_at,
           updated_at
         )
         VALUES ($1,$2,$3,$4,$5,NOW(),NOW())`,
        [
          paymentRow.user_id,
          pkg.id,
          pkg.name_th || pkg.name_en || pkg.name,
          startDate,
          endDate
        ]
      );
    }
  }
}

    await client.query('COMMIT');

    await distributeScoinEconomy({
      userId: paymentRow.user_id,
      paymentId: paymentRow.id,
      packageId: paymentRow.package_id,
      amountThb: Number(paymentRow.final_amount || paymentRow.amount || 0)
    });

    req.session.success = 'อนุมัติการชำระเงินสำเร็จแล้ว';
    return res.redirect('/admin/payments');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('approve payment error:', error);
    req.session.error = error.message || 'อนุมัติการชำระเงินไม่สำเร็จ';
    return res.redirect('/admin/payments');
  } finally {
    client.release();
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

router.get('/coupons', async (req, res) => {
  const [couponsRes, usageRes, latestCouponUsagesRes] = await Promise.all([
    query(`SELECT * FROM coupons ORDER BY created_at DESC LIMIT 300`),
    query(`
      SELECT
        cu.*,
        c.coupon_code,
        c.coupon_name,
        u.full_name
      FROM coupon_usages cu
      LEFT JOIN coupons c ON c.id = cu.coupon_id
      LEFT JOIN users u ON u.id = cu.user_id
      ORDER BY cu.used_at DESC
      LIMIT 100
    `),
    query(`
      SELECT
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
      ORDER BY cu.used_at DESC
      LIMIT 30
    `).catch(() => ({ rows: [] }))
  ]);

  return res.render('admin/coupons', baseView(req, {
    pageTitle: 'Coupons',
    currentPath: '/admin/coupons',
    coupons: couponsRes.rows,
    usages: usageRes.rows,
    latestCouponUsages: latestCouponUsagesRes.rows
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

    return res.render('admin/vps-node-form', baseView(req, {
      pageTitle: 'แก้ไข Windows VPS',
      currentPath: '/admin/vps',
      mode: 'edit',
      node: nodeRes.rows[0],
      agentTemplate,
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



router.post('/vps/:id/delete', async (req, res) => {
  await query(`DELETE FROM vps_nodes WHERE id = $1`, [req.params.id]);
  req.session.success = 'ลบ VPS node แล้ว';
  return res.redirect('/admin/vps');
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
    const [
  settingsRes,
  realtimeChartRes,
  hostWalletRes,
  economySettingsRes,
  treasuryRes,
  economyLogsRes,
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
         updated_at = NOW()
       WHERE id = 1`,
      [
        mergedMarket.current_price_thb,
        mergedMarket.transfer_fee_percent,
        mergedMarket.buy_fee_percent,
        mergedMarket.sell_fee_percent,
        mergedMarket.market_supply,
        mergedMarket.auto_price_enabled
      ]
    );

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

    const before = Number(user.scoin_balance || 0);
    const scoinAmount = Number(order.scoin_amount || 0);

    if (String(order.order_type) === 'buy') {
      const after = before + scoinAmount;

      await client.query(
        `UPDATE users SET scoin_balance = $2 WHERE id = $1`,
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
            gross_amount_thb: order.gross_amount_thb,
            fee_amount_thb: order.fee_amount_thb,
            net_amount_thb: order.net_amount_thb
          })
        ]
      );
    } else if (String(order.order_type) === 'sell') {
      if (before < scoinAmount) {
        throw new Error('ยอด Scoin ของผู้ใช้ไม่พอสำหรับขายคืนโฮส');
      }

      const after = before - scoinAmount;

      await client.query(
        `UPDATE users SET scoin_balance = $2 WHERE id = $1`,
        [user.id, after]
      );

      await client.query(
        `INSERT INTO scoin_transactions (
          user_id, tx_type, direction, amount, fee_amount,
          balance_before, balance_after, meta_json, created_at
        )
        VALUES ($1, 'market_sell', 'out', $2, 0, $3, $4, $5::jsonb, NOW())`,
        [
          user.id,
          scoinAmount,
          before,
          after,
          JSON.stringify({
            market_order_id: order.id,
            order_type: order.order_type,
            gross_amount_thb: order.gross_amount_thb,
            fee_amount_thb: order.fee_amount_thb,
            net_amount_thb: order.net_amount_thb
          })
        ]
      );

      await client.query(
        `INSERT INTO system_wallets (wallet_type, wallet_code, balance)
         VALUES ('host_scoin', 'HOST-SCOIN-WALLET', 0)
         ON CONFLICT (wallet_type)
         DO UPDATE SET updated_at = NOW()`
      );

      await client.query(
        `UPDATE system_wallets
         SET balance = COALESCE(balance,0) + $1,
             updated_at = NOW()
         WHERE wallet_type = 'host_scoin'`,
        [scoinAmount]
      );

await client.query(
  `UPDATE system_wallets
   SET thb_balance = COALESCE(thb_balance,0) + $1,
       updated_at = NOW()
   WHERE wallet_type = 'host_scoin'`,
  [Number(order.fee_amount_thb || 0)]
);

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
    return res.redirect('/admin/scoin-market');
  } catch (error) {
    console.error('confirm transfer error:', error);
    req.session.error = 'ยืนยันการโอนไม่สำเร็จ';
    return res.redirect('/admin/scoin-market');
  }
});

router.post('/scoin-market/:id/reject', async (req, res) => {
  try {
    const result = await query(
      `UPDATE scoin_market_orders
       SET status = 'rejected',
           updated_at = NOW()
       WHERE id = $1
         AND status = 'pending'
       RETURNING id`,
      [req.params.id]
    );

    if (!result.rows.length) {
      req.session.error = 'ไม่พบคำสั่ง pending ที่ต้องการปฏิเสธ';
      return res.redirect('/admin/scoin-market');
    }

    req.session.success = 'ปฏิเสธคำสั่งตลาด Scoin แล้ว';
    return res.redirect('/admin/scoin-market');
  } catch (error) {
    console.error('reject scoin market error:', error);
    req.session.error = 'ปฏิเสธคำสั่งไม่สำเร็จ';
    return res.redirect('/admin/scoin-market');
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


router.post('/vps/:id/delete', async (req, res) => {
  const id = req.params.id;

  await query(`DELETE FROM vps_nodes WHERE id = $1`, [id]);

  return res.redirect('/admin/vps');
});


router.get('/vps/:id/ports/api/list', async (req, res) => {
  try {
    await ensureVpsAllocationsAdminColumns();
    const nodeId = Number(req.params.id);

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
    const { isAgentMt5Running, reconcilePortIdleWhenAgentFree } = require('../lib/adminVpsBridge');

    const rows = (ports.rows || []).map((p) => {
      const portNo = parsePortNumber(p);
      const live = liveMap[portNo] || {};
      const dbUse = dbUsageMap[portNo] || {};
      const agentState = isAgentMt5Running(live);
      const agentRunning = agentState === true;
      const dbRunning = dbUse.running === true;
      const adminDisabled = isPortAdminDisabled(p);
      const dbSt = String(p.status || '').trim().toLowerCase();
      const dbBusy = ['locked', 'used', 'running', 'busy', 'full'].includes(dbSt);
      const portName = p.port_name || p.display_name || (`PORT-${String(portNo).padStart(2, '0')}`);
      const basePath =
        p.folder_path || p.base_path || live.folder_path || dbUse.folder_path || `C:\\MT5_PORTS\\${portName}`;
      if (agentState === false && (dbRunning || dbBusy)) {
        reconcilePortIdleWhenAgentFree(nodeId, portNo, basePath).catch(() => {});
      }
      // แสดง "ใช้งาน" เฉพาะเมื่อ Agent ยืนยันว่า terminal64 รันจริง — ไม่พึ่งสถานะ DB ค้าง
      const inUse = !adminDisabled && agentRunning === true;
      const mt5Login = agentRunning
        ? live?.mt5_login || dbUse?.mt5_login || p.mt5_login || null
        : null;
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
        live_status: adminDisabled ? 'disabled' : inUse ? 'used' : 'free',
        status: adminDisabled ? 'disabled' : inUse ? 'used' : 'free',
        live_pid: live?.pid || live?.process_id || null,
        live_running: inUse && !adminDisabled,
        usage_source: agentState === false ? 'free' : agentRunning ? 'agent' : dbRunning ? dbUse.source || 'db' : dbBusy ? 'allocation' : 'free',
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
      const normalized = {
        ...row,
        admin_disabled: off,
        is_active: !off,
        status: off ? 'disabled' : row.live_running ? 'used' : 'free',
        live_status: off ? 'disabled' : row.live_running ? 'used' : 'free',
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
    const activePorts = cleanRows.filter((p) => p.live_running === true && !p.admin_disabled).length;

    res.json({
      ok: true,
      stats: {
        total_ports: totalPorts,
        active_ports: activePorts,
        free_ports: Math.max(0, totalPorts - activePorts)
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

async function adminStopPortRow(portRow, sourceTable, portDbId) {
  const adminNodeId = Number(portRow.node_id || portRow.vps_id || 0);
  const portNo = parsePortNumber(portRow);
  const folderPath =
    portRow.folder_path || portRow.base_path || `C:\\MT5_PORTS\\${portRow.port_name || `PORT-${String(portNo).padStart(2, '0')}`}`;
  const { systemVpsId } = await resolveSystemVpsId(adminNodeId);
  const systemPortNos = adminSystemPortNos(portNo);

  if (systemVpsId && folderPath) {
    await queueSystemAgentCommand(
      systemVpsId,
      'stop_mt5',
      {
        port: portNo,
        portNumber: portNo,
        port_no: portNo,
        folder_path: folderPath,
        folderPath,
        vpsFolderPath: folderPath,
        reason: 'admin_port_stop',
        sourceTable
      },
      portDbId
    );
  }

  const nodeIds = [...new Set([adminNodeId, systemVpsId].filter((x) => x > 0))];
  if (nodeIds.length && portNo) {
    await query(`
      UPDATE vps_system.vps_port_health
      SET running=FALSE, pid='[]'::jsonb, mt5_login=NULL, process_id=NULL, updated_at=NOW()
      WHERE node_id = ANY($1::bigint[]) AND port_number = ANY($2::int[])
    `, [nodeIds, systemPortNos.length ? systemPortNos : [portNo]]).catch(() => {});

    const portNos = systemPortNos.length ? systemPortNos : [portNo];
    await query(
      `
      UPDATE vps_system.mt5_accounts a
      SET status='cancelled', vps_id=NULL, port_id=NULL, assigned_port_no=NULL,
          windows_port_no=NULL, last_error='Admin ปิด PORT', updated_at=NOW()
      FROM vps_system.vps_ports p
      WHERE a.id = p.id
        AND p.vps_id = ANY($1::bigint[])
        AND p.port_no = ANY($2::int[])
        AND LOWER(COALESCE(a.status,'')) IN ('ready','connected','checking','connecting','starting','failed')
    `,
      [nodeIds, portNos]
    ).catch(() => {});

    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='cancelled', vps_id=NULL, port_id=NULL, assigned_port_no=NULL,
          windows_port_no=NULL, last_error='Admin ปิด PORT', updated_at=NOW()
      WHERE vps_id = ANY($1::bigint[])
        AND COALESCE(assigned_port_no, windows_port_no) = ANY($2::int[])
        AND LOWER(COALESCE(status,'')) IN ('ready','connected','checking','connecting','starting','failed')
    `,
      [nodeIds, portNos]
    ).catch(() => {});

    if (folderPath) {
      await query(
        `
        UPDATE vps_system.mt5_accounts a
        SET status='cancelled', vps_id=NULL, port_id=NULL, assigned_port_no=NULL,
            windows_port_no=NULL, last_error='Admin ปิด PORT', updated_at=NOW()
        FROM vps_system.vps_ports p
        WHERE a.port_id = p.id
          AND TRIM(COALESCE(p.folder_path, '')) = TRIM($1)
          AND LOWER(COALESCE(a.status,'')) IN ('ready','connected','checking','connecting','starting','failed')
      `,
        [folderPath]
      ).catch(() => {});
    }

    if (systemVpsId) {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='available', mt5_login=NULL, current_mt5_login=NULL, process_id=NULL,
            locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
        WHERE vps_id=$1 AND port_no = ANY($2::int[])
      `,
        [systemVpsId, systemPortNos.length ? systemPortNos : [portNo]]
      ).catch(() => {});
    }
  }

  if (sourceTable === 'vps_allocations') {
    await query(`
      UPDATE vps_allocations
      SET status='free', user_id=NULL, mt5_login=NULL, mt5_status='stopped', is_active=TRUE, updated_at=NOW()
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
        SET user_id=NULL, mt5_login=NULL, mt5_status='stopped', updated_at=NOW()
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
        SET user_id=NULL, mt5_login=NULL, mt5_status='stopped', last_error=NULL, updated_at=NOW()
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
    const raw = String(portRow.port_name || portRow.display_name || portRow.port_number || portRow.port || '');
    const m = raw.match(/(\d+)/);
    const no = m ? Number(m[1]) : Number(portRow.port_number || portRow.port || 0);
    const portCode = 'PORT' + String(no || 1).padStart(2, '0');
    const folderPath = portRow.base_path || portRow.folder_path || `C:\\MT5_PORTS\\${portCode}`;

    if (nodeId) {
      await adminStopPortRow(portRow, tableName, id);
    }

    let r;
    if (tableName === 'vps_allocations') {
      r = await query(`DELETE FROM vps_allocations WHERE id=$1 RETURNING *`, [id]).catch(() => ({ rows: [] }));
    } else {
      r = await query(`DELETE FROM vps_ports WHERE id=$1 RETURNING *`, [id]).catch(() => ({ rows: [] }));
    }
    if (!r.rows.length) return res.status(404).json({ ok:false, error:'PORT not found' });
    return res.json({ ok:true });
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
