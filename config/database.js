require('dotenv').config();

const { Pool } = require('pg');

function getEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

const dbConfig = {
  host: getEnv('DB_HOST', 'PGHOST') || '127.0.0.1',
  port: Number(getEnv('DB_PORT', 'PGPORT') || 5432),
  database: getEnv('DB_NAME', 'PGDATABASE') || 'trading_avelqua',
  user: getEnv('DB_USER', 'PGUSER') || 'trading_user',
  password: String(getEnv('DB_PASS', 'DB_PASSWORD', 'PGPASSWORD') || ''),
  max: Number(getEnv('DB_POOL_MAX') || 20),
  idleTimeoutMillis: Number(getEnv('DB_IDLE_TIMEOUT_MS') || 30000),
  connectionTimeoutMillis: Number(getEnv('DB_CONNECTION_TIMEOUT_MS') || 5000),
  ssl: /^true$/i.test(getEnv('DB_SSL')) ? { rejectUnauthorized: false } : false
};

if (!dbConfig.password) {
  console.error('[database] Missing DB password. Set DB_PASS in .env');
}

const pool = new Pool(dbConfig);

pool.on('error', (error) => {
  console.error('[database] Unexpected PostgreSQL pool error:', error);
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function getClient() {
  return pool.connect();
}

async function testConnection() {
  const result = await pool.query('SELECT NOW() AS now');
  return result.rows[0];
}

/**
 * ซ่อมลำดับ BIGSERIAL เมื่อ MAX(id) > nextval (มักเกิดหลัง restore/migrate)
 * แก้ error: duplicate key value violates unique constraint "vps_agent_commands_pkey"
 */
async function repairVpsAgentCommandSequences() {
  await pool
    .query(
      `
    DO $repair$
    DECLARE
      seq text;
      mx bigint;
    BEGIN
      IF to_regclass('vps_system.vps_agent_commands') IS NOT NULL THEN
        seq := pg_get_serial_sequence('vps_system.vps_agent_commands', 'id');
        IF seq IS NOT NULL THEN
          SELECT COALESCE(MAX(id), 1) INTO mx FROM vps_system.vps_agent_commands;
          PERFORM setval(seq::regclass, mx, true);
        END IF;
      END IF;
      IF to_regclass('public.vps_agent_commands') IS NOT NULL THEN
        seq := pg_get_serial_sequence('public.vps_agent_commands', 'id');
        IF seq IS NOT NULL THEN
          SELECT COALESCE(MAX(id), 1) INTO mx FROM public.vps_agent_commands;
          PERFORM setval(seq::regclass, mx, true);
        END IF;
      END IF;
    END
    $repair$;
  `
    )
    .catch((err) => {
      console.warn('[database] repairVpsAgentCommandSequences:', err.message);
    });
}

module.exports = {
  pool,
  query,
  getClient,
  testConnection,
  repairVpsAgentCommandSequences,
  dbConfig
};