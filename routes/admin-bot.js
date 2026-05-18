const express = require('express');
const { query } = require('../config/database');
const requireAdmin = require('../middleware/admin');

const router = express.Router();
router.use(requireAdmin);

function baseView(req, extra = {}) {
  const out = { success: req.session.success || '', error: req.session.error || '' };
  req.session.success = ''; req.session.error = '';
  return {
    pageTitle: extra.pageTitle || 'Admin',
    currentPath: extra.currentPath || '/admin',
    currentUrl: req.originalUrl || extra.currentPath || '/admin',
    user: req.user || req.session.user || null,
    ...out,
    ...extra
  };
}

async function ensureAdminBotTradingTables() {
  await query(`CREATE TABLE IF NOT EXISTS admin_bot_package_rules (id BIGSERIAL PRIMARY KEY, package_code TEXT NOT NULL UNIQUE, package_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', lot_min NUMERIC(18,2) NOT NULL DEFAULT 0.01, lot_max NUMERIC(18,2), port_min INTEGER NOT NULL DEFAULT 1, port_max INTEGER, allowed_modes TEXT[] NOT NULL DEFAULT ARRAY['safe','medium','fast'], is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`INSERT INTO admin_bot_package_rules (package_code, package_name, description, lot_min, lot_max, port_min, port_max, sort_order) VALUES ('BASIC','แพ็กเกจถูก BASIC','เหมาะสำหรับเริ่มต้น ใช้ Lot 0.01 - 0.05 และ Port 1-4',0.01,0.05,1,4,1),('PRO','แพ็กเกจกลาง PRO','เหมาะสำหรับผู้ใช้จริงจัง ใช้ Lot 0.01 - 0.50 และ Port 1-6',0.01,0.50,1,6,2),('ADVANCED','แพ็กเกจแพง ADVANCED','Lot ไม่จำกัด และ Port ไม่จำกัด ตามที่ Admin อนุมัติ',0.01,NULL,1,NULL,3) ON CONFLICT (package_code) DO NOTHING`);
  await query(`CREATE TABLE IF NOT EXISTS admin_bot_symbols (id BIGSERIAL PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '', basic_enabled BOOLEAN NOT NULL DEFAULT TRUE, pro_enabled BOOLEAN NOT NULL DEFAULT TRUE, advanced_enabled BOOLEAN NOT NULL DEFAULT TRUE, is_active BOOLEAN NOT NULL DEFAULT TRUE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`INSERT INTO admin_bot_symbols (symbol, display_name, basic_enabled, pro_enabled, advanced_enabled, sort_order) VALUES ('XAUUSD','ทองคำ',TRUE,TRUE,TRUE,1),('EURUSD','Euro / US Dollar',TRUE,TRUE,TRUE,2),('GBPUSD','Pound / US Dollar',FALSE,TRUE,TRUE,3),('USDJPY','US Dollar / Yen',FALSE,TRUE,TRUE,4),('BTCUSD','Bitcoin',FALSE,FALSE,TRUE,5) ON CONFLICT (symbol) DO NOTHING`);
  await query(`CREATE TABLE IF NOT EXISTS admin_bot_global_settings (id INTEGER PRIMARY KEY DEFAULT 1, is_enabled BOOLEAN NOT NULL DEFAULT TRUE, default_package_code TEXT NOT NULL DEFAULT 'BASIC', default_symbol TEXT NOT NULL DEFAULT 'XAUUSD', default_mode TEXT NOT NULL DEFAULT 'safe', allow_user_custom_lot BOOLEAN NOT NULL DEFAULT FALSE, allow_user_custom_port BOOLEAN NOT NULL DEFAULT FALSE, allow_user_custom_symbol BOOLEAN NOT NULL DEFAULT TRUE, require_admin_approval BOOLEAN NOT NULL DEFAULT TRUE, admin_note TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT admin_bot_global_singleton CHECK (id=1))`);
  await query(`INSERT INTO admin_bot_global_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await query(`CREATE TABLE IF NOT EXISTS admin_bot_strategy_presets (id BIGSERIAL PRIMARY KEY, capital_recommend NUMERIC(18,2) NOT NULL UNIQUE, capital_safe NUMERIC(18,2) NOT NULL DEFAULT 0, capital_max_safe NUMERIC(18,2) NOT NULL DEFAULT 0, lot_size NUMERIC(18,2) NOT NULL DEFAULT 0.01, lot_plus NUMERIC(18,2) NOT NULL DEFAULT 0.01, t_start INTEGER, t_stop INTEGER, medium_t_start INTEGER, medium_t_stop INTEGER, fast_t_start INTEGER, fast_t_stop INTEGER, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`INSERT INTO admin_bot_strategy_presets (capital_recommend,capital_safe,capital_max_safe,lot_size,lot_plus,t_start,t_stop,medium_t_start,medium_t_stop,fast_t_start,fast_t_stop) VALUES (30,60,90,0.01,0.01,2,1,NULL,NULL,NULL,NULL),(60,120,180,0.02,0.02,4,2,NULL,NULL,NULL,NULL),(90,180,270,0.03,0.03,6,3,5,3,5,2),(120,240,360,0.04,0.04,8,4,7,4,6,3),(150,300,450,0.05,0.05,10,5,9,5,8,4),(180,360,540,0.06,0.06,12,6,11,5,10,5),(210,420,630,0.07,0.07,14,7,13,6,11,6),(240,480,720,0.08,0.08,16,8,14,7,13,6),(270,540,810,0.09,0.09,18,9,16,8,14,7),(300,600,900,0.10,0.10,20,10,18,9,16,8),(330,660,990,0.11,0.11,22,11,20,10,18,9),(360,720,1080,0.12,0.12,24,12,22,11,19,10),(390,780,1170,0.13,0.13,26,13,23,12,21,10),(420,840,1260,0.14,0.14,28,14,25,13,22,11),(450,900,1350,0.15,0.15,30,15,27,14,24,12),(480,960,1440,0.16,0.16,32,16,29,14,26,13),(510,1020,1530,0.17,0.17,34,17,31,15,27,14),(540,1080,1620,0.18,0.18,36,18,32,16,29,14),(570,1140,1710,0.19,0.19,38,19,34,17,30,15) ON CONFLICT (capital_recommend) DO NOTHING`);
  await query(`CREATE TABLE IF NOT EXISTS admin_bot_runs (id BIGSERIAL PRIMARY KEY, run_code TEXT NOT NULL UNIQUE, user_label TEXT NOT NULL DEFAULT '', mt5_login TEXT NOT NULL DEFAULT '', mt5_server TEXT NOT NULL DEFAULT '', package_code TEXT NOT NULL DEFAULT 'BASIC', symbol TEXT NOT NULL DEFAULT 'XAUUSD', mode TEXT NOT NULL DEFAULT 'safe', capital NUMERIC(18,2) NOT NULL DEFAULT 0, lot_size NUMERIC(18,2) NOT NULL DEFAULT 0.01, port_count INTEGER NOT NULL DEFAULT 1, t_start INTEGER, t_stop INTEGER, status TEXT NOT NULL DEFAULT 'draft', admin_note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function findPresetByCapital(capital) {
  const r = await query(`SELECT * FROM admin_bot_strategy_presets WHERE capital_recommend <= $1 AND is_active IS TRUE ORDER BY capital_recommend DESC LIMIT 1`, [Number(capital || 0)]);
  if (r.rows[0]) return r.rows[0];
  const f = await query(`SELECT * FROM admin_bot_strategy_presets WHERE is_active IS TRUE ORDER BY capital_recommend ASC LIMIT 1`);
  return f.rows[0] || null;
}
function pickPresetMode(preset, mode) {
  if (!preset) return { tStart: null, tStop: null };
  if (mode === 'medium') return { tStart: preset.medium_t_start || preset.t_start, tStop: preset.medium_t_stop || preset.t_stop };
  if (mode === 'fast') return { tStart: preset.fast_t_start || preset.t_start, tStop: preset.fast_t_stop || preset.t_stop };
  return { tStart: preset.t_start, tStop: preset.t_stop };
}

router.get('/vps', async (req, res) => {
  try {
    await ensureAdminBotTradingTables();
    const [nodesRes, allocationsRes, strategyRes, packagesRes, symbolsRes, settingsRes, runsRes, sessionsRes] = await Promise.all([
      query(`SELECT * FROM vps_nodes ORDER BY status ASC, node_name ASC`).catch(() => ({ rows: [] })),
      query(`SELECT * FROM vps_allocations ORDER BY created_at DESC LIMIT 100`).catch(() => ({ rows: [] })),
      query(`SELECT * FROM admin_bot_strategy_presets ORDER BY capital_recommend ASC`),
      query(`SELECT * FROM admin_bot_package_rules ORDER BY sort_order ASC, id ASC`),
      query(`SELECT * FROM admin_bot_symbols ORDER BY sort_order ASC, symbol ASC`),
      query(`SELECT * FROM admin_bot_global_settings WHERE id = 1 LIMIT 1`),
      query(`SELECT * FROM admin_bot_runs ORDER BY updated_at DESC LIMIT 100`),
      query(`SELECT * FROM bot_sessions ORDER BY updated_at DESC LIMIT 100`).catch(() => ({ rows: [] }))
    ]);
    const nodes = nodesRes.rows || [];
    const vpsSummary = { totalNodes: nodes.length, onlineNodes: nodes.filter(s=>s.status==='available').length, offlineNodes: nodes.filter(s=>s.status==='offline').length, usedPorts: nodes.reduce((a,b)=>a+Number(b.used_ports||0),0), totalPorts: nodes.reduce((a,b)=>a+Number(b.max_ports||0),0), usedLot: nodes.reduce((a,b)=>a+Number(b.used_lot||0),0), totalLot: nodes.reduce((a,b)=>a+Number(b.max_lot||0),0), runningBots: (runsRes.rows||[]).filter(x=>x.status==='running').length, stoppedBots: (runsRes.rows||[]).filter(x=>x.status==='stopped').length, errorBots: (runsRes.rows||[]).filter(x=>x.status==='error').length };
    return res.render('admin/vps', baseView(req, { pageTitle: 'ตั้งค่า Bot Trading / VPS / MT5', currentPath: '/admin/vps', pageCss: 'admin-vps-control.css', nodes, allocations: allocationsRes.rows, profiles: strategyRes.rows, strategyPresets: strategyRes.rows, packages: packagesRes.rows, symbols: symbolsRes.rows, botSettings: settingsRes.rows[0] || {}, adminRuns: runsRes.rows, sessions: sessionsRes.rows, vpsSummary, commands: [], logs: [] }));
  } catch (error) { console.error('admin bot vps error:', error); return res.status(500).send(error.message || 'Admin Bot VPS error'); }
});

router.post('/vps/settings/save', async (req, res) => { await ensureAdminBotTradingTables(); await query(`UPDATE admin_bot_global_settings SET is_enabled=$1, default_package_code=$2, default_symbol=$3, default_mode=$4, allow_user_custom_lot=$5, allow_user_custom_port=$6, allow_user_custom_symbol=$7, require_admin_approval=$8, admin_note=$9, updated_at=NOW() WHERE id=1`, [req.body.is_enabled==='on', req.body.default_package_code||'BASIC', req.body.default_symbol||'XAUUSD', req.body.default_mode||'safe', req.body.allow_user_custom_lot==='on', req.body.allow_user_custom_port==='on', req.body.allow_user_custom_symbol==='on', req.body.require_admin_approval==='on', req.body.admin_note||'']); req.session.success='บันทึกการตั้งค่าบอทหลักแล้ว'; res.redirect('/admin/vps#bot-global'); });
router.post('/vps/packages/save', async (req, res) => { await ensureAdminBotTradingTables(); const ids = Array.isArray(req.body.id) ? req.body.id : [req.body.id].filter(Boolean); for (let idx=0; idx<ids.length; idx++) { const id=ids[idx]; const get=(name)=>Array.isArray(req.body[name])?req.body[name][idx]:req.body[name]; await query(`UPDATE admin_bot_package_rules SET package_name=$2, description=$3, lot_min=$4, lot_max=NULLIF($5,'')::numeric, port_min=$6, port_max=NULLIF($7,'')::integer, is_active=$8, updated_at=NOW() WHERE id=$1`, [id, get('package_name'), get('description'), Number(get('lot_min')||0.01), String(get('lot_max')||''), Number(get('port_min')||1), String(get('port_max')||''), req.body['is_active_'+id]==='on']); } req.session.success='บันทึกแพ็กเกจบอทแล้ว'; res.redirect('/admin/vps#packages'); });
router.post('/vps/symbols/save', async (req, res) => { await ensureAdminBotTradingTables(); const ids = Array.isArray(req.body.id) ? req.body.id : [req.body.id].filter(Boolean); for (let idx=0; idx<ids.length; idx++) { const id=ids[idx]; const get=(name)=>Array.isArray(req.body[name])?req.body[name][idx]:req.body[name]; await query(`UPDATE admin_bot_symbols SET symbol=UPPER($2), display_name=$3, basic_enabled=$4, pro_enabled=$5, advanced_enabled=$6, is_active=$7, updated_at=NOW() WHERE id=$1`, [id, get('symbol'), get('display_name'), req.body['basic_enabled_'+id]==='on', req.body['pro_enabled_'+id]==='on', req.body['advanced_enabled_'+id]==='on', req.body['symbol_active_'+id]==='on']); } if (String(req.body.new_symbol||'').trim()) { await query(`INSERT INTO admin_bot_symbols (symbol, display_name, basic_enabled, pro_enabled, advanced_enabled, is_active) VALUES (UPPER($1),$2,$3,$4,$5,TRUE) ON CONFLICT (symbol) DO UPDATE SET display_name=EXCLUDED.display_name, updated_at=NOW()`, [req.body.new_symbol, req.body.new_display_name||'', req.body.new_basic==='on', req.body.new_pro==='on', req.body.new_advanced==='on']); } req.session.success='บันทึกคู่เงินแล้ว'; res.redirect('/admin/vps#symbols'); });
router.post('/vps/preset/:id/update', async (req, res) => { await ensureAdminBotTradingTables(); await query(`UPDATE admin_bot_strategy_presets SET capital_recommend=$2, capital_safe=$3, capital_max_safe=$4, lot_size=$5, lot_plus=$6, t_start=NULLIF($7,'')::integer, t_stop=NULLIF($8,'')::integer, medium_t_start=NULLIF($9,'')::integer, medium_t_stop=NULLIF($10,'')::integer, fast_t_start=NULLIF($11,'')::integer, fast_t_stop=NULLIF($12,'')::integer, is_active=$13, updated_at=NOW() WHERE id=$1`, [req.params.id, req.body.capital_recommend, req.body.capital_safe, req.body.capital_max_safe, req.body.lot_size, req.body.lot_plus, req.body.t_start||'', req.body.t_stop||'', req.body.medium_t_start||'', req.body.medium_t_stop||'', req.body.fast_t_start||'', req.body.fast_t_stop||'', req.body.is_active==='on']); req.session.success='อัปเดตแถวตารางทุน/LOT แล้ว'; res.redirect('/admin/vps#strategy'); });
router.post('/vps/manual-run/create', async (req, res) => { await ensureAdminBotTradingTables(); const capital=Number(req.body.capital||0); const mode=String(req.body.mode||'safe'); const preset=await findPresetByCapital(capital); const mt=pickPresetMode(preset, mode); const lot=Number(req.body.lot_size||preset?.lot_size||0.01); const runCode='BOT-'+Date.now().toString(36).toUpperCase(); await query(`INSERT INTO admin_bot_runs (run_code,user_label,mt5_login,mt5_server,package_code,symbol,mode,capital,lot_size,port_count,t_start,t_stop,status,admin_note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13)`, [runCode, req.body.user_label||'', req.body.mt5_login||'', req.body.mt5_server||'', req.body.package_code||'BASIC', req.body.symbol||'XAUUSD', mode, capital, lot, Number(req.body.port_count||1), mt.tStart, mt.tStop, req.body.admin_note||'']); req.session.success=`สร้างรายการบอท ${runCode} แล้ว`; res.redirect('/admin/vps#admin-run'); });
router.post('/vps/manual-run/:id/status', async (req, res) => { await ensureAdminBotTradingTables(); await query(`UPDATE admin_bot_runs SET status=$2, updated_at=NOW() WHERE id=$1`, [req.params.id, req.body.status||'draft']); req.session.success='เปลี่ยนสถานะรายการบอทแล้ว'; res.redirect('/admin/vps#admin-run'); });

module.exports = router;
