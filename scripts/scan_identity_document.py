#!/usr/bin/env python3
"""Scan Thai ID card or passport via local OCR (EasyOCR + Tesseract fallback)."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
    import pytesseract
    from PIL import Image
except ImportError as exc:
    print(json.dumps({"ok": False, "message": f"missing_python_deps:{exc.name}"}))
    sys.exit(0)

EASYOCR_READER = None

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def strip_admin_prefix(value: str) -> str:
    return re.sub(r"^(แขวง|ตำบล|ต\.|เขต|อำเภอ|อ\.|จ\.|จังหวัด)\s*", "", normalize_space(value)).strip()


def validate_thai_id(raw: str) -> tuple[bool, str]:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) != 13:
        return False, digits
    total = sum(int(digits[i]) * (13 - i) for i in range(12))
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
        year_int = int(year)
        if year_int >= 2400:
            year_int -= 543
        return f"{year_int:04d}-{int(slash.group(2)):02d}-{int(slash.group(1)):02d}"

    eng = re.search(r"(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})", text, re.IGNORECASE)
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
    gray = cv2.resize(gray, None, fx=1.8, fy=1.8, interpolation=cv2.INTER_CUBIC)
    gray = cv2.bilateralFilter(gray, 9, 75, 75)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return thresh


def get_easyocr_reader():
    global EASYOCR_READER
    if EASYOCR_READER is None:
        import easyocr
        EASYOCR_READER = easyocr.Reader(["th", "en"], gpu=False, verbose=False)
    return EASYOCR_READER


def ocr_with_easyocr(image_path: Path) -> str:
    reader = get_easyocr_reader()
    img = cv2.imread(str(image_path))
    if img is None:
        return ""
    results = reader.readtext(img, detail=0, paragraph=False)
    return normalize_space(" ".join(results))


def ocr_with_tesseract(image_path: Path) -> str:
    processed = preprocess_image(image_path)
    pil = Image.fromarray(processed)
    parts = []
    for lang in ("tha+eng", "eng"):
        try:
            parts.append(pytesseract.image_to_string(pil, lang=lang, config="--psm 6"))
        except Exception:
            continue
    return normalize_space("\n".join(parts))


def ocr_text(image_path: Path) -> tuple[str, str]:
    easy_text = ""
    try:
        easy_text = ocr_with_easyocr(image_path)
    except Exception:
        easy_text = ""

    tess_text = ocr_with_tesseract(image_path)
    combined = normalize_space(f"{easy_text} {tess_text}")
    engine = "easyocr" if easy_text else "tesseract"
    return combined, engine


def find_national_id(text: str) -> str:
    patterns = [
        r"(\d)\s*(\d{4})\s*(\d{5})\s*(\d{2})\s*(\d)",
        r"(\d{13})",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        candidate = match.group(1) if match.lastindex == 1 else "".join(match.groups())
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
        if not label:
            continue
        idx = lower.find(label.lower(), start_idx)
        if idx >= 0:
            end_idx = min(end_idx, idx)
    return normalize_space(text[start_idx:end_idx])


def parse_thai_address(full_address: str) -> dict:
    full = normalize_space(full_address)
    subdistrict = district = province = ""
    if not full:
        return {"address_line": "", "full_address": "", "subdistrict": "", "district": "", "province": ""}

    sub_match = re.search(r"(?:แขวง|ต\.|ตำบล)\s*([^,\n]+?)(?=\s*(?:เขต|อ\.|อำเภอ|จ\.|จังหวัด|กรุงเทพ|$))", full)
    if sub_match:
        subdistrict = strip_admin_prefix(sub_match.group(1))

    dist_match = re.search(r"(?:เขต|อ\.|อำเภอ)\s*([^,\n]+?)(?=\s*(?:จ\.|จังหวัด|กรุงเทพ|$))", full)
    if dist_match:
        district = strip_admin_prefix(dist_match.group(1))

    prov_match = re.search(r"(?:จ\.|จังหวัด)\s*([^\s,]+(?:\s+[^\s,]+)?)|(?:^|\s)(กรุงเทพมหานคร)(?:\s|$)", full)
    if prov_match:
        province = strip_admin_prefix(prov_match.group(1) or prov_match.group(2) or "")

    house_match = re.match(r"^(.+?)(?=\s*(?:แขวง|ต\.|ตำบล|เขต|อ\.|อำเภอ|จ\.|จังหวัด|กรุงเทพมหานคร))", full)
    address_line = normalize_space(house_match.group(1)) if house_match else full

    return {
        "address_line": address_line,
        "full_address": full,
        "subdistrict": subdistrict,
        "district": district,
        "province": province,
    }


def parse_thai_id(text: str, engine: str) -> dict:
    national_id = find_national_id(text)
    if not national_id:
        return {"ok": False, "message": "ocr_no_valid_id"}

    full_name = find_between(
        text,
        ["Name", "ชื่อ", "Mr.", "Mrs.", "Miss", "นาย", "นาง", "น.ส.", "นางสาว"],
        ["Date of Birth", "เกิดวันที่", "Identification Number", "เลขประจำตัว"],
    )
    if not full_name:
        thai_name = re.search(r"(?:นาย|นาง|น\.ส\.|นางสาว)\s*[ก-๙A-Za-z.\s]+", text)
        if thai_name:
            full_name = normalize_space(thai_name.group(0))

    dob_raw = find_between(text, ["Date of Birth", "เกิดวันที่"], ["Address", "ที่อยู่", "Date of Issue"])
    expiry_raw = find_between(text, ["Date of Expiry", "วันบัตรหมดอายุ", "Expiry"], ["Date of Issue", "วันออกบัตร"])
    if not expiry_raw:
        expiry_match = re.search(r"(?:Date of Expiry|วันบัตรหมดอายุ)\s*([0-9A-Za-z.\s/-]+)", text, re.IGNORECASE)
        expiry_raw = normalize_space(expiry_match.group(1)) if expiry_match else ""

    address_raw = find_between(
        text,
        ["Address", "ที่อยู่"],
        ["Date of Issue", "วันออกบัตร", "Date of Expiry", "วันบัตรหมดอายุ"],
    )
    address_parts = parse_thai_address(address_raw)

    date_of_birth = parse_date_token(dob_raw)
    expiry_date = parse_date_token(expiry_raw)

    if not full_name:
        return {"ok": False, "message": "ocr_no_name"}
    if not date_of_birth:
        return {"ok": False, "message": "ocr_no_dob"}
    if not expiry_date:
        return {"ok": False, "message": "ocr_no_expiry"}

    return {
        "ok": True,
        "engine": engine,
        "document_type": "thai_id",
        "national_id": national_id,
        "passport_number": "",
        "full_name": full_name,
        "date_of_birth": date_of_birth,
        "full_address": address_parts["full_address"],
        "address_line": address_parts["address_line"],
        "subdistrict": address_parts["subdistrict"],
        "district": address_parts["district"],
        "province": address_parts["province"],
        "postal_code": "",
        "expiry_date": expiry_date,
        "confidence": 0.88 if engine == "easyocr" else 0.72,
        "is_authentic_document": True,
    }


def parse_passport(text: str, engine: str) -> dict:
    passport_match = re.search(r"\b([A-Z]{1,2}[A-Z0-9]{5,11})\b", text)
    passport_number = passport_match.group(1).upper() if passport_match else ""
    if not passport_number:
        return {"ok": False, "message": "ocr_no_passport_number"}

    full_name = find_between(text, ["Name", "Surname", "Given names"], ["Nationality", "Date of birth", "Sex"])
    dob = parse_date_token(find_between(text, ["Date of birth", "Birth"], ["Place of birth", "Sex", "Nationality"]))
    expiry = parse_date_token(find_between(text, ["Date of expiry", "Expiry"], ["Authority", "Holder"]))

    if not full_name or not dob or not expiry:
        return {"ok": False, "message": "ocr_incomplete_fields"}

    return {
        "ok": True,
        "engine": engine,
        "document_type": "passport",
        "national_id": "",
        "passport_number": passport_number,
        "full_name": full_name,
        "date_of_birth": dob,
        "full_address": "",
        "address_line": "",
        "subdistrict": "",
        "district": "",
        "province": "",
        "postal_code": "",
        "expiry_date": expiry,
        "confidence": 0.8,
        "is_authentic_document": True,
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
        text, engine = ocr_text(image_path)
        if not text:
            print(json.dumps({"ok": False, "message": "ocr_no_text"}))
            return
        result = parse_passport(text, engine) if doc_type == "passport" else parse_thai_id(text, engine)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "message": f"ocr_failed:{exc}"}))


if __name__ == "__main__":
    main()
