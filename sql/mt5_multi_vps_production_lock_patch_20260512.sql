-- Avelqua MT5 Multi VPS / Multi Port Production Lock Patch
-- Run:
--   sudo -u postgres psql -d trading_avelqua -f /root/trading-avelqua/sql/mt5_multi_vps_production_lock_patch_20260512.sql

CREATE SCHEMA IF NOT EXISTS vps_system;

-- VPS node runtime fields
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

-- Port runtime fields: key concept = vps_id + port_no ห้ามซ้ำกัน
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

CREATE UNIQUE INDEX IF NOT EXISTS ux_vps_ports_vps_port_no
ON vps_system.vps_ports(vps_id, port_no)
WHERE vps_id IS NOT NULL AND port_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vps_ports_atomic_pick
ON vps_system.vps_ports(vps_id, status, port_no)
WHERE COALESCE(status,'available') IN ('available','free','idle');

CREATE INDEX IF NOT EXISTS idx_vps_ports_locked_until
ON vps_system.vps_ports(locked_until)
WHERE locked_until IS NOT NULL;

-- MT5 account runtime fields
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS vps_id BIGINT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_id BIGINT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS port_slot INT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS assigned_port_no INT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS windows_port_no INT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_password TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS server_name TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS broker TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS account_name TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_login_message TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_balance NUMERIC;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_equity NUMERIC;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ใช้กับ ON CONFLICT (user_id, mt5_login, server_name)
CREATE INDEX IF NOT EXISTS idx_mt5_accounts_user_login_server
ON vps_system.mt5_accounts(user_id, mt5_login, server_name)
WHERE user_id IS NOT NULL AND mt5_login IS NOT NULL AND server_name IS NOT NULL;

-- ใช้เร่งการตรวจ duplicate active MT5 login; การ lock กันชนทำใน Redis + route production
CREATE INDEX IF NOT EXISTS idx_mt5_accounts_login_server_active
ON vps_system.mt5_accounts(mt5_login, server_name)
WHERE LOWER(COALESCE(status,'')) IN ('connecting','checking','connected','ready');

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

ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS vps_id BIGINT;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS node_id BIGINT;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS port_id BIGINT;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS command_type TEXT;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}'::jsonb;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS result JSONB DEFAULT '{}'::jsonb;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS result_message TEXT;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE vps_system.vps_agent_commands ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_vps_agent_commands_node_pending
ON vps_system.vps_agent_commands(node_id, status, id);

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
