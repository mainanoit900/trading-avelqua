'use strict';

function normalizeDocText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripAdminPrefix(value) {
  return normalizeDocText(value)
    .replace(/^(แขวง|ตำบล|ต\.|เขต|อำเภอ|อ\.|จ\.|จังหวัด)\s*/u, '')
    .trim();
}

function parseThaiIdAddress(rawAddress, parts = {}) {
  const full = normalizeDocText(rawAddress);
  let subdistrict = stripAdminPrefix(parts.subdistrict || '');
  let district = stripAdminPrefix(parts.district || '');
  let province = stripAdminPrefix(parts.province || '');

  if (full) {
    const subMatch = full.match(/(?:แขวง|ต\.|ตำบล)\s*([^,\n]+?)(?=\s*(?:เขต|อ\.|อำเภอ|จ\.|จังหวัด|กรุงเทพ|$))/u);
    if (subMatch && !subdistrict) {
      subdistrict = stripAdminPrefix(subMatch[1]);
    }

    const distMatch = full.match(/(?:เขต|อ\.|อำเภอ)\s*([^,\n]+?)(?=\s*(?:จ\.|จังหวัด|กรุงเทพ|$))/u);
    if (distMatch && !district) {
      district = stripAdminPrefix(distMatch[1]);
    }

    const provMatch = full.match(/(?:จ\.|จังหวัด)\s*([^\s,]+(?:\s+[^\s,]+)?)|(?:^|\s)(กรุงเทพมหานคร)(?:\s|$)/u);
    if (provMatch && !province) {
      province = stripAdminPrefix(provMatch[1] || provMatch[2] || '');
    }
  }

  let addressLine = full;
  if (full) {
    const houseStreetMatch = full.match(/^(.+?)(?=\s*(?:แขวง|ต\.|ตำบล|เขต|อ\.|อำเภอ|จ\.|จังหวัด|กรุงเทพมหานคร))/u);
    if (houseStreetMatch) {
      addressLine = normalizeDocText(houseStreetMatch[1]);
    }
  }

  if (!addressLine && full) {
    addressLine = full;
  }

  return {
    address_line: addressLine,
    subdistrict,
    district,
    province
  };
}

function buildFullAddressText(parts = {}) {
  const chunks = [
    parts.address_line,
    parts.full_address,
    parts.subdistrict ? `ต.${parts.subdistrict}` : '',
    parts.district ? `อ.${parts.district}` : '',
    parts.province ? `จ.${parts.province}` : ''
  ].map((item) => normalizeDocText(item)).filter(Boolean);

  return normalizeDocText(chunks.join(' '));
}

function hasThaiAdminMarker(text) {
  return /(?:แขวง|ต\.|ตำบล|เขต|อ\.|อำเภอ|จ\.|จังหวัด|กรุงเทพมหานคร)/u.test(String(text || ''));
}

module.exports = {
  parseThaiIdAddress,
  buildFullAddressText,
  hasThaiAdminMarker,
  stripAdminPrefix,
  normalizeDocText
};
