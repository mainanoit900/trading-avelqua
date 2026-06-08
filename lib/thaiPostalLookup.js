'use strict';

const fs = require('fs');
const path = require('path');
const { stripAdminPrefix } = require('./thaiAddressParser');

const INDEX_PATH = path.join(__dirname, '../data/thai-postal-index.json');
let rows = null;

function normalizeKey(value) {
  return stripAdminPrefix(value)
    .replace(/\s+/g, '')
    .replace(/[^\u0E00-\u0E7Fa-z0-9]/gi, '')
    .toLowerCase();
}

function loadRows() {
  if (rows) return rows;
  if (!fs.existsSync(INDEX_PATH)) {
    rows = [];
    return rows;
  }
  rows = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  return rows;
}

function scoreMatch(row, subdistrict, district, province) {
  const sub = normalizeKey(subdistrict);
  const dist = normalizeKey(district);
  const prov = normalizeKey(province);
  const rSub = normalizeKey(row.s);
  const rDist = normalizeKey(row.d);
  const rProv = normalizeKey(row.p);

  let score = 0;

  if (sub) {
    if (rSub === sub) score += 4;
    else if (rSub.includes(sub) || sub.includes(rSub)) score += 3;
  }

  if (dist && prov) {
    if (rDist === dist && rProv === prov) score += 4;
    else {
      if (rDist.includes(dist) || dist.includes(rDist)) score += 2;
      if (rProv.includes(prov) || prov.includes(rProv)) score += 2;
    }
  } else if (dist) {
    if (rDist === dist || rDist.includes(dist) || dist.includes(rDist)) score += 2;
  } else if (prov) {
    if (rProv === prov || rProv.includes(prov) || prov.includes(rProv)) score += 1;
  }

  return score;
}

function lookupPostalCode({ subdistrict, district, province }) {
  const data = loadRows();
  if (!data.length) return '';

  const sub = normalizeKey(subdistrict);
  const dist = normalizeKey(district);
  const prov = normalizeKey(province);

  if (!dist && !prov && !sub) return '';

  let best = null;
  let bestScore = 0;

  for (const row of data) {
    const score = scoreMatch(row, subdistrict, district, province);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  // ตำบล + อำเภอ + จังหวัด ครบ
  if (best && bestScore >= 6) {
    return String(best.z || '').slice(0, 5);
  }

  // อำเภอ + จังหวัด (ไม่มีตำบล หรือจับคู่ตำบลไม่ได้)
  if (dist && prov) {
    for (const row of data) {
      const score = scoreMatch(row, '', district, province);
      if (score >= 4) {
        return String(row.z || '').slice(0, 5);
      }
    }
  }

  // ตำบล + จังหวัด
  if (sub && prov && best && bestScore >= 4) {
    return String(best.z || '').slice(0, 5);
  }

  return '';
}

module.exports = {
  lookupPostalCode
};
