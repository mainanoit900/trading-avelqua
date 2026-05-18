const { query } = require('../config/database');

function mapPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.package_code || '',
    group: String(row.group_name || 'BASIC').toLowerCase(),
    name: row.name_th || row.name_en || '',
    nameTh: row.name_th || '',
    nameEn: row.name_en || '',
    days: Number(row.days || 0),
    price: Number(row.price || 0),
    lot: `${Number(row.lot_min || 0)} - ${Number(row.lot_max || 0)}`,
    ports: `${Number(row.ports_min || 0)} - ${Number(row.ports_max || 0)}`,
    profit: row.profit_label_th || '',
    support: row.support_th || '',
    summary: row.summary_th || row.summary_en || '',
    summaryTh: row.summary_th || '',
    summaryEn: row.summary_en || '',
    enabled: !!row.is_enabled,
    avgPerDay: row.days ? Math.round(Number(row.price || 0) / Number(row.days || 1)) : 0,
    lotMin: Number(row.lot_min || 0),
    lotMax: Number(row.lot_max || 0),
    portMin: Number(row.ports_min || 0),
    portMax: Number(row.ports_max || 0)
  };
}

async function listPackages() {
  const result = await query(`SELECT * FROM packages WHERE is_enabled = TRUE ORDER BY group_name ASC, days ASC, id ASC`);
  return result.rows.map(mapPackage);
}

module.exports = { listPackages };
