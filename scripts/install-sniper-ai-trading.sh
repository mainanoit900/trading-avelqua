#!/usr/bin/env bash
# ติดตั้ง SNIPER-AI-TRADING Python server (Linux dev / fallback socket mode)
set -euo pipefail

APP_DIR="${1:-/root/trading-avelqua}"
BOT_DIR="$APP_DIR/BOT_MT5/SNIPER-AI-TRADING"
VENV_DIR="$BOT_DIR/venv"

if [ ! -f "$BOT_DIR/ai_server.py" ]; then
  echo "ERROR: ไม่พบ $BOT_DIR/ai_server.py"
  exit 1
fi

echo "==> SNIPER-AI venv: $VENV_DIR"
python3 -m venv "$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
pip install --upgrade pip
pip install -r "$BOT_DIR/requirements.txt"
mkdir -p "$BOT_DIR/models"
touch "$BOT_DIR/.deps_ok"
echo "==> ทดสอบ import"
python -c "import torch, xgboost, pandas, ta; print('OK', torch.__version__)"
echo ""
echo "รัน server:"
echo "  cd $BOT_DIR && source venv/bin/activate && python ai_server.py"
echo "  (Linux: socket 127.0.0.1:5555 | Windows VPS: Named Pipe โดย agent จัดการให้)"
