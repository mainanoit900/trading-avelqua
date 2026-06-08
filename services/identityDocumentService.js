'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { query } = require('../config/database');
const { parseThaiIdAddress, buildFullAddressText, hasThaiAdminMarker } = require('../lib/thaiAddressParser');
const { lookupPostalCode } = require('../lib/thaiPostalLookup');

const execFileAsync = promisify(execFile);
const UPLOAD_DIR = path.join(__dirname, '../uploads/identity-docs');
const PYTHON_SCRIPT = path.join(__dirname, '../scripts/scan_identity_document.py');
const PYTHON_BIN = process.env.IDENTITY_OCR_PYTHON
  || (fs.existsSync(path.join(__dirname, '../.venv-identity-ocr/bin/python'))
    ? path.join(__dirname, '../.venv-identity-ocr/bin/python')
    : 'python3');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;

const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const OCR_ERROR_MESSAGES = {
  ocr_no_valid_id: 'อ่านเลขบัตรประชาชนไม่ได้ กรุณาถ่ายให้เห็นเลข 13 หลักชัดเจน',
  ocr_no_name: 'อ่านชื่อ-นามสกุลจากเอกสารไม่ได้ กรุณาถ่ายใหม่',
  ocr_no_dob: 'อ่านวันเดือนปีเกิดจากเอกสารไม่ได้ กรุณาถ่ายใหม่',
  ocr_no_expiry: 'อ่านวันหมดอายุเอกสารไม่ได้ กรุณาถ่ายใหม่',
  ocr_incomplete_fields: 'อ่านข้อมูลจากเอกสารไม่ครบ กรุณาถ่ายให้ชัดและครบใบ',
  ocr_no_passport_number: 'อ่านเลขพาสปอร์ตไม่ได้ กรุณาถ่ายใหม่',
  ocr_no_text: 'อ่านข้อความจากรูปไม่ได้ กรุณาถ่ายให้ชัดขึ้น',
  image_not_found: 'ไม่พบไฟล์รูปเอกสาร',
  missing_python_deps: 'ระบบ OCR ยังไม่พร้อม กรุณาติดต่อทีมงาน'
};

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function extForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

function normalizeDigits(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function normalizeDocText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function mapOcrMessage(code) {
  const key = String(code || '').replace(/^ocr_failed:/, '').split(':')[0];
  if (OCR_ERROR_MESSAGES[key]) return OCR_ERROR_MESSAGES[key];
  if (String(code || '').startsWith('missing_python_deps')) {
    return OCR_ERROR_MESSAGES.missing_python_deps;
  }
  return 'สแกนเอกสารไม่สำเร็จ กรุณาถ่ายให้เห็นตัวเลขและชื่อชัดเจน';
}

function validateThaiNationalId(id) {
  const digits = normalizeDigits(id);
  if (!/^\d{13}$/.test(digits)) {
    return { ok: false, message: 'เลขบัตรประชาชนต้องมี 13 หลัก' };
  }

  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(digits[i]) * (13 - i);
  }
  const check = (11 - (sum % 11)) % 10;
  if (check !== Number(digits[12])) {
    return { ok: false, message: 'เลขบัตรประชาชนไม่ถูกต้อง (ตรวจสอบ checksum ไม่ผ่าน)' };
  }

  return { ok: true, normalized: digits };
}

function validatePassportNumber(value) {
  const passport = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{6,12}$/.test(passport)) {
    return { ok: false, message: 'เลขหนังสือเดินทางไม่ถูกต้อง' };
  }
  return { ok: true, normalized: passport };
}

function parseIsoDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const date = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const thMatch = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (thMatch) {
    let year = Number(thMatch[3]);
    if (year >= 2400) year -= 543;
    const day = thMatch[1].padStart(2, '0');
    const month = thMatch[2].padStart(2, '0');
    const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const engMatch = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})$/i);
  if (engMatch) {
    const month = MONTH_MAP[String(engMatch[2]).slice(0, 3).toLowerCase()];
    if (month) {
      const date = new Date(`${engMatch[3]}-${String(month).padStart(2, '0')}-${String(engMatch[1]).padStart(2, '0')}T00:00:00.000Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatIsoDate(date) {
  if (!date) return '';
  return date.toISOString().slice(0, 10);
}

function isExpiredDate(date) {
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const compare = new Date(date);
  compare.setHours(0, 0, 0, 0);
  return compare.getTime() < today.getTime();
}

async function scanDocumentWithPython(absPath, expectedDocumentType) {
  if (!fs.existsSync(PYTHON_SCRIPT)) {
    return { ok: false, message: 'ระบบ OCR ยังไม่พร้อม กรุณาติดต่อทีมงาน' };
  }

  try {
    const { stdout } = await execFileAsync(
      PYTHON_BIN,
      [PYTHON_SCRIPT, absPath, expectedDocumentType],
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
    );
    const result = JSON.parse(String(stdout || '').trim());
    if (!result?.ok) {
      return { ok: false, message: mapOcrMessage(result?.message || result?.error) };
    }

    return {
      ok: true,
      parsed: {
        ...result,
        scan_engine: result.engine || 'local_ocr',
        document_expiry_date: result.expiry_date
      }
    };
  } catch (error) {
    console.error('local OCR error:', error.message || error);
    return { ok: false, message: 'สแกนเอกสารไม่สำเร็จ กรุณาถ่ายให้ชัดและลองใหม่' };
  }
}

async function checkDuplicateDocument({ nationalId, passportNumber, userId }) {
  if (nationalId) {
    const dup = await query(
      `SELECT uiv.user_id, u.email
       FROM user_identity_verifications uiv
       JOIN users u ON u.id = uiv.user_id
       WHERE uiv.national_id = $1
         AND uiv.status = 'verified'
         AND uiv.user_id <> $2
       LIMIT 1`,
      [nationalId, userId]
    );
    if (dup.rows[0]) {
      return { ok: false, message: 'เลขบัตรประชาชนนี้ถูกใช้ยืนยันตัวตนแล้ว' };
    }
  }

  if (passportNumber) {
    const dup = await query(
      `SELECT uiv.user_id, u.email
       FROM user_identity_verifications uiv
       JOIN users u ON u.id = uiv.user_id
       WHERE uiv.passport_number = $1
         AND uiv.status = 'verified'
         AND uiv.user_id <> $2
       LIMIT 1`,
      [passportNumber, userId]
    );
    if (dup.rows[0]) {
      return { ok: false, message: 'เลขหนังสือเดินทางนี้ถูกใช้ยืนยันตัวตนแล้ว' };
    }
  }

  return { ok: true };
}

function enrichIdentityAddress(data) {
  if (!data || data.document_type === 'passport') return data;

  const scanJson = data.scan_json || {};
  const rawFullAddress = normalizeDocText(
    scanJson.full_address
    || scanJson.address_full
    || data.full_address
    || ''
  );

  const parsed = parseThaiIdAddress(rawFullAddress || buildFullAddressText({
    full_address: rawFullAddress,
    address_line: data.address_line,
    subdistrict: data.subdistrict || scanJson.subdistrict,
    district: data.district || scanJson.district,
    province: data.province || scanJson.province
  }), {
    subdistrict: data.subdistrict || scanJson.subdistrict,
    district: data.district || scanJson.district,
    province: data.province || scanJson.province
  });

  const houseStreet = normalizeDocText(data.address_line);
  const addressLine = houseStreet && !hasThaiAdminMarker(houseStreet)
    ? houseStreet
    : (parsed.address_line || houseStreet);

  const subdistrict = parsed.subdistrict || data.subdistrict || scanJson.subdistrict || '';
  const district = parsed.district || data.district || scanJson.district || '';
  const province = parsed.province || data.province || scanJson.province || '';

  const postalCode = normalizeDigits(data.postal_code).slice(0, 5)
    || lookupPostalCode({ subdistrict, district, province });

  return {
    ...data,
    address_line: addressLine,
    subdistrict,
    district,
    province,
    postal_code: postalCode
  };
}

function finalizeVerifiedDocumentImage({ userId, sourceRelativePath }) {
  if (!sourceRelativePath) return '';

  const srcAbs = path.join(__dirname, '..', sourceRelativePath);
  if (!fs.existsSync(srcAbs)) return sourceRelativePath;

  const verifiedDir = path.join(UPLOAD_DIR, 'verified');
  fs.mkdirSync(verifiedDir, { recursive: true });
  const ext = path.extname(srcAbs) || '.jpg';
  const destName = `${userId}-verified${ext}`;
  const destAbs = path.join(verifiedDir, destName);
  fs.copyFileSync(srcAbs, destAbs);

  return path.join('uploads/identity-docs/verified', destName).replace(/\\/g, '/');
}

function normalizeScanResult(parsed, expectedDocumentType) {
  const confidence = Number(parsed.confidence || 0);
  const documentType = String(parsed.document_type || expectedDocumentType || '').trim().toLowerCase();

  const fullName = normalizeDocText(parsed.full_name);
  const addressLine = normalizeDocText(parsed.address_line);
  const subdistrict = normalizeDocText(parsed.subdistrict);
  const district = normalizeDocText(parsed.district);
  const province = normalizeDocText(parsed.province);
  const postalCode = normalizeDigits(parsed.postal_code).slice(0, 5);
  const dateOfBirth = parseIsoDate(parsed.date_of_birth);
  const expiryDate = parseIsoDate(parsed.expiry_date || parsed.document_expiry_date);

  let nationalId = '';
  let passportNumber = '';

  if (expectedDocumentType === 'thai_id') {
    const idCheck = validateThaiNationalId(parsed.national_id);
    if (!idCheck.ok) {
      return {
        ok: false,
        message: idCheck.message || 'อ่านเลขบัตรประชาชนไม่ได้ กรุณาถ่ายให้เห็นเลข 13 หลักชัดเจน'
      };
    }
    nationalId = idCheck.normalized;
  } else {
    const passportCheck = validatePassportNumber(parsed.passport_number);
    if (!passportCheck.ok) {
      return {
        ok: false,
        message: passportCheck.message || 'อ่านเลขพาสปอร์ตไม่ได้ กรุณาถ่ายใหม่'
      };
    }
    passportNumber = passportCheck.normalized;
  }

  if (!fullName) {
    return { ok: false, message: 'อ่านชื่อ-นามสกุลจากเอกสารไม่ได้ กรุณาถ่ายใหม่' };
  }

  if (!dateOfBirth) {
    return { ok: false, message: 'อ่านวันเดือนปีเกิดจากเอกสารไม่ได้ กรุณาถ่ายใหม่' };
  }

  if (!expiryDate) {
    return { ok: false, message: 'อ่านวันหมดอายุเอกสารไม่ได้ กรุณาถ่ายใหม่' };
  }

  if (isExpiredDate(expiryDate)) {
    return { ok: false, message: 'เอกสารหมดอายุแล้ว กรุณาใช้เอกสารที่ยังไม่หมดอายุ' };
  }

  if (expectedDocumentType === 'thai_id' && documentType && documentType !== 'thai_id') {
    return { ok: false, message: 'กรุณาอัปโหลดบัตรประชาชนไทย' };
  }

  if (expectedDocumentType === 'passport' && documentType && documentType !== 'passport') {
    return { ok: false, message: 'กรุณาอัปโหลดหนังสือเดินทาง (พาสปอร์ต)' };
  }

  return {
    ok: true,
    data: enrichIdentityAddress({
      document_type: expectedDocumentType,
      national_id: nationalId,
      passport_number: passportNumber,
      full_name: fullName,
      address_line: addressLine,
      subdistrict,
      district,
      province,
      postal_code: postalCode,
      date_of_birth: formatIsoDate(dateOfBirth),
      document_expiry_date: formatIsoDate(expiryDate),
      confidence: confidence || 0.8,
      scan_json: parsed
    })
  };
}

async function saveIdentityDocumentImage({ userId, file }) {
  if (!file?.buffer && !file?.path) {
    return { ok: false, message: 'ไม่พบไฟล์รูปเอกสาร' };
  }

  const mime = String(file.mimetype || '').toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, message: 'รองรับเฉพาะ JPG PNG WEBP' };
  }

  const size = Number(file.size || 0);
  if (size <= 0 || size > MAX_BYTES) {
    return { ok: false, message: 'ขนาดรูปต้องไม่เกิน 8 MB' };
  }

  ensureUploadDir();
  const storedName = `${userId}-${Date.now()}-${randomUUID()}${extForMime(mime)}`;
  const absPath = path.join(UPLOAD_DIR, storedName);
  const buffer = file.buffer || fs.readFileSync(file.path);
  fs.writeFileSync(absPath, buffer);

  return {
    ok: true,
    storedName,
    absPath,
    relativePath: path.join('uploads/identity-docs', storedName).replace(/\\/g, '/'),
    mimeType: mime
  };
}

async function scanIdentityDocument({ userId, file, documentType }) {
  const expectedDocumentType = documentType === 'passport' ? 'passport' : 'thai_id';
  const saved = await saveIdentityDocumentImage({ userId, file });
  if (!saved.ok) return saved;

  const ocrResult = await scanDocumentWithPython(saved.absPath, expectedDocumentType);
  if (!ocrResult.ok) return ocrResult;

  const normalized = normalizeScanResult(ocrResult.parsed, expectedDocumentType);
  if (!normalized.ok) return normalized;

  const duplicate = await checkDuplicateDocument({
    nationalId: normalized.data.national_id,
    passportNumber: normalized.data.passport_number,
    userId
  });
  if (!duplicate.ok) return duplicate;

  return {
    ok: true,
    ...normalized.data,
    document_image_path: saved.relativePath
  };
}

async function validateIdentityDocumentPayload({ userId, payload }) {
  const expectedDocumentType = payload.document_type === 'passport' ? 'passport' : 'thai_id';
  const normalized = normalizeScanResult(payload.scan_json || payload, expectedDocumentType);
  if (!normalized.ok) return normalized;

  const data = normalized.data;

  if (payload.full_name && normalizeDocText(payload.full_name) !== data.full_name) {
    return { ok: false, message: 'ชื่อ-นามสกุลไม่ตรงกับข้อมูลจากเอกสาร' };
  }

  if (expectedDocumentType === 'thai_id') {
    const submittedId = validateThaiNationalId(payload.national_id);
    if (!submittedId.ok) return submittedId;
    if (submittedId.normalized !== data.national_id) {
      return { ok: false, message: 'เลขบัตรประชาชนไม่ตรงกับข้อมูลจากเอกสาร' };
    }
  } else {
    const submittedPassport = validatePassportNumber(payload.passport_number);
    if (!submittedPassport.ok) return submittedPassport;
    if (submittedPassport.normalized !== data.passport_number) {
      return { ok: false, message: 'เลขพาสปอร์ตไม่ตรงกับข้อมูลจากเอกสาร' };
    }
  }

  const duplicate = await checkDuplicateDocument({
    nationalId: data.national_id,
    passportNumber: data.passport_number,
    userId
  });
  if (!duplicate.ok) return duplicate;

  return {
    ok: true,
    data: {
      ...data,
      document_image_path: String(payload.document_image_path || '').trim()
    }
  };
}

module.exports = {
  scanIdentityDocument,
  validateIdentityDocumentPayload,
  validateThaiNationalId,
  validatePassportNumber,
  checkDuplicateDocument,
  enrichIdentityAddress,
  finalizeVerifiedDocumentImage
};
