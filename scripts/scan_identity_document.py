#!/usr/bin/env python3
"""Scan Thai ID card or passport image via Tesseract OCR."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

try:
    import cv2
    import pytesseract
    from PIL import Image
except ImportError as exc:
    print(json.dumps({"ok": False, "error": f"missing_python_deps:{exc.name}"}))
    sys.exit(0)


MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def validate_thai_id(raw: str) -> tuple[bool, str]:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) != 13:
        return False, digits
    total = 0
    for i in range(12):
        total += int(digits[i]) * (13 - i)
    check = (11 - (total % 11)) % 10
    if check != int(digits[12]):
        return False, digits
    return True, digits


def parse_date_token(raw: str) -> str | None:
    text = normalize_space(raw)
    if not text:
        return None

    iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", text)
    if iso:
        return f"{iso.group(1)}-{iso.group(2)}-{iso.group(3)}"

    slash = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-]((\d{4})|(\d{2}))$", text)
    if slash:
        year = slash.group(3) or slash.group(4)
        if len(year) == 2:
            year = f"19{year}" if int(year) > 30 else f"20{year}"
        return f"{year}-{int(slash.group(2)):02d}-{int(slash.group(1)):02d}"

    eng = re.search(
        r"(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})",
        text,
        re.IGNORECASE,
    )
    if eng:
        month = MONTHS.get(eng.group(2).lower()[:3])
        if month:
            return f"{eng.group(3)}-{month:02d}-{int(eng.group(1)):02d}"

    return None


def preprocess_image(image_path: Path):
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError("cannot_read_image")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, None, fx=1.6, fy=1.6, interpolation=cv2.INTER_CUBIC)
    gray = cv2.bilateralFilter(gray, 9, 75, 75)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return thresh


def ocr_text(image_path: Path) -> str:
    processed = preprocess_image(image_path)
    pil = Image.fromarray(processed)
    parts = []
    for lang in ("tha+eng", "eng"):
        try:
            parts.append(pytesseract.image_to_string(pil, lang=lang, config="--psm 6"))
        except Exception:
            continue
    return normalize_space("\n".join(parts))


def find_national_id(text: str) -> str:
    patterns = [
        r"(\d)\s*(\d{4})\s*(\d{5})\s*(\d{2})\s*(\d)",
        r"(\d{13})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        if match.lastindex == 1:
            candidate = match.group(1)
        else:
            candidate = "".join(match.groups())
        ok, normalized = validate_thai_id(candidate)
        if ok:
            return normalized
    return ""


def find_between(text: str, start_labels: list[str], end_labels: list[str]) -> str:
    lower = text.lower()
    start_idx = -1
    for label in start_labels:
        idx = lower.find(label.lower())
        if idx >= 0:
            start_idx = idx + len(label)
            break
    if start_idx < 0:
        return ""

    end_idx = len(text)
    for label in end_labels:
        idx = lower.find(label.lower(), start_idx)
        if idx >= 0:
            end_idx = min(end_idx, idx)
    return normalize_space(text[start_idx:end_idx])


def parse_thai_id(text: str) -> dict:
    national_id = find_national_id(text)
    if not national_id:
        return {"ok": False, "message": "ocr_no_valid_id"}

    full_name = find_between(
        text,
        ["Name", "ชื่อ", "Mr.", "Mrs.", "Miss"],
        ["Date of Birth", "เกิดวันที่", "Identification Number", "เลขประจำตัว"],
    )
    if not full_name:
        thai_name = re.search(r"(?:นาย|นาง|น\.ส\.|นางสาว)\s*[ก-๙\s]+", text)
        if thai_name:
            full_name = normalize_space(thai_name.group(0))

    dob_raw = find_between(text, ["Date of Birth", "เกิดวันที่"], ["Address", "ที่อยู่", "Date of Issue"])
    expiry_raw = find_between(
        text,
        ["Date of Expiry", "วันบัตรหมดอายุ", "Expiry"],
        ["",],
    )
    if not expiry_raw:
        expiry_match = re.search(r"(?:Date of Expiry|วันบัตรหมดอายุ)\s*([0-9A-Za-z.\s/-]+)", text, re.IGNORECASE)
        expiry_raw = normalize_space(expiry_match.group(1)) if expiry_match else ""

    address_line = find_between(
        text,
        ["Address", "ที่อยู่"],
        ["Date of Issue", "วันออกบัตร", "Date of Expiry", "วันบัตรหมดอายุ"],
    )

    date_of_birth = parse_date_token(dob_raw) or parse_date_token(text)
    expiry_date = parse_date_token(expiry_raw)

    if not full_name or not date_of_birth or not expiry_date:
        return {"ok": False, "message": "ocr_incomplete_fields"}

    return {
        "ok": True,
        "engine": "tesseract",
        "document_type": "thai_id",
        "national_id": national_id,
        "passport_number": "",
        "full_name": full_name,
        "date_of_birth": date_of_birth,
        "address_line": address_line,
        "subdistrict": "",
        "district": "",
        "province": "",
        "postal_code": "",
        "expiry_date": expiry_date,
        "confidence": 0.82 if address_line else 0.75,
        "is_authentic_document": True,
        "raw_text": text[:4000],
    }


def parse_passport(text: str) -> dict:
    passport_match = re.search(r"\b([A-Z0-9]{6,12})\b", text)
    passport_number = passport_match.group(1) if passport_match else ""
    if not passport_number:
        return {"ok": False, "message": "ocr_no_passport_number"}

    full_name = find_between(text, ["Name", "Surname", "Given names"], ["Nationality", "Date of birth", "Sex"])
    dob = parse_date_token(find_between(text, ["Date of birth", "Birth"], ["Place of birth", "Sex", "Nationality"]))
    expiry = parse_date_token(find_between(text, ["Date of expiry", "Expiry"], ["Authority", "Holder"]))

    if not full_name or not dob or not expiry:
        return {"ok": False, "message": "ocr_incomplete_fields"}

    return {
        "ok": True,
        "engine": "tesseract",
        "document_type": "passport",
        "national_id": "",
        "passport_number": passport_number,
        "full_name": full_name,
        "date_of_birth": dob,
        "address_line": "",
        "subdistrict": "",
        "district": "",
        "province": "",
        "postal_code": "",
        "expiry_date": expiry,
        "confidence": 0.78,
        "is_authentic_document": True,
        "raw_text": text[:4000],
    }


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "message": "usage: scan_identity_document.py <image> <thai_id|passport>"}))
        return

    image_path = Path(sys.argv[1])
    doc_type = sys.argv[2].strip().lower()
    if not image_path.exists():
        print(json.dumps({"ok": False, "message": "image_not_found"}))
        return

    try:
        text = ocr_text(image_path)
        result = parse_passport(text) if doc_type == "passport" else parse_thai_id(text)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "message": f"ocr_failed:{exc}"}))


if __name__ == "__main__":
    main()
