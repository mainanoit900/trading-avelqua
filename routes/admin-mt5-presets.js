const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');

  const role = String(req.user.role || '').toLowerCase();
  const isAdmin = role === 'admin' || req.user.is_admin === true || req.user.isAdmin === true;

  if (!isAdmin) return res.status(403).send('Access denied');
  next();
}

router.use(requireAdmin);

const DATA_DIR = path.join(process.cwd(), 'data', 'mt5-presets');

const presets = [
  { name: 'AK-SNIPER', slug: 'ak-sniper' },
  { name: 'PA-SNIPER', slug: 'pa-sniper' },
  { name: '5PA-SNIPER', slug: '5pa-sniper' },
  { name: 'SNIPER-DEMO', slug: 'sniper-demo' },
];

const defaultRows = [
  [30,60,90,0.01,0.01,2,1,'','','',''],
  [60,120,180,0.02,0.02,4,2,'','','',''],
  [90,180,270,0.03,0.03,6,3,5,3,5,2],
  [120,240,360,0.04,0.04,8,4,7,4,6,3],
  [150,300,450,0.05,0.05,10,5,9,5,8,4],
  [180,360,540,0.06,0.06,12,6,11,5,10,5],
  [210,420,630,0.07,0.07,14,7,13,6,11,6],
  [240,480,720,0.08,0.08,16,8,14,7,13,6],
  [270,540,810,0.09,0.09,18,9,16,8,14,7],
  [300,600,900,0.10,0.10,20,10,18,9,16,8],
  [330,660,990,0.11,0.11,22,11,20,10,18,9],
  [360,720,1080,0.12,0.12,24,12,22,11,19,10],
  [390,780,1170,0.13,0.13,26,13,23,12,21,10],
  [420,840,1260,0.14,0.14,28,14,25,13,22,11],
  [450,900,1350,0.15,0.15,30,15,27,14,24,12],
  [480,960,1440,0.16,0.16,32,16,29,14,26,13],
  [510,1020,1530,0.17,0.17,34,17,31,15,27,14],
  [540,1080,1620,0.18,0.18,36,18,32,16,29,14],
  [570,1140,1710,0.19,0.19,38,19,34,17,30,15],
].map((r, i) => ({
  id: i + 1,
  capital_recommend: r[0],
  capital_safe: r[1],
  capital_max_safe: r[2],
  lot_size: r[3],
  lot_plus: r[4],
  t_start: r[5],
  t_stop: r[6],
  medium_t_start: r[7],
  medium_t_stop: r[8],
  fast_t_start: r[9],
  fast_t_stop: r[10],
  pip_step: 345,
  take_profit_average: 100
}));

function getViewBase(req, res) {
  return {
    currentPath: req.originalUrl || req.path || '',
    user: req.user || res.locals.user || null,
    success: req.query.success || null,
    error: req.query.error || null
  };
}

function isValidSlug(slug) {
  return presets.some(p => p.slug === slug);
}

function filePath(slug) {
  return path.join(DATA_DIR, `${slug}.json`);
}

function ensureDataFile(slug) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = filePath(slug);
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(defaultRows, null, 2));
}

function readRows(slug) {
  ensureDataFile(slug);
  try {
    return JSON.parse(fs.readFileSync(filePath(slug), 'utf8'));
  } catch {
    return defaultRows;
  }
}

function saveRows(slug, rows) {
  ensureDataFile(slug);
  fs.writeFileSync(filePath(slug), JSON.stringify(rows, null, 2));
}

function num(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

function buildRow(body, id) {
  return {
    id,
    capital_recommend: num(body.capital_recommend),
    capital_safe: num(body.capital_safe),
    capital_max_safe: num(body.capital_max_safe),
    lot_size: num(body.lot_size),
    lot_plus: num(body.lot_plus),
    t_start: num(body.t_start),
    t_stop: num(body.t_stop),
    medium_t_start: num(body.medium_t_start),
    medium_t_stop: num(body.medium_t_stop),
    fast_t_start: num(body.fast_t_start),
    fast_t_stop: num(body.fast_t_stop),
    pip_step: num(body.pip_step),
    take_profit_average: num(body.take_profit_average)
  };
}

router.get('/mt5-presets', (req, res) => {
  res.render('admin/mt5-presets-list', {
    ...getViewBase(req, res),
    presets,
    pageTitle: 'MT5 Presets'
  });
});

router.get('/mt5-presets/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!isValidSlug(slug)) return res.redirect('/admin/mt5-presets?error=ไม่พบตาราง');

  const preset = presets.find(p => p.slug === slug);

  res.render('admin/mt5-presets-table', {
    ...getViewBase(req, res),
    preset,
    slug,
    rows: readRows(slug),
    pageTitle: preset.name
  });
});

router.post('/mt5-presets/:slug/create', (req, res) => {
  const slug = req.params.slug;
  if (!isValidSlug(slug)) return res.redirect('/admin/mt5-presets?error=ไม่พบตาราง');

  const rows = readRows(slug);
  const nextId = rows.length ? Math.max(...rows.map(r => Number(r.id) || 0)) + 1 : 1;
  rows.push(buildRow(req.body, nextId));
  saveRows(slug, rows);

  res.redirect(`/admin/mt5-presets/${slug}?success=เพิ่มข้อมูลสำเร็จ`);
});

router.post('/mt5-presets/:slug/:id/update', (req, res) => {
  const slug = req.params.slug;
  const id = Number(req.params.id);

  if (!isValidSlug(slug)) return res.redirect('/admin/mt5-presets?error=ไม่พบตาราง');

  const rows = readRows(slug);
  const index = rows.findIndex(r => Number(r.id) === id);
  if (index >= 0) rows[index] = buildRow(req.body, id);

  saveRows(slug, rows);
  res.redirect(`/admin/mt5-presets/${slug}?success=แก้ไขข้อมูลสำเร็จ`);
});

router.post('/mt5-presets/:slug/:id/delete', (req, res) => {
  const slug = req.params.slug;
  const id = Number(req.params.id);

  if (!isValidSlug(slug)) return res.redirect('/admin/mt5-presets?error=ไม่พบตาราง');

  const rows = readRows(slug).filter(r => Number(r.id) !== id);
  saveRows(slug, rows);

  res.redirect(`/admin/mt5-presets/${slug}?success=ลบข้อมูลสำเร็จ`);
});

router.post('/mt5-presets/:slug/reset', (req, res) => {
  const slug = req.params.slug;
  if (!isValidSlug(slug)) return res.redirect('/admin/mt5-presets?error=ไม่พบตาราง');

  saveRows(slug, defaultRows);
  res.redirect(`/admin/mt5-presets/${slug}?success=รีเซ็ตตารางสำเร็จ`);
});

router.post('/mt5-presets/:slug/delete-table', (req, res) => {
  const slug = req.params.slug;
  if (!isValidSlug(slug)) return res.redirect('/admin/mt5-presets?error=ไม่พบตาราง');

  saveRows(slug, []);
  res.redirect(`/admin/mt5-presets/${slug}?success=ลบข้อมูลทั้งตารางสำเร็จ`);
});

module.exports = router;
