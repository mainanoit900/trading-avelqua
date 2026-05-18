#!/usr/bin/env bash
# คอลัมน์ vps_system.* บางตัวต้อง ALTER ด้วย postgres (trading_user ไม่ใช่ owner)
set -euo pipefail
DB="${PGDATABASE:-trading_avelqua}"

psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS connect_started_at TIMESTAMPTZ;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_window_title TEXT;
ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_preview_path TEXT;
SQL

echo "OK: vps_system schema migrations applied"
