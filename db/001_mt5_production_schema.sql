-- Avelqua MT5 Production Schema
-- ใช้กับ PostgreSQL
-- Run: psql -d trading_avelqua -f db/001_mt5_production_schema.sql

CREATE SCHEMA IF NOT EXISTS vps_system;

CREATE TABLE IF NOT EXISTS vps_system.vps_nodes (
  id BIGSERIAL PRIMARY KEY,
  node_code TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  agent_token TEXT NOT NULL,
  base_path TEXT NOT NULL DEFAULT 'C:\\MT5_PORTS',
  max_ports INT NOT NULL DEFAULT 20,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'offline',
  agent_version TEXT,
  last_seen_at TIMESTAMPTZ,
  cpu_percent NUMERIC(8,2),
  ram_percent NUMERIC(8,2),
  ping_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vps_system.vps_ports (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  port_no INT NOT NULL,
  port_name TEXT,
  folder_path TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'free', -- free|reserved|starting|connected|failed|stopping|disabled
  current_user_id BIGINT,
  current_mt5_login TEXT,
  current_server TEXT,
  process_pid INT,
  last_error TEXT,
  last_health_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vps_id, port_no)
);

CREATE TABLE IF NOT EXISTS vps_system.mt5_port_locks (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  port_no INT NOT NULL,
  user_id BIGINT NOT NULL,
  mt5_login TEXT NOT NULL,
  lock_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'locking', -- locking|released|expired
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 seconds',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vps_id, port_no, status) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mt5_login_active_lock
ON vps_system.mt5_port_locks(mt5_login)
WHERE status='locking';

CREATE TABLE IF NOT EXISTS vps_system.mt5_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  vps_id BIGINT REFERENCES vps_system.vps_nodes(id) ON DELETE SET NULL,
  port_no INT,
  mt5_login TEXT NOT NULL,
  mt5_server TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|starting|connected|failed|stopped|migrating
  last_message TEXT,
  last_login_message TEXT,
  process_pid INT,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mt5_accounts_user_active
ON vps_system.mt5_accounts(user_id)
WHERE status IN ('pending','starting','connected','migrating');

CREATE UNIQUE INDEX IF NOT EXISTS ux_mt5_accounts_login_active
ON vps_system.mt5_accounts(mt5_login)
WHERE status IN ('pending','starting','connected','migrating');

CREATE TABLE IF NOT EXISTS vps_system.vps_agent_commands (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL, -- login_mt5|stop_mt5|restart_ea|reconnect_mt5|health_check|migrate_out
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|cancelled
  priority INT NOT NULL DEFAULT 100,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_vps_agent_commands_poll
ON vps_system.vps_agent_commands(vps_id, status, run_after, priority, id);

CREATE TABLE IF NOT EXISTS vps_system.mt5_connect_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  vps_id BIGINT,
  port_no INT,
  mt5_login TEXT,
  mt5_server TEXT,
  event_type TEXT NOT NULL, -- queued|starting|connected|failed|stopped|health|migrated
  message TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_mt5_connect_events_user
ON vps_system.mt5_connect_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vps_system.mt5_port_health (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  port_no INT NOT NULL,
  running BOOLEAN NOT NULL DEFAULT FALSE,
  pid INT,
  mt5_login TEXT,
  folder_path TEXT,
  cpu_percent NUMERIC(8,2),
  ram_mb NUMERIC(10,2),
  terminal_age_sec INT,
  log_status TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_mt5_port_health_latest
ON vps_system.mt5_port_health(vps_id, port_no, created_at DESC);

CREATE TABLE IF NOT EXISTS vps_system.mt5_ea_watchdog (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  vps_id BIGINT,
  port_no INT,
  mt5_login TEXT,
  ea_name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown', -- running|stale|restarting|failed
  last_tick_at TIMESTAMPTZ,
  last_restart_at TIMESTAMPTZ,
  restart_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION vps_system.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname='vps_system'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_%I ON %I.%I', r.tablename, r.schemaname, r.tablename);
    EXECUTE format('CREATE TRIGGER trg_touch_%I BEFORE UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION vps_system.touch_updated_at()', r.tablename, r.schemaname, r.tablename);
  END LOOP;
END $$;
