const { query, getClient } = require('../config/database');
const { runSchemaOnce } = require('../lib/schemaOnce');

const DEFAULT_BOT_SETTINGS = {
  default_symbol: 'XAUUSD',
  default_lot: 0.01,
  max_lot_per_user: 0.10,
  max_ports_per_user: 1,
  risk_mode: 'standard',
  allow_user_custom_lot: false,
  allow_user_custom_symbol: false,
  is_enabled: true,
  admin_note: ''
};

function cleanNodeId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function ensureAgentTablesCore() {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_commands (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT NULL,
      bot_session_id BIGINT NULL,
      command_type VARCHAR(80) NOT NULL,
      command_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      result_message TEXT,
      picked_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS node_id BIGINT NULL`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS bot_session_id BIGINT NULL`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS command_type VARCHAR(80)`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS command_payload JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'pending'`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS result_message TEXT`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await query(`ALTER TABLE agent_commands ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_commands_status_created ON agent_commands(status, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_commands_node_status ON agent_commands(node_id, status, created_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_commands_session ON agent_commands(bot_session_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS vps_bot_settings (
      id INT PRIMARY KEY DEFAULT 1,
      default_symbol VARCHAR(30) NOT NULL DEFAULT 'XAUUSD',
      default_lot NUMERIC(12,4) NOT NULL DEFAULT 0.01,
      max_lot_per_user NUMERIC(12,4) NOT NULL DEFAULT 0.10,
      max_ports_per_user INT NOT NULL DEFAULT 1,
      risk_mode VARCHAR(30) NOT NULL DEFAULT 'standard',
      allow_user_custom_lot BOOLEAN NOT NULL DEFAULT FALSE,
      allow_user_custom_symbol BOOLEAN NOT NULL DEFAULT FALSE,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT vps_bot_settings_single_row CHECK (id = 1)
    )
  `);

  await query(`INSERT INTO vps_bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await query(`
    CREATE TABLE IF NOT EXISTS vps_agent_logs (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT NULL,
      bot_session_id BIGINT NULL,
      session_code VARCHAR(120),
      level_name VARCHAR(30) NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_vps_agent_logs_created ON vps_agent_logs(created_at DESC)`);
}

function ensureAgentTables() {
  return runSchemaOnce('legacy-agent-tables', ensureAgentTablesCore);
}

async function getBotSettings() {
  await ensureAgentTables();
  const result = await query(`SELECT * FROM vps_bot_settings WHERE id = 1 LIMIT 1`);
  return result.rows[0] || DEFAULT_BOT_SETTINGS;
}

async function saveBotSettings(settings) {
  await ensureAgentTables();
  const merged = { ...DEFAULT_BOT_SETTINGS, ...(settings || {}) };
  const result = await query(
    `UPDATE vps_bot_settings
     SET default_symbol = $1,
         default_lot = $2,
         max_lot_per_user = $3,
         max_ports_per_user = $4,
         risk_mode = $5,
         allow_user_custom_lot = $6,
         allow_user_custom_symbol = $7,
         is_enabled = $8,
         admin_note = $9,
         updated_at = NOW()
     WHERE id = 1
     RETURNING *`,
    [
      String(merged.default_symbol || 'XAUUSD').trim().toUpperCase(),
      Number(merged.default_lot || 0.01),
      Number(merged.max_lot_per_user || 0.10),
      Number(merged.max_ports_per_user || 1),
      String(merged.risk_mode || 'standard').trim(),
      !!merged.allow_user_custom_lot,
      !!merged.allow_user_custom_symbol,
      merged.is_enabled !== false,
      String(merged.admin_note || '').trim()
    ]
  );
  return result.rows[0];
}

async function createCommand({ nodeId = null, botSessionId = null, commandType, payload = {} }) {
  await ensureAgentTables();
  if (!commandType) throw new Error('commandType is required');

  return query(
    `INSERT INTO agent_commands (
       node_id,
       bot_session_id,
       command_type,
       command_payload,
       status,
       created_at,
       updated_at
     )
     VALUES ($1,$2,$3,$4::jsonb,'pending',NOW(),NOW())
     RETURNING *`,
    [cleanNodeId(nodeId), cleanNodeId(botSessionId), commandType, JSON.stringify(payload || {})]
  );
}

async function listRecentCommands(limit = 100) {
  await ensureAgentTables();
  return query(
    `SELECT
       ac.*,
       vn.node_name,
       bs.session_code
     FROM agent_commands ac
     LEFT JOIN vps_nodes vn ON vn.id = ac.node_id
     LEFT JOIN bot_sessions bs ON bs.id = ac.bot_session_id
     ORDER BY ac.created_at DESC
     LIMIT $1`,
    [Number(limit || 100)]
  );
}

async function resolveNodeId({ nodeId = null, nodeName = '' } = {}) {
  const id = cleanNodeId(nodeId);
  if (id) return id;
  const name = String(nodeName || '').trim();
  if (!name) return null;
  const result = await query(`SELECT id FROM vps_nodes WHERE node_name = $1 LIMIT 1`, [name]);
  return result.rows[0]?.id || null;
}

async function pickPendingCommands({ limit = 20, nodeId = null, nodeName = '' } = {}) {
  await ensureAgentTables();
  const resolvedNodeId = await resolveNodeId({ nodeId, nodeName });
  const client = await getClient();

  try {
    await client.query('BEGIN');

    const params = [Number(limit || 20)];
    let nodeWhere = '';

    // ถ้า Agent ส่ง node_id หรือ node_name มา จะรับเฉพาะคำสั่งของเครื่องตัวเอง + คำสั่งกลาง node_id NULL
    // ถ้า Agent เก่าไม่ส่งอะไรมา จะรับ pending ทั้งหมด เพื่อไม่ให้ระบบเดิมพัง
    if (resolvedNodeId) {
      params.push(resolvedNodeId);
      nodeWhere = `AND (node_id = $2 OR node_id IS NULL)`;
    }

    const result = await client.query(
      `SELECT
         id,
         node_id,
         bot_session_id,
         command_type AS command,
         command_payload AS payload,
         status,
         created_at,
         updated_at
       FROM agent_commands
       WHERE status = 'pending'
       ${nodeWhere}
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      params
    );

    const ids = result.rows.map(row => row.id);
    if (ids.length) {
      await client.query(
        `UPDATE agent_commands
         SET status = 'picked', picked_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::bigint[])`,
        [ids]
      );
    }

    if (resolvedNodeId) {
      await client.query(
        `UPDATE vps_nodes
         SET status = CASE WHEN status = 'offline' THEN 'available' ELSE status END,
             last_check_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [resolvedNodeId]
      ).catch(() => null);
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function finishCommand({ id, ok = true, result = {} }) {
  await ensureAgentTables();
  const status = ok ? 'success' : 'failed';
  const done = await query(
    `UPDATE agent_commands
     SET status = $2,
         result_message = $3,
         finished_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status, JSON.stringify(result || {})]
  );

  const row = done.rows[0];
  if (row?.bot_session_id && row.command_type) {
    let nextStatus = null;
    if (row.command_type === 'run_bot') nextStatus = ok ? 'running' : 'error';
    if (row.command_type === 'stop_bot') nextStatus = ok ? 'stopped' : 'error';
    if (row.command_type === 'restart_mt5') nextStatus = ok ? 'running' : 'error';
    if (nextStatus) {
      await query(`UPDATE bot_sessions SET status = $2, updated_at = NOW() WHERE id = $1`, [row.bot_session_id, nextStatus]).catch(() => null);
    }
  }

  return done;
}

async function addAgentLog({ nodeId = null, botSessionId = null, sessionCode = '', levelName = 'info', message = '', payload = {} }) {
  await ensureAgentTables();
  return query(
    `INSERT INTO vps_agent_logs (node_id, bot_session_id, session_code, level_name, message, payload_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())`,
    [cleanNodeId(nodeId), cleanNodeId(botSessionId), String(sessionCode || ''), String(levelName || 'info'), String(message || ''), JSON.stringify(payload || {})]
  );
}

async function listRecentLogs(limit = 100) {
  await ensureAgentTables();
  const queries = [
    `SELECT
       bl.*,
       bs.session_code,
       COALESCE(bl.level_name, bl.level, 'info') AS level_name,
       COALESCE(bl.message, bl.log_message, bl.detail, '') AS message
     FROM bot_logs bl
     LEFT JOIN bot_sessions bs ON bs.id = bl.bot_session_id
     ORDER BY bl.created_at DESC
     LIMIT $1`,
    `SELECT
       id,
       bot_session_id,
       session_code,
       level_name,
       message,
       created_at
     FROM vps_agent_logs
     ORDER BY created_at DESC
     LIMIT $1`
  ];

  for (const sql of queries) {
    try {
      return await query(sql, [Number(limit || 100)]);
    } catch (_) {
      // try next source
    }
  }

  return { rows: [] };
}

module.exports = {
  ensureAgentTables,
  getBotSettings,
  saveBotSettings,
  createCommand,
  listRecentCommands,
  pickPendingCommands,
  finishCommand,
  addAgentLog,
  listRecentLogs
};
