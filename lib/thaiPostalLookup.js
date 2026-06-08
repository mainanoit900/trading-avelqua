'use strict';

const fs = require('fs');
const path = require('path');
const { stripAdminPrefix } = require('./thaiAddressParser');

const INDEX_PATH = path.join(__dirname, '../data/thai-postal-index.json');
let rows = null;

function normalizeKey(value) {
  return stripAdminPrefix(value)
    .replace(/\s+/g, '')
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

  if (!sub || !dist || !prov) return 0;

  let score = 0;
  if (rSub === sub || rSub.includes(sub) || sub.includes(rSub)) score += 3;
  if (rDist === dist || rDist.includes(dist) || dist.includes(rDist)) score += 2;
  if (rProv === prov || rProv.includes(prov) || prov.includes(rProv)) score += 1;
  return score;
}

function lookupPostalCode({ subdistrict, district, province }) {
  const data = loadRows();
  if (!data.length) return '';

  let best = null;
  let bestScore = 0;

  for (const row of data) {
    const score = scoreMatch(row, subdistrict, district, province);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (!best || bestScore < 5) return '';
  return String(best.z || '').slice(0, 5);
}

module.exports = {
  lookupPostalCode
};
