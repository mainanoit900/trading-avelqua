CREATE SCHEMA IF NOT EXISTS vps_system;

CREATE TABLE IF NOT EXISTS vps_system.vps_nodes (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  node_code TEXT,
  agent_token TEXT UNIQUE NOT NULL,
  agent_version TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'offline',
  cpu_percent NUMERIC(8,2) DEFAULT 0,
  ram_percent NUMERIC(8,2) DEFAULT 0,
  ping_ms NUMERIC(10,2) DEFAULT 0,
  net_down_mbps NUMERIC(18,2) DEFAULT 0,
  net_up_mbps NUMERIC(18,2) DEFAULT 0,
  agent_enabled BOOLEAN DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  last_error TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vps_system.vps_ports (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  port_no INT NOT NULL,
  folder_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  disabled_at TIMESTAMPTZ,
  locked_by_user_id BIGINT,
  locked_until TIMESTAMPTZ,
  process_id INT,
  mt5_login TEXT,
  last_seen_at TIMESTAMPTZ,
  last_error TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vps_id, port_no)
);

CREATE INDEX IF NOT EXISTS idx_vps_ports_pick
ON vps_system.vps_ports(vps_id, status, port_no)
WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS vps_system.mt5_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  vps_id BIGINT REFERENCES vps_system.vps_nodes(id),
  port_id BIGINT REFERENCES vps_system.vps_ports(id),
  port_slot INT,
  mt5_login TEXT NOT NULL,
  mt5_password TEXT,
  broker TEXT DEFAULT 'MH Markets',
  server_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connecting',
  last_error TEXT DEFAULT '',
  connected_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mt5_accounts_user_status
ON vps_system.mt5_accounts(user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt5_active_login
ON vps_system.mt5_accounts(mt5_login, server_name)
WHERE status IN ('connecting','connected');

CREATE TABLE IF NOT EXISTS vps_system.vps_agent_commands (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  locked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  result_message TEXT DEFAULT '',
  result JSONB DEFAULT '{}'::jsonb,
  error TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_commands_next
ON vps_system.vps_agent_commands(vps_id, status, id);