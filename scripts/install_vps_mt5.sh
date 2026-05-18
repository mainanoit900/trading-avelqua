#!/usr/bin/env bash
set -e

APP_DIR="/root/trading-avelqua"
cd "$APP_DIR"

echo "== Backup original files =="
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "/root/Backup/vps-mt5-$TS"
cp -a server.js "/root/Backup/vps-mt5-$TS/server.js" || true
cp -a routes "/root/Backup/vps-mt5-$TS/routes" || true
cp -a services "/root/Backup/vps-mt5-$TS/services" || true
cp -a views/admin/vps.ejs "/root/Backup/vps-mt5-$TS/admin-vps.ejs" 2>/dev/null || true
cp -a views/app/mt5.ejs "/root/Backup/vps-mt5-$TS/app-mt5.ejs" 2>/dev/null || true

echo "== Patch server.js route =="
if ! grep -q "routes/vpsMt5" server.js; then
  python3 - <<'PY'
from pathlib import Path
p=Path("server.js")
s=p.read_text()
line="app.use('/', require('./routes/vpsMt5'));\n"
marker="app.use('/admin', require('./routes/admin'));"
if marker in s:
    s=s.replace(marker, line+marker, 1)
else:
    s=s.replace("app.use((req, res) => {", line+"\napp.use((req, res) => {", 1)
p.write_text(s)
PY
else
  echo "server.js already patched"
fi

echo "== Run migration =="
if command -v sudo >/dev/null 2>&1; then
  sudo -u postgres psql trading_avelqua -f db/migrations/010_vps_mt5_full.sql
else
  psql trading_avelqua -f db/migrations/010_vps_mt5_full.sql
fi

echo "== Syntax check =="
node -c routes/vpsMt5.js
node -c services/vpsAllocator.js
node -c services/vpsAgent.js
node -c services/intelAi.js
node -c server.js

echo "== Restart PM2 =="
pm2 restart trading-avelqua

echo "== Done =="
echo "Open: https://trading.avelqua.com/admin/vps"
echo "Open: https://trading.avelqua.com/app/mt5"
