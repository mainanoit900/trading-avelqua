#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/root/trading-avelqua}"
DB_NAME="${DB_NAME:-trading_avelqua}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$APP_DIR/backups/before-mt5-port-picker-$TS"

mkdir -p "$BACKUP_DIR"
cp -a "$APP_DIR/routes/app-mt5-bot.js" "$BACKUP_DIR/" 2>/dev/null || true
cp -a "$APP_DIR/services/customerMt5BotService.js" "$BACKUP_DIR/" 2>/dev/null || true
cp -a "$APP_DIR/views/app/mt5-bot.ejs" "$BACKUP_DIR/" 2>/dev/null || true
cp -a "$APP_DIR/public/css/app-mt5-bot.css" "$BACKUP_DIR/" 2>/dev/null || true

cp routes/app-mt5-bot.js "$APP_DIR/routes/app-mt5-bot.js"
cp services/customerMt5BotService.js "$APP_DIR/services/customerMt5BotService.js"
cp views/app/mt5-bot.ejs "$APP_DIR/views/app/mt5-bot.ejs"
cp public/css/app-mt5-bot.css "$APP_DIR/public/css/app-mt5-bot.css"
mkdir -p "$APP_DIR/db/migrations"
cp db/migrations/024_customer_mt5_port_slots.sql "$APP_DIR/db/migrations/024_customer_mt5_port_slots.sql"
cp db/migrations/024_customer_mt5_port_slots.sql /tmp/024_customer_mt5_port_slots.sql
chmod 644 /tmp/024_customer_mt5_port_slots.sql
sudo -u postgres psql -d "$DB_NAME" -f /tmp/024_customer_mt5_port_slots.sql

echo "OK: installed mt5 port picker. Backup: $BACKUP_DIR"
