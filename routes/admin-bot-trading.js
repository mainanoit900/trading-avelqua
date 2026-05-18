const express = require('express');
const requireAdmin = require('../middleware/admin');
const { query } = require('../config/database');

const router = express.Router();

function clearFlash(req) {
  const out = { success: req.session?.success || '', error: req.session?.error || '' };
  if (req.session) { req.session.success = ''; req.session.error = ''; }
  return out;
}

function baseView(req, extra = {}) {
  const t = req.t || ((k, f) => f || k);
  return {
    t,
    lang: req.lang || req.session?.lang || 'th',
    localeLabels: req.res?.locals?.localeLabels || {},
    clientLocales: req.res?.locals?.clientLocales || {},
    user: req.user || req.session?.user || null,
    currentUser: req.user || req.session?.user || null,
    currentPath: '/admin/bot-trading',
    pageTitle: 'Admin Bot Trading',
    pageCss: 'admin-bot-trading.css',
    ...clearFlash(req),
    ...extra
  };
}

async function safeQuery(sql, params = [], fallback = []) {
  try {
    const r = await query(sql, params);
    return r.rows || [];
  } catch (err) {
    console.error('admin bot trading query skipped:', err.message);
    return fallback;
  }
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      id BIGINT PRIMARY KEY DEFAULT 1,
      default_symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      default_lot NUMERIC(10,2) NOT NULL DEFAULT 0.01,
      max_lot_per_user NUMERIC(10,2) NOT NULL DEFAULT 0.10,
      max_ports_per_user INTEGER NOT NULL DEFAULT 1,
      risk_mode TEXT NOT NULL DEFAULT 'safe',
      allow_user_custom_lot BOOLEAN NOT NULL DEFAULT FALSE,
      allow_user_custom_symbol BOOLEAN NOT NULL DEFAULT FALSE,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS agent_commands (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT REFERENCES vps_nodes(id) ON DELETE SET NULL,
      bot_session_id BIGINT REFERENCES bot_sessions(id) ON DELETE SET NULL,
      command_type TEXT NOT NULL,
      command_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      result_message TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      picked_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_metrics (
      id BIGSERIAL PRIMARY KEY,
      bot_session_id BIGINT REFERENCES bot_sessions(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      balance NUMERIC(18,2) NOT NULL DEFAULT 0,
      equity NUMERIC(18,2) NOT NULL DEFAULT 0,
      profit NUMERIC(18,2) NOT NULL DEFAULT 0,
      drawdown_percent NUMERIC(10,2) NOT NULL DEFAULT 0,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS trade_results (
      id BIGSERIAL PRIMARY KEY,
      bot_session_id BIGINT REFERENCES bot_sessions(id) ON DELETE SET NULL,
      symbol TEXT NOT NULL DEFAULT 'XAUUSD',
      profit NUMERIC(18,2) NOT NULL DEFAULT 0,
      result_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

router.get('/bot-trading', requireAdmin, async (req, res, next) => {
  try {
    await ensureTables();

    const [settingsRows, nodes, sessions, commands, logs, metrics, trades, packages] = await Promise.all([
      safeQuery(`SELECT * FROM bot_settings WHERE id=1 LIMIT 1`, [], [{}]),
      safeQuery(`SELECT * FROM vps_nodes ORDER BY status ASC, node_name ASC`),
      safeQuery(`
        SELECT bs.*, u.email, u.full_name, ba.broker_name, ba.account_login, ba.server_name, vn.node_name
        FROM bot_sessions bs
        LEFT JOIN users u ON u.id=bs.user_id
        LEFT JOIN user_broker_accounts ba ON ba.id=bs.broker_account_id
        LEFT JOIN vps_nodes vn ON vn.id=bs.node_id
        ORDER BY bs.updated_at DESC LIMIT 100
      `),
      safeQuery(`
        SELECT ac.*, vn.node_name, bs.session_code
        FROM agent_commands ac
        LEFT JOIN vps_nodes vn ON vn.id=ac.node_id
        LEFT JOIN bot_sessions bs ON bs.id=ac.bot_session_id
        ORDER BY ac.created_at DESC LIMIT 80
      `),
      safeQuery(`
        SELECT bl.*, bs.session_code
        FROM bot_logs bl
        LEFT JOIN bot_sessions bs ON bs.id=bl.bot_session_id
        ORDER BY bl.created_at DESC LIMIT 80
      `),
      safeQuery(`
        SELECT bm.*, bs.session_code
        FROM bot_metrics bm
        LEFT JOIN bot_sessions bs ON bs.id=bm.bot_session_id
        ORDER BY bm.created_at DESC LIMIT 50
      `),
      safeQuery(`
        SELECT result_date, SUM(profit)::numeric AS profit, COUNT(*)::int AS trades
        FROM trade_results
        GROUP BY result_date
        ORDER BY result_date DESC LIMIT 31
      `),
      safeQuery(`SELECT * FROM packages ORDER BY price ASC LIMIT 20`)
    ]);

    const summary = {
      totalNodes: nodes.length,
      onlineNodes: nodes.filter(n => n.status === 'available').length,
      totalPorts: nodes.reduce((a,n)=>a+Number(n.max_ports||0),0),
      usedPorts: nodes.reduce((a,n)=>a+Number(n.used_ports||0),0),
      totalLot: nodes.reduce((a,n)=>a+Number(n.max_lot||0),0),
      usedLot: nodes.reduce((a,n)=>a+Number(n.used_lot||0),0),
      runningBots: sessions.filter(s => s.status === 'running').length,
      stoppedBots: sessions.filter(s => s.status === 'stopped').length,
      errorBots: sessions.filter(s => s.status === 'error').length,
      profitToday: trades.find(t => String(t.result_date).slice(0,10) === new Date().toISOString().slice(0,10))?.profit || 0,
      profitMonth: trades.reduce((a,t)=>a+Number(t.profit||0),0)
    };

    res.render('admin/bot-trading', baseView(req, {
      settings: settingsRows[0] || {},
      nodes,
      sessions,
      commands,
      logs,
      metrics,
      trades,
      packages,
      summary
    }));
  } catch (error) { next(error); }
});

router.post('/bot-trading/settings', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    await query(`
      INSERT INTO bot_settings
      (id, default_symbol, default_lot, max_lot_per_user, max_ports_per_user, risk_mode, allow_user_custom_lot, allow_user_custom_symbol, is_enabled, admin_note, updated_at)
      VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (id) DO UPDATE SET
        default_symbol=EXCLUDED.default_symbol,
        default_lot=EXCLUDED.default_lot,
        max_lot_per_user=EXCLUDED.max_lot_per_user,
        max_ports_per_user=EXCLUDED.max_ports_per_user,
        risk_mode=EXCLUDED.risk_mode,
        allow_user_custom_lot=EXCLUDED.allow_user_custom_lot,
        allow_user_custom_symbol=EXCLUDED.allow_user_custom_symbol,
        is_enabled=EXCLUDED.is_enabled,
        admin_note=EXCLUDED.admin_note,
        updated_at=NOW()
    `, [
      String(req.body.default_symbol || 'XAUUSD').trim().toUpperCase(),
      Number(req.body.default_lot || 0.01),
      Number(req.body.max_lot_per_user || 0.10),
      Number(req.body.max_ports_per_user || 1),
      String(req.body.risk_mode || 'safe'),
      !!req.body.allow_user_custom_lot,
      !!req.body.allow_user_custom_symbol,
      !!req.body.is_enabled,
      String(req.body.admin_note || '')
    ]);
    req.session.success = 'บันทึกตั้งค่าบอทเรียบร้อยแล้ว';
  } catch (e) {
    req.session.error = 'บันทึกไม่สำเร็จ: ' + e.message;
  }
  res.redirect('/admin/bot-trading');
});

router.post('/bot-trading/nodes/:id/command', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const command = String(req.body.command || '').trim();
    const allowed = ['health_check','start_mt5','restart_mt5','run_bot','stop_bot','sync_mt5'];
    if (!allowed.includes(command)) throw new Error('command ไม่ถูกต้อง');
    await query(`INSERT INTO agent_commands (node_id, command_type, command_payload) VALUES ($1,$2,$3)`, [
      req.params.id,
      command,
      { source: 'admin_bot_trading', created_by: 'admin' }
    ]);
    req.session.success = `ส่งคำสั่ง ${command} เข้า Agent Commands แล้ว`;
  } catch (e) {
    req.session.error = 'ส่งคำสั่งไม่สำเร็จ: ' + e.message;
  }
  res.redirect('/admin/bot-trading#agent-commands');
});

router.post('/bot-trading/sessions/:id/action', requireAdmin, async (req, res) => {
  try {
    await ensureTables();
    const action = String(req.body.action || '').trim();
    const map = { play: 'run_bot', stop: 'stop_bot', restart: 'restart_mt5', sync: 'sync_mt5' };
    const command = map[action];
    if (!command) throw new Error('action ไม่ถูกต้อง');
    const session = (await query(`SELECT * FROM bot_sessions WHERE id=$1`, [req.params.id])).rows[0];
    if (!session) throw new Error('ไม่พบ session');
    await query(`INSERT INTO agent_commands (node_id, bot_session_id, command_type, command_payload) VALUES ($1,$2,$3,$4)`, [
      session.node_id || null,
      session.id,
      command,
      { source: 'admin_bot_trading', action, session_code: session.session_code }
    ]);
    const nextStatus = action === 'play' ? 'deploying' : (action === 'stop' ? 'stopped' : session.status);
    await query(`UPDATE bot_sessions SET status=$2, updated_at=NOW() WHERE id=$1`, [session.id, nextStatus]);
    req.session.success = `ส่งคำสั่ง ${command} ให้ Session ${session.session_code} แล้ว`;
  } catch (e) {
    req.session.error = 'สั่งงาน Session ไม่สำเร็จ: ' + e.message;
  }
  res.redirect('/admin/bot-trading#sessions');
});

module.exports = router;
