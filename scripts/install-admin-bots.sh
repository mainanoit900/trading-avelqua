#!/usr/bin/env bash
set -e
APP_DIR="${1:-/root/trading-avelqua}"
cd "$APP_DIR"

echo "== Backup ก่อนติดตั้ง =="
BACKUP_DIR="/root/trading-avelqua-backup-admin-bots-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -a routes views public server.js "$BACKUP_DIR" 2>/dev/null || true
echo "Backup: $BACKUP_DIR"

echo "== Copy files =="
cp /root/admin_user_bots_ready/routes/admin-bots.js routes/admin-bots.js
cp /root/admin_user_bots_ready/views/admin/bots.ejs views/admin/bots.ejs
cp /root/admin_user_bots_ready/public/css/admin-bots.css public/css/admin-bots.css
mkdir -p public/js
cp /root/admin_user_bots_ready/public/js/admin-bots.js public/js/admin-bots.js
mkdir -p db/migrations
cp /root/admin_user_bots_ready/db/migrations/011_admin_user_bots.sql db/migrations/011_admin_user_bots.sql

echo "== Run SQL migration =="
if [ -n "${DB_NAME:-}" ]; then
  PGPASSWORD="${DB_PASS:-}" psql -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" -U "${DB_USER:-trading_user}" -d "$DB_NAME" -f db/migrations/011_admin_user_bots.sql
else
  PGPASSWORD="${DB_PASS:-}" psql -h "${DB_HOST:-127.0.0.1}" -p "${DB_PORT:-5432}" -U "${DB_USER:-trading_user}" -d "${DB_NAME:-trading_avelqua}" -f db/migrations/011_admin_user_bots.sql
fi

echo "== Patch server.js mount route =="
if ! grep -q "routes/admin-bots" server.js; then
  python3 - <<'PY'
from pathlib import Path
p=Path('server.js')
s=p.read_text()
needle="app.use('/admin', require('./routes/admin'));"
insert="app.use('/admin', require('./routes/admin'));\napp.use('/', require('./routes/admin-bots'));"
if needle in s:
    s=s.replace(needle,insert,1)
else:
    s=s.replace("app.use('/app', require('./routes/app'));", "app.use('/', require('./routes/admin-bots'));\napp.use('/app', require('./routes/app'));",1)
p.write_text(s)
PY
fi

echo "== Patch admin menu =="
PARTIAL="views/partials/admin-shell.ejs"
if [ -f "$PARTIAL" ] && ! grep -q "href=\"/admin/bots\"" "$PARTIAL"; then
  python3 - <<'PY'
from pathlib import Path
p=Path('views/partials/admin-shell.ejs')
s=p.read_text()
needle='<a class="<%= currentPath.startsWith(\'/admin/vps\') ? \'active\' : \'\' %>" href="/admin/vps"><span>🖥️</span><span data-i18n="admin.menu.vps"><%= t(\'admin.menu.vps\', \'VPS / MT5\') %></span></a>'
add=needle+'\n          <a class="<%= currentPath.startsWith(\'/admin/bots\') ? \'active\' : \'\' %>" href="/admin/bots"><span>🤖</span><span>บอทลูกค้า</span></a>'
if needle in s:
    s=s.replace(needle, add, 1)
else:
    marker='<nav class="nav-links">'
    idx=s.rfind(marker)
    if idx!=-1:
        end=s.find('</nav>',idx)
        s=s[:end]+'          <a class="<%= currentPath.startsWith(\'/admin/bots\') ? \'active\' : \'\' %>" href="/admin/bots"><span>🤖</span><span>บอทลูกค้า</span></a>\n'+s[end:]
p.write_text(s)
PY
fi

echo "== Check syntax =="
node -c routes/admin-bots.js
node -c server.js

echo "== Restart PM2 =="
pm2 restart trading || pm2 restart all

echo "สำเร็จ: เปิดหน้า https://trading.avelqua.com/admin/bots"
