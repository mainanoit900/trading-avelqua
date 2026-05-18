-- 030_mt5_pro_core_startupini.sql
-- PRO Core: Web -> Queue -> Windows VPS Python Agent -> MT5 startup.ini
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
  status TEXT NOT NULL DEFAULT 'available', -- available|reserved|starting|running|failed|disabled|stopped
  disabled_at TIMESTAMPTZ,
  locked_by_user_id BIGINT,
  locked_until TIMESTAMPTZ,
  process_id INT,
  mt5_login TEXT,
  server_name TEXT,
  last_seen_at TIMESTAMPTZ,
  last_error TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vps_id, port_no)
);

CREATE INDEX IF NOT EXISTS idx_vps_ports_pick ON vps_system.vps_ports(vps_id, status, port_no) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_vps_ports_locked_until ON vps_system.vps_ports(locked_until);

CREATE TABLE IF NOT EXISTS vps_system.mt5_accounts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  vps_id BIGINT REFERENCES vps_system.vps_nodes(id),
  port_id BIGINT REFERENCES vps_system.vps_ports(id),
  port_slot INT,
  assigned_port_no INT,
  mt5_login TEXT NOT NULL,
  mt5_password TEXT,
  broker TEXT DEFAULT 'MT5',
  server_name TEXT NOT NULL,
  account_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connecting', -- connecting|connected|failed|stopped
  last_error TEXT DEFAULT '',
  last_login_message TEXT DEFAULT '',
  last_balance NUMERIC(18,2),
  last_equity NUMERIC(18,2),
  connected_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mt5_accounts_user_status ON vps_system.mt5_accounts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_mt5_accounts_login_status ON vps_system.mt5_accounts(mt5_login, server_name, status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mt5_active_login_pro
ON vps_system.mt5_accounts(mt5_login, server_name)
WHERE status IN ('connecting','connected');

CREATE TABLE IF NOT EXISTS vps_system.vps_port_locks (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL,
  port_no INT NOT NULL,
  port_id BIGINT,
  user_id BIGINT NOT NULL,
  mt5_login TEXT NOT NULL,
  server_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'locking', -- locking|connected|failed|released
  command_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vps_id, port_no, status) DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS idx_vps_port_locks_active ON vps_system.vps_port_locks(vps_id, port_no, status);
CREATE INDEX IF NOT EXISTS idx_vps_port_locks_login ON vps_system.vps_port_locks(mt5_login, server_name, status);

CREATE TABLE IF NOT EXISTS vps_system.vps_agent_commands (
  id BIGSERIAL PRIMARY KEY,
  vps_id BIGINT NOT NULL REFERENCES vps_system.vps_nodes(id) ON DELETE CASCADE,
  port_id BIGINT,
  command_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|picked|running|done|failed
  locked_at TIMESTAMPTZ,
  picked_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  result_message TEXT DEFAULT '',
  result JSONB DEFAULT '{}'::jsonb,
  error TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vps_agent_commands_next ON vps_system.vps_agent_commands(vps_id, status, id);

-- Optional seed: แก้ token/folder ให้ตรง VPS จริงก่อนใช้ production
INSERT INTO vps_system.vps_nodes (name, node_code, agent_token, status)
SELECT 'VPS-WIN-01', 'VPS-WIN-01', 'avelqua-vps-2026', 'offline'
WHERE NOT EXISTS (SELECT 1 FROM vps_system.vps_nodes WHERE agent_token='avelqua-vps-2026');

INSERT INTO vps_system.vps_ports (vps_id, port_no, folder_path, status)
SELECT n.id, gs, 'C:\\MT5_PORTS\\PORT_' || LPAD(gs::text, 2, '0'), 'available'
FROM vps_system.vps_nodes n
CROSS JOIN generate_series(1,6) gs
WHERE n.agent_token='avelqua-vps-2026'
ON CONFLICT (vps_id, port_no) DO NOTHING;
