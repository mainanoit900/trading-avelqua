const crypto = require('crypto');
const { query, getClient } = require('../config/database');

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function s(v) {
  return String(v || '').trim();
}

function apiKey() {
  return 'MT5-' + crypto.randomBytes(18).toString('hex').toUpperCase();
}

async function ensureMt5ControlTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS mt5_vps_nodes (
      id BIGSERIAL PRIMARY KEY,
      node_code VARCHAR(40) UNIQUE NOT NULL,
      node_name VARCHAR(120) NOT NULL,
      ip_address VARCHAR(120),
      api_base_url TEXT,
      api_key TEXT NOT NULL,
      os_type VARCHAR(30) DEFAULT 'windows',
      location_name VARCHAR(120),
      max_ports INTEGER DEFAULT 0 NOT NULL,
      max_lots NUMERIC(12,2) DEFAULT 0 NOT NULL,
      used_ports INTEGER DEFAULT 0 NOT NULL,
      used_lots NUMERIC(12,2) DEFAULT 0 NOT NULL,
      status VARCHAR(30) DEFAULT 'online' NOT NULL,
      last_ping_at TIMESTAMPTZ,
      last_error TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_broker_servers (
      id BIGSERIAL PRIMARY KEY,
      broker_name VARCHAR(120) DEFAULT 'MH Markets' NOT NULL,
      server_name VARCHAR(160) NOT NULL,
      status VARCHAR(30) DEFAULT 'active' NOT NULL,
      sort_order INTEGER DEFAULT 0 NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_bot_presets (
      id BIGSERIAL PRIMARY KEY,
      preset_name VARCHAR(120) NOT NULL,
      mode_key VARCHAR(40) DEFAULT 'safe' NOT NULL,
      recommended_capital NUMERIC(14,2) DEFAULT 0 NOT NULL,
      safe_capital NUMERIC(14,2) DEFAULT 0 NOT NULL,
      max_safe_capital NUMERIC(14,2) DEFAULT 0 NOT NULL,
      lot_size NUMERIC(10,2) DEFAULT 0 NOT NULL,
      lot_plus NUMERIC(10,2) DEFAULT 0 NOT NULL,
      t_start INTEGER DEFAULT 0 NOT NULL,
      t_stop INTEGER DEFAULT 0 NOT NULL,
      mid_t_start INTEGER,
      mid_t_stop INTEGER,
      fast_t_start INTEGER,
      fast_t_stop INTEGER,
      is_enabled BOOLEAN DEFAULT TRUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS package_mt5_limits (
      id BIGSERIAL PRIMARY KEY,
      package_id BIGINT UNIQUE,
      package_name_snapshot VARCHAR(200),
      max_ports INTEGER DEFAULT 1 NOT NULL,
      max_lots NUMERIC(12,2) DEFAULT 0.01 NOT NULL,
      max_bots INTEGER DEFAULT 1 NOT NULL,
      allowed_bot_modes TEXT[] DEFAULT ARRAY['safe']::TEXT[],
      is_enabled BOOLEAN DEFAULT TRUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_customer_accounts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      mt5_login VARCHAR(80) NOT NULL,
      mt5_password_enc TEXT,
      broker_server_id BIGINT REFERENCES mt5_broker_servers(id) ON DELETE SET NULL,
      broker_server_name VARCHAR(160),
      status VARCHAR(30) DEFAULT 'pending' NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_bot_deployments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      mt5_account_id BIGINT REFERENCES mt5_customer_accounts(id) ON DELETE SET NULL,
      package_id BIGINT,
      vps_node_id BIGINT REFERENCES mt5_vps_nodes(id) ON DELETE SET NULL,
      bot_preset_id BIGINT REFERENCES mt5_bot_presets(id) ON DELETE SET NULL,
      bot_name VARCHAR(160) NOT NULL,
      symbol VARCHAR(40) DEFAULT 'XAUUSD',
      ports_used INTEGER DEFAULT 1 NOT NULL,
      lots_used NUMERIC(12,2) DEFAULT 0.01 NOT NULL,
      status VARCHAR(30) DEFAULT 'queued' NOT NULL,
      started_at TIMESTAMPTZ,
      expired_at TIMESTAMPTZ,
      stopped_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      failover_from_id BIGINT,
      config_json JSONB DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_vps_events (
      id BIGSERIAL PRIMARY KEY,
      vps_node_id BIGINT REFERENCES mt5_vps_nodes(id) ON DELETE SET NULL,
      deployment_id BIGINT REFERENCES mt5_bot_deployments(id) ON DELETE SET NULL,
      event_type VARCHAR(60) NOT NULL,
      message TEXT,
      payload JSONB DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mt5_intel_reports (
      id BIGSERIAL PRIMARY KEY,
      symbol VARCHAR(40) DEFAULT 'XAUUSD' NOT NULL,
      timeframe VARCHAR(20) DEFAULT 'H1' NOT NULL,
      trend VARCHAR(20),
      buy_percent NUMERIC(6,2),
      sell_percent NUMERIC(6,2),
      report_text TEXT,
      source_json JSONB DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `);

  await query(`
    INSERT INTO mt5_broker_servers (broker_name, server_name, sort_order)
    SELECT 'MH Markets', x.server_name, x.sort_order
    FROM (VALUES
      ('MHMarkets-Live 1', 1),
      ('MHMarkets-Live 2', 2),
      ('MHMarkets-Live 3', 3)
    ) AS x(server_name, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM mt5_broker_servers b WHERE b.server_name = x.server_name);
  `);
}

async function seedDefaultPresets() {
  const rows = [
    [30,60,90,0.01,0.01,2,1,null,null,null,null],
    [60,120,180,0.02,0.02,4,2,null,null,null,null],
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
    [570,1140,1710,0.19,0.19,38,19,34,17,30,15]
  ];
  for (const r of rows) {
    await query(`
      INSERT INTO mt5_bot_presets (
        preset_name, mode_key, recommended_capital, safe_capital, max_safe_capital,
        lot_size, lot_plus, t_start, t_stop, mid_t_start, mid_t_stop, fast_t_start, fast_t_stop
      )
      SELECT $1,'safe',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      WHERE NOT EXISTS (
        SELECT 1 FROM mt5_bot_presets WHERE recommended_capital=$2 AND lot_size=$5
      )
    `, [`ทุน ${r[0]} / Lot ${r[3]}`, ...r]);
  }
}

async function getDashboardData() {
  await ensureMt5ControlTables();
  const [nodes, deployments, presets, brokers, packages, limits, accounts, events, reports] = await Promise.all([
    query(`SELECT *, GREATEST(max_ports - used_ports, 0) AS free_ports, GREATEST(max_lots - used_lots, 0) AS free_lots FROM mt5_vps_nodes ORDER BY status DESC, (max_ports-used_ports) ASC, node_name ASC`),
    query(`SELECT d.*, u.email, u.full_name, n.node_name, p.preset_name FROM mt5_bot_deployments d LEFT JOIN users u ON u.id=d.user_id LEFT JOIN mt5_vps_nodes n ON n.id=d.vps_node_id LEFT JOIN mt5_bot_presets p ON p.id=d.bot_preset_id ORDER BY d.updated_at DESC LIMIT 80`),
    query(`SELECT * FROM mt5_bot_presets ORDER BY recommended_capital ASC LIMIT 80`),
    query(`SELECT * FROM mt5_broker_servers ORDER BY sort_order ASC, id ASC`),
    query(`SELECT id, name, name_th, name_en, price FROM packages ORDER BY id ASC`).catch(() => ({ rows: [] })),
    query(`SELECT * FROM package_mt5_limits ORDER BY id ASC`),
    query(`SELECT a.*, u.email, u.full_name, b.server_name FROM mt5_customer_accounts a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN mt5_broker_servers b ON b.id=a.broker_server_id ORDER BY a.updated_at DESC LIMIT 80`),
    query(`SELECT e.*, n.node_name FROM mt5_vps_events e LEFT JOIN mt5_vps_nodes n ON n.id=e.vps_node_id ORDER BY e.created_at DESC LIMIT 60`),
    query(`SELECT * FROM mt5_intel_reports ORDER BY created_at DESC LIMIT 20`)
  ]);

  const summary = {
    nodes_total: nodes.rows.length,
    nodes_online: nodes.rows.filter(x => x.status === 'online').length,
    nodes_offline: nodes.rows.filter(x => ['offline','lost','maintenance'].includes(x.status)).length,
    deployments_running: deployments.rows.filter(x => x.status === 'running').length,
    total_ports_used: nodes.rows.reduce((sum, x) => sum + n(x.used_ports), 0),
    total_ports_max: nodes.rows.reduce((sum, x) => sum + n(x.max_ports), 0),
    total_lots_used: nodes.rows.reduce((sum, x) => sum + n(x.used_lots), 0),
    total_lots_max: nodes.rows.reduce((sum, x) => sum + n(x.max_lots), 0)
  };
  return { summary, nodes: nodes.rows, deployments: deployments.rows, presets: presets.rows, brokers: brokers.rows, packages: packages.rows, limits: limits.rows, accounts: accounts.rows, events: events.rows, reports: reports.rows };
}

async function createNode(body) {
  await ensureMt5ControlTables();
  const key = s(body.api_key) || apiKey();
  const code = s(body.node_code) || ('VPS' + Date.now().toString().slice(-6));
  await query(`INSERT INTO mt5_vps_nodes (node_code,node_name,ip_address,api_base_url,api_key,os_type,location_name,max_ports,max_lots,status,note,last_ping_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`, [code, s(body.node_name) || code, s(body.ip_address), s(body.api_base_url), key, s(body.os_type) || 'windows', s(body.location_name), n(body.max_ports), n(body.max_lots), s(body.status) || 'online', s(body.note)]);
}

async function updateNode(id, body) {
  await query(`UPDATE mt5_vps_nodes SET node_code=$2,node_name=$3,ip_address=$4,api_base_url=$5,api_key=$6,os_type=$7,location_name=$8,max_ports=$9,max_lots=$10,used_ports=$11,used_lots=$12,status=$13,last_error=$14,note=$15,updated_at=NOW() WHERE id=$1`, [id, s(body.node_code), s(body.node_name), s(body.ip_address), s(body.api_base_url), s(body.api_key), s(body.os_type), s(body.location_name), n(body.max_ports), n(body.max_lots), n(body.used_ports), n(body.used_lots), s(body.status) || 'online', s(body.last_error), s(body.note)]);
}

async function savePackageLimit(body) {
  const packageId = Number(body.package_id || 0) || null;
  let packageName = s(body.package_name_snapshot);
  if (packageId) {
    const p = await query(`SELECT COALESCE(name_th,name_en,name) AS name FROM packages WHERE id=$1`, [packageId]).catch(() => ({ rows: [] }));
    packageName = (p.rows[0] && p.rows[0].name) || packageName;
  }
  const modes = Array.isArray(body.allowed_bot_modes) ? body.allowed_bot_modes : String(body.allowed_bot_modes || 'safe').split(',');
  await query(`
    INSERT INTO package_mt5_limits (package_id, package_name_snapshot, max_ports, max_lots, max_bots, allowed_bot_modes, is_enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (package_id) DO UPDATE SET package_name_snapshot=EXCLUDED.package_name_snapshot,max_ports=EXCLUDED.max_ports,max_lots=EXCLUDED.max_lots,max_bots=EXCLUDED.max_bots,allowed_bot_modes=EXCLUDED.allowed_bot_modes,is_enabled=EXCLUDED.is_enabled,updated_at=NOW()
  `, [packageId, packageName, n(body.max_ports, 1), n(body.max_lots, 0.01), n(body.max_bots, 1), modes.map(s).filter(Boolean), String(body.is_enabled || '1') === '1']);
}

async function allocateBestNode(requiredPorts, requiredLots) {
  const result = await query(`
    SELECT * FROM mt5_vps_nodes
    WHERE status='online'
      AND (max_ports - used_ports) >= $1
      AND (max_lots - used_lots) >= $2
    ORDER BY (max_ports - used_ports) ASC, (max_lots - used_lots) ASC, id ASC
    LIMIT 1
  `, [n(requiredPorts, 1), n(requiredLots, 0.01)]);
  return result.rows[0] || null;
}

async function markLostNodesAndFailover() {
  await ensureMt5ControlTables();
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lost = await client.query(`UPDATE mt5_vps_nodes SET status='lost', last_error='ขาดการเชื่อมต่อเกิน 2 นาที', updated_at=NOW() WHERE status='online' AND last_ping_at IS NOT NULL AND last_ping_at < NOW() - INTERVAL '2 minutes' RETURNING *`);
    for (const node of lost.rows) {
      await client.query(`INSERT INTO mt5_vps_events (vps_node_id,event_type,message) VALUES ($1,'node_lost','VPS ขาดการเชื่อมต่อเกิน 2 นาที ระบบจะรอจัดสรรใหม่')`, [node.id]);
      const runs = await client.query(`SELECT * FROM mt5_bot_deployments WHERE vps_node_id=$1 AND status='running'`, [node.id]);
      for (const d of runs.rows) {
        const next = await client.query(`SELECT * FROM mt5_vps_nodes WHERE status='online' AND id<>$3 AND (max_ports-used_ports)>=$1 AND (max_lots-used_lots)>=$2 ORDER BY (max_ports-used_ports) ASC, (max_lots-used_lots) ASC LIMIT 1`, [d.ports_used, d.lots_used, node.id]);
        if (next.rows[0]) {
          await client.query(`UPDATE mt5_bot_deployments SET vps_node_id=$1, failover_from_id=$2, status='running', updated_at=NOW() WHERE id=$3`, [next.rows[0].id, node.id, d.id]);
          await client.query(`UPDATE mt5_vps_nodes SET used_ports=used_ports+$1, used_lots=used_lots+$2, updated_at=NOW() WHERE id=$3`, [d.ports_used, d.lots_used, next.rows[0].id]);
          await client.query(`INSERT INTO mt5_vps_events (vps_node_id,deployment_id,event_type,message) VALUES ($1,$2,'failover','ย้ายบอทไป VPS ใหม่อัตโนมัติ')`, [next.rows[0].id, d.id]);
        } else {
          await client.query(`UPDATE mt5_bot_deployments SET status='waiting_vps', updated_at=NOW() WHERE id=$1`, [d.id]);
          await client.query(`INSERT INTO mt5_vps_events (vps_node_id,deployment_id,event_type,message) VALUES ($1,$2,'failover_waiting','ยังไม่มี VPS ว่างตาม Port/Lot ที่ต้องใช้')`, [node.id, d.id]);
        }
      }
    }
    await client.query('COMMIT');
    return lost.rows.length;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { ensureMt5ControlTables, seedDefaultPresets, getDashboardData, createNode, updateNode, savePackageLimit, allocateBestNode, markLostNodesAndFailover };
