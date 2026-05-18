#!/usr/bin/env bash
# Deploy MT5 live / heartbeat / account_snapshot fixes without git.
# Usage on production (files already in APP_DIR):
#   bash scripts/deploy-mt5-live-fix.sh
#
# Or copy from another machine:
#   rsync -avz routes/vps-agent-api-production.js lib/mt5EquitySync.js \
#     lib/mt5CommandNormalize.js lib/mt5LiveStatus.js lib/agentDeploy.js \
#     routes/app-mt5-bot.js public/agent/agent.py \
#     root@srv1595556:~/trading-avelqua/
#   ssh root@srv1595556 'bash ~/trading-avelqua/scripts/deploy-mt5-live-fix.sh'

set -euo pipefail
APP_DIR="${1:-/root/trading-avelqua}"
cd "$APP_DIR"

BACKUP_ROOT="$APP_DIR/backups"
BACKUP_DIR="$BACKUP_ROOT/mt5-live-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

FILES=(
  routes/vps-agent-api-production.js
  lib/mt5EquitySync.js
  lib/mt5CommandNormalize.js
  lib/mt5LiveStatus.js
  lib/agentDeploy.js
  routes/app-mt5-bot.js
  public/agent/agent.py
)

echo "==> Backup"
for f in "${FILES[@]}"; do
  if [ -f "$APP_DIR/$f" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp -a "$APP_DIR/$f" "$BACKUP_DIR/$f"
  fi
done

echo "==> Verify critical patches"
grep -q 'expireStuckMaintenanceCommands' routes/vps-agent-api-production.js || {
  echo "ERROR: routes/vps-agent-api-production.js missing heartbeat fix (expireStuckMaintenanceCommands import)"
  exit 1
}
grep -q 'equityCommandTypeForAgent' lib/mt5EquitySync.js || {
  echo "ERROR: lib/mt5EquitySync.js missing equityCommandTypeForAgent"
  exit 1
}
grep -q "account_snapshot: 'dashboard'" lib/mt5CommandNormalize.js || {
  echo "ERROR: lib/mt5CommandNormalize.js missing account_snapshot -> dashboard alias"
  exit 1
}

echo "==> Restart Node (pm2)"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart trading-avelqua 2>/dev/null || pm2 restart all
  pm2 status | head -20
else
  echo "pm2 not found — restart node manually: systemctl restart ... or node server.js"
fi

echo "DONE. Backup: $BACKUP_DIR"
echo "Next: on Windows VPS run: Restart-Service AvelquaPythonAgent"
echo "Check PowerShell: no HEARTBEAT ERROR 500; commands Ok=True"
