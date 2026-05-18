const express = require('express');
const crypto = require('crypto');
const requireAdmin = require('../middleware/admin');
const { requireLogin } = require('../middleware/requireAuth');
const { query } = require('../config/database');
const allocator = require('../services/vpsAllocator');
const agent = require('../services/vpsAgent');
const intelAi = require('../services/intelAi');

const router = express.Router();

function base(req, extra = {}) {
  const t = req.t || ((k, f) => f || k);
  return {
    t,
    lang: req.lang || req.session?.lang || 'th',
    localeLabels: resLocals(req, 'localeLabels', {}),
    clientLocales: resLocals(req, 'clientLocales', {}),
    user: req.user || req.session?.user || null,
    currentUser: req.user || req.session?.user || null,
    success: req.session?.success || '',
    error: req.session?.error || '',
    ...extra
  };
}

function resLocals(req, key, fallback) {
  return req.res?.locals?.[key] || fallback;
}

function flash(req, type, msg) {
  if (req.session) req.session[type] = msg;
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/admin/vps', requireAdmin, async (req, res, next) => {
  try {
    if (req.session) { req.session.success = req.session.success || ''; req.session.error = req.session.error || ''; }
    await allocator.markOfflineNodes();

    const [nodes, bots, accounts, instances, presets, reports, servers] = await Promise.all([
      query(`SELECT *, (max_ports-used_ports) AS free_ports, (max_lot-used_lot) AS free_lot FROM vps_system.vps_nodes ORDER BY is_active DESC, status ASC, node_code ASC`),
      query(`SELECT * FROM vps_system.bot_catalog ORDER BY id ASC`),
      query(`SELECT ma.*, u.email, u.email AS user_name FROM vps_system.mt5_accounts ma LEFT JOIN users u ON u.id=ma.user_id ORDER BY ma.id DESC LIMIT 100`),
      query(`SELECT bi.*, bc.bot_name, bc.bot_code, ma.mt5_login, ma.server_name, vn.node_name, vn.node_code, u.email, u.email AS user_name
             FROM vps_system.bot_instances bi
             LEFT JOIN vps_system.bot_catalog bc ON bc.id=bi.bot_id
             LEFT JOIN vps_system.mt5_accounts ma ON ma.id=bi.mt5_account_id
             LEFT JOIN vps_system.vps_nodes vn ON vn.id=bi.vps_id
             LEFT JOIN users u ON u.id=bi.user_id
             ORDER BY bi.id DESC LIMIT 150`),
      query(`SELECT * FROM vps_system.lot_presets ORDER BY capital_recommend ASC`),
      query(`SELECT * FROM vps_system.intel_reports ORDER BY id DESC LIMIT 20`),
      query(`SELECT * FROM vps_system.mt5_servers ORDER BY id ASC`)
    ]);

    if (req.session) { req.session.success = ''; req.session.error = ''; }

    return res.render('admin/vps', base(req, {
      pageTitle: 'VPS / MT5 Control',
      currentPath: '/admin/vps',
      nodes: nodes.rows,
      bots: bots.rows,
      accounts: accounts.rows,
      instances: instances.rows,
      presets: presets.rows,
      reports: reports.rows,
      servers: servers.rows
    }));
  } catch (error) { next(error); }
});

router.post('/admin/vps/nodes', requireAdmin, async (req, res, next) => {
  try {
    const apiKey = req.body.api_key || crypto.randomBytes(24).toString('hex');
    await query(`
      INSERT INTO vps_system.vps_nodes
      (node_code,node_name,host,api_url,api_key,os_type,max_ports,max_lot,status,note,is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
      ON CONFLICT (node_code) DO UPDATE SET
        node_name=EXCLUDED.node_name, host=EXCLUDED.host, api_url=EXCLUDED.api_url,
        api_key=EXCLUDED.api_key, os_type=EXCLUDED.os_type, max_ports=EXCLUDED.max_ports,
        max_lot=EXCLUDED.max_lot, status=EXCLUDED.status, note=EXCLUDED.note, updated_at=NOW()
    `, [
      req.body.node_code, req.body.node_name, req.body.host, req.body.api_url, apiKey,
      req.body.os_type || 'windows', safeNumber(req.body.max_ports), safeNumber(req.body.max_lot),
      req.body.status || 'offline', req.body.note || ''
    ]);
    flash(req, 'success', 'บันทึก VPS Node แล้ว');
    res.redirect('/admin/vps');
  } catch (error) { next(error); }
});

router.post('/admin/vps/nodes/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await query(`UPDATE vps_system.vps_nodes SET is_active=FALSE, status='disabled', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    flash(req, 'success', 'ปิดใช้งาน VPS Node แล้ว');
    res.redirect('/admin/vps');
  } catch (error) { next(error); }
});

router.post('/admin/vps/nodes/:id/ping', requireAdmin, async (req, res, next) => {
  try {
    const node = (await query(`SELECT * FROM vps_system.vps_nodes WHERE id=$1`, [req.params.id])).rows[0];
    if (!node) throw new Error('ไม่พบ VPS');
    const result = await agent.ping(node);
    await query(`UPDATE vps_system.vps_nodes SET last_error=$1, updated_at=NOW() WHERE id=$2`, [result.ok ? '' : (result.error || JSON.stringify(result)), node.id]);
    flash(req, result.ok ? 'success' : 'error', result.ok ? 'เชื่อมต่อ Agent สำเร็จ' : `Agent ไม่ตอบ: ${result.error || result.status}`);
    res.redirect('/admin/vps');
  } catch (error) { next(error); }
});

router.post('/admin/vps/bots', requireAdmin, async (req, res, next) => {
  try {
    await query(`
      INSERT INTO vps_system.bot_catalog
      (bot_code, bot_name, symbol, required_ports, default_lot, max_lot, preset_json, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
      ON CONFLICT (bot_code) DO UPDATE SET
        bot_name=EXCLUDED.bot_name, symbol=EXCLUDED.symbol, required_ports=EXCLUDED.required_ports,
        default_lot=EXCLUDED.default_lot, max_lot=EXCLUDED.max_lot, preset_json=EXCLUDED.preset_json, updated_at=NOW()
    `, [
      req.body.bot_code, req.body.bot_name, req.body.symbol || 'XAUUSD',
      safeNumber(req.body.required_ports, 1), safeNumber(req.body.default_lot, 0.01),
      safeNumber(req.body.max_lot, 0.01), req.body.preset_json || '{}'
    ]);
    flash(req, 'success', 'บันทึก Bot Catalog แล้ว');
    res.redirect('/admin/vps');
  } catch (error) { next(error); }
});

router.post('/admin/vps/instances/:id/stop', requireAdmin, async (req, res, next) => {
  try {
    await allocator.stopInstance(req.params.id);
    flash(req, 'success', 'สั่งหยุดบอทแล้ว');
    res.redirect('/admin/vps');
  } catch (error) { next(error); }
});

router.post('/admin/vps/intel', requireAdmin, async (req, res, next) => {
  try {
    await intelAi.generateIntelReport({ symbol: req.body.symbol || 'XAUUSD', technical: req.body.technical || '', news: req.body.news || '' });
    flash(req, 'success', 'สร้าง Intel Report แล้ว');
    res.redirect('/admin/vps');
  } catch (error) { next(error); }
});

router.post('/api/vps/heartbeat', async (req, res) => {
  const apiKey = req.get('x-api-key') || req.body.api_key || '';
  const nodeCode = req.body.node_code || req.body.nodeCode || '';
  const nodeRes = await query(`SELECT * FROM vps_system.vps_nodes WHERE node_code=$1 AND api_key=$2 AND is_active=TRUE`, [nodeCode, apiKey]);
  const node = nodeRes.rows[0];
  if (!node) return res.status(401).json({ ok: false, error: 'unauthorized' });

  await query(`
    UPDATE vps_system.vps_nodes
    SET status=$1, last_heartbeat=NOW(), last_error='', updated_at=NOW()
    WHERE id=$2
  `, [req.body.status || 'online', node.id]);
  await query(`INSERT INTO vps_system.heartbeat_logs (vps_id,status,payload) VALUES ($1,$2,$3)`, [node.id, req.body.status || 'online', req.body || {}]);
  return res.json({ ok: true });
});

router.get('/app/mt5', requireLogin, async (req, res, next) => {
  try {
    const user = req.user || req.session?.user;
    const userId = user?.id;
    const [accounts, bots, presets, instances, servers, limits] = await Promise.all([
      query(`SELECT * FROM vps_system.mt5_accounts WHERE user_id=$1 ORDER BY id DESC`, [userId]),
      query(`SELECT * FROM vps_system.bot_catalog WHERE is_active=TRUE ORDER BY id ASC`),
      query(`SELECT * FROM vps_system.lot_presets ORDER BY capital_recommend ASC`),
      query(`SELECT bi.*, bc.bot_name, bc.bot_code, ma.mt5_login, ma.server_name, vn.node_name, vn.node_code
             FROM vps_system.bot_instances bi
             LEFT JOIN vps_system.bot_catalog bc ON bc.id=bi.bot_id
             LEFT JOIN vps_system.mt5_accounts ma ON ma.id=bi.mt5_account_id
             LEFT JOIN vps_system.vps_nodes vn ON vn.id=bi.vps_id
             WHERE bi.user_id=$1
             ORDER BY bi.id DESC LIMIT 50`, [userId]),
      query(`SELECT * FROM vps_system.mt5_servers WHERE is_active=TRUE ORDER BY id ASC`),
      allocator.getPackageLimits(userId)
    ]);

    const success = req.session?.success || '';
    const error = req.session?.error || '';
    if (req.session) { req.session.success = ''; req.session.error = ''; }

    res.render('app/mt5', base(req, {
      pageTitle: 'MT5 Bot',
      currentPath: '/app/mt5',
      pageCss: '/public/css/vps-mt5.css',
      accounts: accounts.rows,
      bots: bots.rows,
      presets: presets.rows,
      instances: instances.rows,
      servers: servers.rows,
      limits,
      success,
      error
    }));
  } catch (error) { next(error); }
});

router.post('/app/mt5/accounts', requireLogin, async (req, res, next) => {
  try {
    const user = req.user || req.session?.user;
    await query(`
      INSERT INTO vps_system.mt5_accounts
      (user_id, mt5_login, mt5_password, broker, server_name, account_name, status)
      VALUES ($1,$2,$3,'MH Markets',$4,$5,'ready')
      ON CONFLICT (user_id, mt5_login, server_name) DO UPDATE SET
        mt5_password=EXCLUDED.mt5_password, account_name=EXCLUDED.account_name, updated_at=NOW()
    `, [user.id, req.body.mt5_login, req.body.mt5_password, req.body.server_name, req.body.account_name || '']);
    flash(req, 'success', 'บันทึกบัญชี MT5 แล้ว');
    res.redirect('/app/mt5');
  } catch (error) { next(error); }
});

router.post('/app/mt5/run', requireLogin, async (req, res, next) => {
  try {
    const user = req.user || req.session?.user;
    const result = await allocator.allocateAndRun({
      userId: user.id,
      mt5AccountId: req.body.mt5_account_id,
      botId: req.body.bot_id,
      presetId: req.body.preset_id || null
    });

    const runResult = await agent.runBot(result.node, result.payload);
    await query(`UPDATE vps_system.bot_instances SET last_agent_response=$1, last_error=$2, updated_at=NOW() WHERE id=$3`, [
      runResult,
      runResult.ok ? '' : (runResult.error || JSON.stringify(runResult)),
      result.instance.id
    ]);

    flash(req, runResult.ok || runResult.skipped ? 'success' : 'error',
      runResult.ok ? 'เริ่มรันบอทบน VPS แล้ว' :
      runResult.skipped ? 'บันทึกรายการรันแล้ว แต่ยังไม่ได้ตั้งค่า Agent API' :
      `บันทึกแล้ว แต่ Agent Error: ${runResult.error || runResult.status}`
    );
    res.redirect('/app/mt5');
  } catch (error) {
    flash(req, 'error', error.message);
    res.redirect('/app/mt5');
  }
});

router.post('/app/mt5/instances/:id/stop', requireLogin, async (req, res, next) => {
  try {
    const user = req.user || req.session?.user;
    await allocator.stopInstance(req.params.id, user.id);
    flash(req, 'success', 'หยุดบอทแล้ว');
    res.redirect('/app/mt5');
  } catch (error) {
    flash(req, 'error', error.message);
    res.redirect('/app/mt5');
  }
});

module.exports = router;
