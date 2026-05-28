#!/usr/bin/env bash
# อัปเดตโค้ดจาก Git แล้ว restart แอป
# ครั้งแรก: cp deploy.env.example deploy.env  → ใส่ GIT_REMOTE_URL จริง
# ใช้: bash scripts/git-pull-deploy.sh

set -euo pipefail
APP_DIR="${1:-/root/trading-avelqua}"
cd "$APP_DIR"

DEPLOY_ENV="$APP_DIR/deploy.env"
if [ -f "$DEPLOY_ENV" ]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
fi

GIT_REMOTE_URL="${GIT_REMOTE_URL:-}"
GIT_BRANCH="${GIT_BRANCH:-main}"
PM2_APP_NAME="${PM2_APP_NAME:-trading-avelqua}"
RUN_NPM_INSTALL="${RUN_NPM_INSTALL:-1}"
GIT_PUSH_ON_DEPLOY="${GIT_PUSH_ON_DEPLOY:-0}"

git_auth_url() {
  local base="${GIT_REMOTE_URL:-https://github.com/mainanoit900/trading-avelqua.git}"
  base="${base#https://}"
  base="${base#http://}"
  if [ -n "${GIT_TOKEN:-}" ]; then
    printf 'https://x-access-token:%s@%s' "$GIT_TOKEN" "$base"
  else
    printf 'https://%s' "$base"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git not installed. Run: apt install -y git"
  exit 1
fi

if [ ! -d .git ]; then
  echo "==> git init (ครั้งแรก)"
  git init -b "$GIT_BRANCH"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  if [ -z "$GIT_REMOTE_URL" ]; then
    echo "ERROR: ยังไม่มี remote origin"
    echo "  1) cp deploy.env.example deploy.env"
    echo "  2) แก้ GIT_REMOTE_URL ใน deploy.env"
    echo "  3) รันสคริปต์นี้อีกครั้ง"
    exit 1
  fi
  echo "==> git remote add origin $GIT_REMOTE_URL"
  git remote add origin "$GIT_REMOTE_URL"
fi

CURRENT_URL="$(git remote get-url origin 2>/dev/null || true)"
if [ -n "$GIT_REMOTE_URL" ] && [ "$CURRENT_URL" != "$GIT_REMOTE_URL" ]; then
  echo "==> อัปเดต remote origin"
  git remote set-url origin "$GIT_REMOTE_URL"
fi

PREV_HEAD="$(git rev-parse HEAD 2>/dev/null || echo '')"

echo "==> git fetch origin $GIT_BRANCH"
git fetch "$(git_auth_url)" "$GIT_BRANCH"

if ! git rev-parse --verify "origin/$GIT_BRANCH" >/dev/null 2>&1; then
  echo "ERROR: ไม่พบ branch origin/$GIT_BRANCH — ตรวจชื่อ branch ใน deploy.env"
  exit 1
fi

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "==> commit แรกบนเซิร์ฟเวอร์ (baseline)"
  git add -A
  git commit -m "chore: production baseline before first git pull" || true
fi

echo "==> git pull"
set +e
git pull --ff-only origin "$GIT_BRANCH"
PULL_RC=$?
set -e
if [ "$PULL_RC" -ne 0 ]; then
  if [ "${GIT_ALLOW_UNRELATED:-1}" = "1" ]; then
    echo "==> fast-forward ไม่ได้ — merge ครั้งแรก (unrelated histories)"
    git merge "origin/$GIT_BRANCH" --allow-unrelated-histories --no-edit \
      -m "chore: merge origin/$GIT_BRANCH into production"
  else
    echo "ERROR: git pull failed (ตั้ง GIT_ALLOW_UNRELATED=1 หรือแก้ conflict เอง)"
    exit 1
  fi
fi

if [ "$RUN_NPM_INSTALL" = "1" ] && [ -f package.json ]; then
  echo "==> npm install"
  npm install --omit=dev
fi

RELEASE_DIR="$APP_DIR/.release-9750207"
if [ -d "$RELEASE_DIR" ] && [ -f "$RELEASE_DIR/server.js" ]; then
  echo "==> sync .release bundle (lib, routes, views, config)"
  for sub in lib routes views config; do
    if [ -d "$APP_DIR/$sub" ]; then
      mkdir -p "$RELEASE_DIR/$sub"
      rsync -a "$APP_DIR/$sub/" "$RELEASE_DIR/$sub/"
    fi
  done
  if [ -f "$APP_DIR/server.js" ]; then
    cp -f "$APP_DIR/server.js" "$RELEASE_DIR/server.js"
  fi
  if [ -f "$APP_DIR/.env" ] && [ ! -f "$RELEASE_DIR/.env" ]; then
    cp -f "$APP_DIR/.env" "$RELEASE_DIR/.env"
  fi
fi

if [ -f scripts/deploy-mt5-live-fix.sh ]; then
  echo "==> verify MT5 patches"
  bash scripts/deploy-mt5-live-fix.sh "$APP_DIR" || true
fi

AGENT_DEPLOY_ON_PULL="${AGENT_DEPLOY_ON_PULL:-1}"
FORCE_AGENT_DEPLOY="${FORCE_AGENT_DEPLOY:-0}"
DEPLOY_AGENTS=0
if [ "$AGENT_DEPLOY_ON_PULL" = "1" ]; then
  if [ "${FORCE_AGENT_DEPLOY}" = "1" ]; then
    DEPLOY_AGENTS=1
  elif [ -z "$PREV_HEAD" ]; then
    DEPLOY_AGENTS=1
  elif git diff --name-only "$PREV_HEAD" HEAD 2>/dev/null | grep -qE '^public/agent/agent\.py$'; then
    DEPLOY_AGENTS=1
  fi
fi
if [ "$DEPLOY_AGENTS" = "1" ] && [ -f scripts/deploy-agents-all-vps.js ]; then
  echo "==> deploy agent.py to all VPS + reset + restart service"
  AGENT_DEPLOY_FORCE=1 node scripts/deploy-agents-all-vps.js || echo "WARN: agent deploy script failed (check DB/.env)"
fi

echo "==> pm2 restart"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" 2>/dev/null || pm2 restart all
  pm2 status | head -15
else
  echo "pm2 not found — restart node เอง"
fi

if [ "${GIT_PUSH_ON_DEPLOY:-0}" = "1" ] && [ -n "${GIT_TOKEN:-}" ]; then
  AHEAD="$(git rev-list --count "origin/$GIT_BRANCH"..HEAD 2>/dev/null || echo 0)"
  if [ "${AHEAD:-0}" -gt 0 ]; then
    echo "==> git push origin $GIT_BRANCH ($AHEAD commit(s))"
    git push "$(git_auth_url)" "HEAD:$GIT_BRANCH"
  fi
fi

echo "DONE: $(git log -1 --oneline)"
