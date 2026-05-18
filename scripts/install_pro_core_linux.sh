#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${1:-/root/trading-avelqua}"
BACKUP_DIR="$APP_DIR/backups/pro-mt5-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cd "$(dirname "$0")/.."

echo "==> Backup current files"
for f in server.js routes/pro-mt5-core.js routes/pro-vps-agent-api.js public/agent/agent.py public/agent/requirements.txt; do
  [ -f "$APP_DIR/$f" ] && mkdir -p "$BACKUP_DIR/$(dirname "$f")" && cp -a "$APP_DIR/$f" "$BACKUP_DIR/$f" || true
done

echo "==> Copy PRO Core files"
mkdir -p "$APP_DIR/routes" "$APP_DIR/public/agent" "$APP_DIR/db/migrations"
cp -a routes/pro-mt5-core.js "$APP_DIR/routes/pro-mt5-core.js"
cp -a routes/pro-vps-agent-api.js "$APP_DIR/routes/pro-vps-agent-api.js"
cp -a public/agent/agent_pro_startupini.py "$APP_DIR/public/agent/agent.py"
cp -a public/agent/requirements.txt "$APP_DIR/public/agent/requirements.txt"
cp -a db/migrations/030_mt5_pro_core_startupini.sql "$APP_DIR/db/migrations/030_mt5_pro_core_startupini.sql"

echo "==> Patch server.js mount routes before old routes"
cp -a "$APP_DIR/server.js" "$BACKUP_DIR/server.js"
if ! grep -q "routes/pro-vps-agent-api" "$APP_DIR/server.js"; then
  perl -0pi -e "s#app\.use\('/api/vps-agent', require\('\./routes/vps-agent-api'\)\);#app.use('/api/vps-agent', require('./routes/pro-vps-agent-api'));\napp.use('/api/vps-agent', require('./routes/vps-agent-api'));#" "$APP_DIR/server.js"
fi
if ! grep -q "routes/pro-mt5-core" "$APP_DIR/server.js"; then
  perl -0pi -e "s#app\.use\('/app', require\('\./routes/app-mt5-bot'\)\);#app.use('/app', require('./routes/pro-mt5-core'));\napp.use('/app', require('./routes/app-mt5-bot'));#" "$APP_DIR/server.js"
fi

echo "==> Run DB migration"
cd "$APP_DIR"
DB_NAME="${DB_NAME:-trading_avelqua}"
sudo -u postgres psql "$DB_NAME" -f db/migrations/030_mt5_pro_core_startupini.sql

echo "==> Restart PM2"
pm2 restart trading-avelqua || pm2 restart all

echo "DONE. Backup: $BACKUP_DIR"
