#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/trading-avelqua}"
DB_NAME="${DB_NAME:-trading_avelqua}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="$APP_DIR/backups/before-mt5-bot-$(date +%Y%m%d-%H%M%S)"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Backup current files to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
for p in server.js routes/app-mt5-bot.js services/customerMt5BotService.js views/app/mt5-bot.ejs public/css/app-mt5-bot.css public/agent/agent.ps1; do
  if [ -e "$APP_DIR/$p" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$p")"
    cp -a "$APP_DIR/$p" "$BACKUP_DIR/$p"
  fi
done

echo "==> Copy MT5 BOT web files"
mkdir -p "$APP_DIR/routes" "$APP_DIR/services" "$APP_DIR/views/app" "$APP_DIR/public/css" "$APP_DIR/public/agent" "$APP_DIR/db/migrations"
cp -a "$SRC_DIR/routes/app-mt5-bot.js" "$APP_DIR/routes/app-mt5-bot.js"
cp -a "$SRC_DIR/services/customerMt5BotService.js" "$APP_DIR/services/customerMt5BotService.js"
cp -a "$SRC_DIR/views/app/mt5-bot.ejs" "$APP_DIR/views/app/mt5-bot.ejs"
cp -a "$SRC_DIR/public/css/app-mt5-bot.css" "$APP_DIR/public/css/app-mt5-bot.css"
cp -a "$SRC_DIR/db/migrations/023_customer_mt5_bot_full.sql" "$APP_DIR/db/migrations/023_customer_mt5_bot_full.sql"
cp -a "$SRC_DIR/public/agent/agent.ps1" "$APP_DIR/public/agent/agent.ps1"

if ! grep -q "routes/app-mt5-bot" "$APP_DIR/server.js"; then
  echo "==> Patch server.js route"
  cp -a "$APP_DIR/server.js" "$BACKUP_DIR/server.js.before-patch"
  perl -0pi -e "s#app\.use\('/app', require\('\./routes/app'\)\);#app.use('/app', require('./routes/app-mt5-bot'));\napp.use('/app', require('./routes/app'));#" "$APP_DIR/server.js"
else
  echo "==> server.js already has app-mt5-bot route"
fi

echo "==> Run database migration"
if command -v psql >/dev/null 2>&1; then
  if [ "${SKIP_DB:-0}" = "1" ]; then
    echo "SKIP_DB=1, skip database migration"
  else
    sudo -u postgres psql -d "$DB_NAME" -f "$APP_DIR/db/migrations/023_customer_mt5_bot_full.sql"
  fi
else
  echo "psql not found. Please run: sudo -u postgres psql -d $DB_NAME -f $APP_DIR/db/migrations/023_customer_mt5_bot_full.sql"
fi

echo "==> Restart service"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart all || true
else
  systemctl restart trading-avelqua || true
fi

echo "DONE"
echo "Open: https://trading.avelqua.com/app/mt5-bot"
echo "Agent file URL: https://trading.avelqua.com/agent/agent.ps1"
echo "Backup: $BACKUP_DIR"
