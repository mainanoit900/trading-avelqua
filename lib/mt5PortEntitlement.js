/** สิทธิ์ PORT MT5: แพ็กเกจให้ 1 ช่อง, เพิ่มชั่วคราว/ถาวรไม่เกินเพดาน tier */

const PACKAGE_PORT_MAP = { BASIC: 4, PRO: 6, ADVANCED: 10 };
const PACKAGE_INCLUDED_PORTS = 1;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function packagePortCapForGroup(packageGroup, fallbackMax = 1) {
  const group = String(packageGroup || '').toUpperCase().trim();
  return PACKAGE_PORT_MAP[group] || Math.max(1, num(fallbackMax, 1));
}

function packagePortRangeLabel(packageMaxPorts) {
  const cap = Math.max(0, num(packageMaxPorts));
  if (cap <= 0) return '0';
  return `1 - ${cap}`;
}

/**
 * @param {number} packageMaxPorts เพดาน tier (BASIC 4 / PRO 6 / ADVANCED 10)
 * @param {Array} extraPortRows แถว mt5_extra_ports ที่ active
 */
function computePortEntitlement(packageMaxPorts, extraPortRows, packageGroup = '') {
  const cap = Math.max(0, num(packageMaxPorts));
  const group = String(packageGroup || '').toUpperCase().trim();
  let temporaryExtra = 0;
  let permanentExtra = 0;

  for (const row of extraPortRows || []) {
    const qty = Math.max(1, num(row.qty, 1));
    const type = String(row.port_type || 'temporary').toLowerCase();
    if (type === 'permanent') {
      const rowGroup = String(row.package_group || '').toUpperCase().trim();
      if (!group || !rowGroup || rowGroup === group) permanentExtra += qty;
    } else if (!row.is_expired) {
      temporaryExtra += qty;
    }
  }

  const includedPorts = cap > 0 ? PACKAGE_INCLUDED_PORTS : 0;
  const rawTotal = includedPorts + temporaryExtra + permanentExtra;
  const totalPorts = Math.min(cap, rawTotal);

  return {
    packageMaxPorts: cap,
    includedPorts,
    temporaryExtra,
    permanentExtra,
    totalPorts,
    maxExtraPurchases: cap,
    canAddTemporary: cap > 0 && temporaryExtra < cap && rawTotal < cap,
    canAddPermanent: cap > 0 && rawTotal < cap
  };
}

module.exports = {
  PACKAGE_PORT_MAP,
  PACKAGE_INCLUDED_PORTS,
  packagePortCapForGroup,
  packagePortRangeLabel,
  computePortEntitlement
};
