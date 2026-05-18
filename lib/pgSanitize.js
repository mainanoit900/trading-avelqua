'use strict';

/** ลบ null byte และ control chars ที่ PostgreSQL text/jsonb รับไม่ได้ */
function sanitizePgText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
}

function deepSanitizeForPg(value, depth = 0) {
  if (depth > 14) return null;
  if (value == null) return value;
  if (typeof value === 'string') return sanitizePgText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.map((v) => deepSanitizeForPg(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepSanitizeForPg(v, depth + 1);
    }
    return out;
  }
  return sanitizePgText(value);
}

/** ค่าที่ส่งเข้า ::jsonb ผ่าน parameter (กัน PG 22P05 จาก \\u0000 ใน JSON) */
function toJsonbParam(value) {
  let raw = deepSanitizeForPg(value);
  if (raw && typeof raw === 'object') {
    if (typeof raw.content === 'string' && raw.content.length > 12000) {
      raw.content = sanitizePgText(raw.content).slice(-12000);
    }
    if (typeof raw.journalEvidence === 'string') {
      raw.journalEvidence = sanitizePgText(raw.journalEvidence).slice(-8000);
    }
  }
  let s = JSON.stringify(raw);
  s = s.replace(/\u0000/g, '').replace(/\\u0000/g, ' ');
  return s;
}

module.exports = {
  sanitizePgText,
  deepSanitizeForPg,
  toJsonbParam
};
