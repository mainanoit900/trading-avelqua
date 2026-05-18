CREATE SCHEMA IF NOT EXISTS vps_system;

ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS node_code TEXT;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS agent_token TEXT;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'offline';
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS cpu_percent NUMERIC(8,2) DEFAULT 0;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS ram_percent NUMERIC(8,2) DEFAULT 0;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS net_down_mbps NUMERIC(18,2) DEFAULT 0;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS net_up_mbps NUMERIC(18,2) DEFAULT 0;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS ping_ms NUMERIC(10,2) DEFAULT 0;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS vps_id BIGINT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS port_no INT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS folder_path TEXT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available';
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS locked_by_user_id BIGINT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS process_id BIGINT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS last_pid BIGINT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS mt5_login TEXT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS current_mt5_login TEXT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS vps_id BIGINT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_id BIGINT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_slot INT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS assigned_port_no INT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS windows_port_no INT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_login_message TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance NUMERIC;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity NUMERIC;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS vps_system.vps_agent_commands (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT,
  node_id BIGINT,
  port_id BIGINT,
  command_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'pending',
  result JSONB DEFAULT '{}'::jsonb,
  result_message TEXT,
  error TEXT,
  picked_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vps_system.vps_port_health (
  id BIGSERIAL PRIMARY KEY,
  node_id BIGINT,
  port_number INT,
  folder_path TEXT,
  running BOOLEAN DEFAULT FALSE,
  process_id BIGINT,
  mt5_login TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(node_id, port_number)
);

CREATE TABLE IF NOT EXISTS vps_system.vps_node_logs (
  id BIGSERIAL PRIMARY KEY,
  node_id BIGINT,
  status TEXT,
  level TEXT DEFAULT 'normal',
  cpu_percent NUMERIC(8,2) DEFAULT 0,
  ram_percent NUMERIC(8,2) DEFAULT 0,
  net_down_mbps NUMERIC(18,2) DEFAULT 0,
  net_up_mbps NUMERIC(18,2) DEFAULT 0,
  ping_ms NUMERIC(10,2) DEFAULT 0,
  last_error TEXT DEFAULT '',
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vps_system.mt5_login_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  account_id BIGINT,
  vps_id BIGINT,
  port_id BIGINT,
  port_no INT,
  mt5_login TEXT,
  server_name TEXT,
  status TEXT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vps_ports_pick ON vps_system.vps_ports(vps_id, status, port_no);
CREATE INDEX IF NOT EXISTS idx_vps_agent_commands_pick ON vps_system.vps_agent_commands(status, node_id, vps_id, id);
CREATE INDEX IF NOT EXISTS idx_mt5_accounts_running ON vps_system.mt5_accounts(mt5_login, server_name, status);
