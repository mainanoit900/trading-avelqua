#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_DIR"

if ! command -v tesseract >/dev/null 2>&1; then
  echo "Installing tesseract OCR..."
  apt-get update -qq
  apt-get install -y tesseract-ocr tesseract-ocr-tha tesseract-ocr-eng python3-venv python3-pip >/dev/null
fi

VENV="$APP_DIR/.venv-identity-ocr"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$APP_DIR/scripts/requirements-identity-ocr.txt"
chmod +x "$APP_DIR/scripts/scan_identity_document.py" 2>/dev/null || true

echo "Preloading EasyOCR models..."
"$VENV/bin/python" - <<'PY' || echo "WARN: EasyOCR preload skipped"
import easyocr
easyocr.Reader(["th", "en"], gpu=False, verbose=False)
print("EasyOCR ready")
PY

echo "Identity OCR ready: $VENV/bin/python"
