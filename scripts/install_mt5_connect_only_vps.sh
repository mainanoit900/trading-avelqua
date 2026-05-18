#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/root/trading-avelqua}"
DB_NAME="${DB_NAME:-trading_avelqua}"
PATCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%F-%H%M%S)"

echo "== Backup files =="
mkdir -p "$APP_DIR/backups/mt5-connect-only-$TS"
for f in \
  routes/app-mt5-bot.js \
  services/customerMt5BotService.js \
  views/app/mt5-bot.ejs \
  public/css/app-mt5-bot.css; do
  if [ -f "$APP_DIR/$f" ]; then
    mkdir -p "$APP_DIR/backups/mt5-connect-only-$TS/$(dirname "$f")"
    cp "$APP_DIR/$f" "$APP_DIR/backups/mt5-connect-only-$TS/$f"
  fi
done

echo "== Copy patch files =="
mkdir -p "$APP_DIR/routes" "$APP_DIR/services" "$APP_DIR/views/app" "$APP_DIR/public/css" "$APP_DIR/db/migrations"
cp "$PATCH_DIR/routes/app-mt5-bot.js" "$APP_DIR/routes/app-mt5-bot.js"
cp "$PATCH_DIR/services/customerMt5BotService.js" "$APP_DIR/services/customerMt5BotService.js"
cp "$PATCH_DIR/views/app/mt5-bot.ejs" "$APP_DIR/views/app/mt5-bot.ejs"
cp "$PATCH_DIR/public/css/app-mt5-bot.css" "$APP_DIR/public/css/app-mt5-bot.css"
cp "$PATCH_DIR/db/migrations/025_mt5_connect_port_vps.sql" "$APP_DIR/db/migrations/025_mt5_connect_port_vps.sql"

TMP_SQL="/tmp/025_mt5_connect_port_vps.sql"
cp "$PATCH_DIR/db/migrations/025_mt5_connect_port_vps.sql" "$TMP_SQL"
chmod 644 "$TMP_SQL"

echo "== Run DB migration =="
sudo -u postgres psql -d "$DB_NAME" -f "$TMP_SQL"

echo "== Done =="
echo "Backup: $APP_DIR/backups/mt5-connect-only-$TS"
echo "Restart with: pm2 restart all"
