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

echo "==> git fetch origin $GIT_BRANCH"
git fetch origin "$GIT_BRANCH"

if ! git rev-parse --verify "origin/$GIT_BRANCH" >/dev/null 2>&1; then
  echo "ERROR: ไม่พบ branch origin/$GIT_BRANCH — ตรวจชื่อ branch ใน deploy.env"
  exit 1
fi

if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "==> commit แรกบนเซิร์ฟเวอร์ (baseline)"
  git add -A
  git commit -m "chore: production baseline before first git pull" || true
fi

echo "==> git pull (ff-only)"
git pull --ff-only origin "$GIT_BRANCH"

if [ "$RUN_NPM_INSTALL" = "1" ] && [ -f package.json ]; then
  echo "==> npm install"
  npm install --omit=dev
fi

if [ -f scripts/deploy-mt5-live-fix.sh ]; then
  echo "==> verify MT5 patches"
  bash scripts/deploy-mt5-live-fix.sh "$APP_DIR" || true
fi

echo "==> pm2 restart"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME" 2>/dev/null || pm2 restart all
  pm2 status | head -15
else
  echo "pm2 not found — restart node เอง"
fi

echo "DONE: $(git log -1 --oneline)"
