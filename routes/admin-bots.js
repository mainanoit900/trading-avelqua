const express = require('express');
const { query } = require('../config/database');
const requireAdmin = require('../middleware/admin');

const router = express.Router();

const MT5_SERVERS = ['MohicansMarkets-Live', 'MohicansMarkets-Demo'];
const SYMBOLS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'US30', 'NAS100'];
const RISK_MODES = [
  { key: 'safe', label: 'เซฟ' },
  { key: 'medium', label: 'กลาง' },
  { key: 'fast', label: 'รวบไว' }
];

function flash(req) {
  const out = { success: req.session?.success || '', error: req.session?.error || '' };
  if (req.session) { req.session.success = ''; req.session.error = ''; }
  return out;
}

function baseView(req, extra = {}) {
  return {
    pageTitle: extra.pageTitle || 'จัดการบอทลูกค้า',
    currentPath: extra.currentPath || '/admin/bots',
    currentUrl: req.originalUrl || '/admin/bots',
    user: req.user || req.session?.user || null,
    ...flash(req),
    ...extra
  };
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function text(value, fallback = '') {
  const v = String(value ?? '').trim();
  return v || fallback;
}

async function tableExists(name) {
  const r = await query('SELECT to_regclass($1) AS name', ['public.' + name]);
  return !!r.rows?.[0]?.name;
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_user_bots (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      package_id BIGINT REFERENCES packages(id) ON DELETE SET NULL,
      bot_name TEXT NOT NULL DEFAULT '',
      mt5_login TEXT NOT NULL DEFAULT '',
      mt5_password TEXT NOT NULL DEFAULT '',
      mt5_server TEXT NOT NULL DEFAULT 'MohicansMarkets-Demo',
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      capital NUMERIC(14,2) NOT NULL DEFAULT 0,
      target_profit_percent NUMERIC(10,2) NOT NULL DEFAULT 0,
      target_profit_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      lot NUMERIC(10,2) NOT NULL DEFAULT 0,
      port INTEGER NOT NULL DEFAULT 0,
      risk_mode TEXT NOT NULL DEFAULT 'safe',
      t_start INTEGER NOT NULL DEFAULT 0,
      t_stop INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'stopped',
      last_action TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ,
      stopped_at TIMESTAMPTZ,
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT admin_user_bots_status_chk CHECK (status IN ('draft','stopped','running','error')),
      CONSTRAINT admin_user_bots_risk_chk CHECK (risk_mode IN ('safe','medium','fast')),
      CONSTRAINT admin_user_bots_server_chk CHECK (mt5_server IN ('MohicansMarkets-Live','MohicansMarkets-Demo'))
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS admin_bot_strategy_rows (
      id BIGSERIAL PRIMARY KEY,
      capital_recommended NUMERIC(14,2) NOT NULL UNIQUE,
      capital_safe NUMERIC(14,2) NOT NULL DEFAULT 0,
      capital_max_safe NUMERIC(14,2) NOT NULL DEFAULT 0,
      lot_size NUMERIC(10,2) NOT NULL DEFAULT 0,
      lot_plus NUMERIC(10,2) NOT NULL DEFAULT 0,
      safe_t_start INTEGER NOT NULL DEFAULT 0,
      safe_t_stop INTEGER NOT NULL DEFAULT 0,
      medium_t_start INTEGER NOT NULL DEFAULT 0,
      medium_t_stop INTEGER NOT NULL DEFAULT 0,
      fast_t_start INTEGER NOT NULL DEFAULT 0,
      fast_t_stop INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function seedStrategyIfEmpty() {
  const count = await query('SELECT COUNT(*)::int AS total FROM admin_bot_strategy_rows');
  if (Number(count.rows[0]?.total || 0) > 0) return;
  const rows = [
    [30,60,90,0.01,0.01,2,1,0,0,0,0],[60,120,180,0.02,0.02,4,2,0,0,0,0],[90,180,270,0.03,0.03,6,3,5,3,5,2],
    [120,240,360,0.04,0.04,8,4,7,4,6,3],[150,300,450,0.05,0.05,10,5,9,5,8,4],[180,360,540,0.06,0.06,12,6,11,5,10,5],
    [210,420,630,0.07,0.07,14,7,13,6,11,6],[240,480,720,0.08,0.08,16,8,14,7,13,6],[270,540,810,0.09,0.09,18,9,16,8,14,7],
    [300,600,900,0.10,0.10,20,10,18,9,16,8],[330,660,990,0.11,0.11,22,11,20,10,18,9],[360,720,1080,0.12,0.12,24,12,22,11,19,10],
    [390,780,1170,0.13,0.13,26,13,23,12,21,10],[420,840,1260,0.14,0.14,28,14,25,13,22,11],[450,900,1350,0.15,0.15,30,15,27,14,24,12],
    [480,960,1440,0.16,0.16,32,16,29,14,26,13],[510,1020,1530,0.17,0.17,34,17,31,15,27,14],[540,1080,1620,0.18,0.18,36,18,32,16,29,14],[570,1140,1710,0.19,0.19,38,19,34,17,30,15]
  ];
  for (const r of rows) {
    await query(`INSERT INTO admin_bot_strategy_rows
      (capital_recommended,capital_safe,capital_max_safe,lot_size,lot_plus,safe_t_start,safe_t_stop,medium_t_start,medium_t_stop,fast_t_start,fast_t_stop)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (capital_recommended) DO NOTHING`, r);
  }
}

async function getPackages() {
  const hasPackages = await tableExists('packages');
  if (!hasPackages) return [];
  const r = await query(`
    SELECT id, COALESCE(package_code, group_name, 'PKG-' || id::text) AS package_code,
           COALESCE(NULLIF(name_th,''), NULLIF(name_en,''), group_name, package_code, 'Package') AS name,
           COALESCE(group_name, package_code, '') AS group_name,
           lot_min, lot_max, ports_min, ports_max, price, is_enabled
    FROM packages
    ORDER BY CASE COALESCE(group_name, package_code) WHEN 'BASIC' THEN 1 WHEN 'PRO' THEN 2 WHEN 'ADVANCED' THEN 3 ELSE 9 END, sort_order, id
  `);
  return r.rows;
}

async function getUsers() {
  const hasUsers = await tableExists('users');
  if (!hasUsers) return [];
  const r = await query(`
    SELECT id,
           COALESCE(NULLIF(display_id,''), 'US' || LPAD(id::text, 6, '0')) AS display_id,
           COALESCE(NULLIF(full_name,''), NULLIF(name,''), email, 'User #' || id::text) AS label,
           email
    FROM users
    ORDER BY id DESC
    LIMIT 500
  `);
  return r.rows;
}

async function findStrategy(capital, mode) {
  const r = await query(`SELECT * FROM admin_bot_strategy_rows WHERE is_active = TRUE ORDER BY ABS(capital_recommended - $1) ASC LIMIT 1`, [capital]);
  const row = r.rows[0] || null;
  if (!row) return { lot: 0, tStart: 0, tStop: 0 };
  if (mode === 'medium') return { lot: Number(row.lot_size || 0), tStart: int(row.medium_t_start), tStop: int(row.medium_t_stop) };
  if (mode === 'fast') return { lot: Number(row.lot_size || 0), tStart: int(row.fast_t_start), tStop: int(row.fast_t_stop) };
  return { lot: Number(row.lot_size || 0), tStart: int(row.safe_t_start), tStop: int(row.safe_t_stop) };
}

function clampByPackage(lot, port, pkg) {
  let finalLot = num(lot);
  let finalPort = int(port);
  if (pkg) {
    const minLot = num(pkg.lot_min, 0.01);
    const maxLot = num(pkg.lot_max, 0);
    const minPort = int(pkg.ports_min, 1);
    const maxPort = int(pkg.ports_max, 0);
    if (finalLot && finalLot < minLot) finalLot = minLot;
    if (maxLot > 0 && finalLot > maxLot) finalLot = maxLot;
    if (finalPort && finalPort < minPort) finalPort = minPort;
    if (maxPort > 0 && finalPort > maxPort) finalPort = maxPort;
  }
  return { lot: finalLot, port: finalPort };
}

router.use(requireAdmin);

router.get('/admin/bots', async (req, res) => {
  try {
    await ensureTables();
    await seedStrategyIfEmpty();
    const [botsRes, packages, users, strategyRes] = await Promise.all([
      query(`
        SELECT b.*, p.package_code, p.group_name, p.name_th AS package_name,
               COALESCE(NULLIF(u.display_id,''), 'US' || LPAD(u.id::text, 6, '0')) AS user_display_id,
               COALESCE(NULLIF(u.full_name,''), NULLIF(u.name,''), u.email, 'User #' || u.id::text) AS user_name,
               u.email AS user_email
        FROM admin_user_bots b
        LEFT JOIN packages p ON p.id = b.package_id
        LEFT JOIN users u ON u.id = b.user_id
        ORDER BY b.created_at DESC
        LIMIT 300
      `),
      getPackages(),
      getUsers(),
      query('SELECT * FROM admin_bot_strategy_rows ORDER BY capital_recommended ASC')
    ]);
    const summary = {
      total: botsRes.rows.length,
      running: botsRes.rows.filter(x => x.status === 'running').length,
      stopped: botsRes.rows.filter(x => x.status === 'stopped').length,
      error: botsRes.rows.filter(x => x.status === 'error').length
    };
    return res.render('admin/bots', baseView(req, {
      pageTitle: 'หน้าใช้งาน Admin: สร้างบอทให้ลูกค้า',
      currentPath: '/admin/bots',
      bots: botsRes.rows,
      packages,
      users,
      strategyRows: strategyRes.rows,
      mt5Servers: MT5_SERVERS,
      symbols: SYMBOLS,
      riskModes: RISK_MODES,
      summary
    }));
  } catch (error) {
    console.error('admin bots page error:', error);
    req.session.error = 'เปิดหน้าบอทไม่สำเร็จ: ' + error.message;
    return res.redirect('/admin');
  }
});

router.post('/admin/bots/create', async (req, res) => {
  try {
    await ensureTables();
    const packages = await getPackages();
    const packageId = req.body.package_id ? Number(req.body.package_id) : null;
    const pkg = packages.find(p => Number(p.id) === packageId) || null;
    const capital = num(req.body.capital);
    const riskMode = ['safe','medium','fast'].includes(req.body.risk_mode) ? req.body.risk_mode : 'safe';
    const strategy = await findStrategy(capital, riskMode);
    const manualLot = num(req.body.lot);
    const manualPort = int(req.body.port);
    const autoPort = Math.max(1, Math.round(capital / 75));
    const clamped = clampByPackage(manualLot || strategy.lot, manualPort || autoPort, pkg);
    const targetPercent = num(req.body.target_profit_percent);
    const targetAmount = num(req.body.target_profit_amount) || (capital > 0 && targetPercent > 0 ? capital * targetPercent / 100 : 0);
    const server = MT5_SERVERS.includes(req.body.mt5_server) ? req.body.mt5_server : 'MohicansMarkets-Demo';

    await query(`
      INSERT INTO admin_user_bots
      (user_id, package_id, bot_name, mt5_login, mt5_password, mt5_server, symbol, capital,
       target_profit_percent, target_profit_amount, lot, port, risk_mode, t_start, t_stop, status, created_by, last_action)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'stopped',$16,'created')
    `, [
      req.body.user_id ? Number(req.body.user_id) : null,
      packageId,
      text(req.body.bot_name, 'Avelqua Bot'),
      text(req.body.mt5_login),
      text(req.body.mt5_password),
      server,
      text(req.body.symbol, 'XAUUSD').toUpperCase(),
      capital,
      targetPercent,
      targetAmount,
      clamped.lot,
      clamped.port,
      riskMode,
      strategy.tStart,
      strategy.tStop,
      req.user?.id || req.session?.user?.id || null
    ]);
    req.session.success = 'สร้างรายการบอทให้ลูกค้าแล้ว';
  } catch (error) {
    console.error('create bot error:', error);
    req.session.error = 'สร้างบอทไม่สำเร็จ: ' + error.message;
  }
  return res.redirect('/admin/bots');
});

router.post('/admin/bots/:id/update', async (req, res) => {
  try {
    await ensureTables();
    const old = await query('SELECT * FROM admin_user_bots WHERE id=$1', [req.params.id]);
    const bot = old.rows[0];
    if (!bot) throw new Error('ไม่พบรายการบอท');
    if (bot.status === 'running') throw new Error('ต้องปิดบอทก่อน จึงจะแก้ไขได้');

    const packages = await getPackages();
    const packageId = req.body.package_id ? Number(req.body.package_id) : null;
    const pkg = packages.find(p => Number(p.id) === packageId) || null;
    const capital = num(req.body.capital);
    const riskMode = ['safe','medium','fast'].includes(req.body.risk_mode) ? req.body.risk_mode : 'safe';
    const strategy = await findStrategy(capital, riskMode);
    const clamped = clampByPackage(num(req.body.lot) || strategy.lot, int(req.body.port) || Math.max(1, Math.round(capital / 75)), pkg);
    const targetPercent = num(req.body.target_profit_percent);
    const targetAmount = num(req.body.target_profit_amount) || (capital > 0 && targetPercent > 0 ? capital * targetPercent / 100 : 0);
    const server = MT5_SERVERS.includes(req.body.mt5_server) ? req.body.mt5_server : 'MohicansMarkets-Demo';

    await query(`
      UPDATE admin_user_bots SET
        user_id=$2, package_id=$3, bot_name=$4, mt5_login=$5, mt5_password=$6, mt5_server=$7,
        symbol=$8, capital=$9, target_profit_percent=$10, target_profit_amount=$11,
        lot=$12, port=$13, risk_mode=$14, t_start=$15, t_stop=$16,
        last_action='updated', updated_at=NOW()
      WHERE id=$1
    `, [req.params.id, req.body.user_id ? Number(req.body.user_id) : null, packageId, text(req.body.bot_name, 'Avelqua Bot'), text(req.body.mt5_login), text(req.body.mt5_password), server, text(req.body.symbol, 'XAUUSD').toUpperCase(), capital, targetPercent, targetAmount, clamped.lot, clamped.port, riskMode, strategy.tStart, strategy.tStop]);
    req.session.success = 'แก้ไขบอทแล้ว';
  } catch (error) {
    console.error('update bot error:', error);
    req.session.error = error.message;
  }
  return res.redirect('/admin/bots');
});

router.post('/admin/bots/:id/start', async (req, res) => {
  try {
    await ensureTables();
    await query(`UPDATE admin_user_bots SET status='running', started_at=NOW(), stopped_at=NULL, last_action='started', last_error='', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    req.session.success = 'เปิดบอทแล้ว';
  } catch (error) { req.session.error = 'เปิดบอทไม่สำเร็จ: ' + error.message; }
  return res.redirect('/admin/bots');
});

router.post('/admin/bots/:id/stop', async (req, res) => {
  try {
    await ensureTables();
    await query(`UPDATE admin_user_bots SET status='stopped', stopped_at=NOW(), last_action='stopped', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    req.session.success = 'ปิดบอทแล้ว สามารถแก้ไขหรือลบได้';
  } catch (error) { req.session.error = 'ปิดบอทไม่สำเร็จ: ' + error.message; }
  return res.redirect('/admin/bots');
});

router.post('/admin/bots/:id/delete', async (req, res) => {
  try {
    await ensureTables();
    const old = await query('SELECT status FROM admin_user_bots WHERE id=$1', [req.params.id]);
    if (!old.rows[0]) throw new Error('ไม่พบรายการบอท');
    if (old.rows[0].status === 'running') throw new Error('ต้องปิดบอทก่อน จึงจะลบได้');
    await query('DELETE FROM admin_user_bots WHERE id=$1', [req.params.id]);
    req.session.success = 'ลบบอทแล้ว';
  } catch (error) { req.session.error = error.message; }
  return res.redirect('/admin/bots');
});

module.exports = router;
