'use strict';

const { query } = require('../config/database');

const DEFAULT_TEMPORARY = 1;
const DEFAULT_PERMANENT = 10;

let columnsReady = false;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPortScoinAmount(value) {
  const n = num(value, 0);
  if (n <= 0) return '0';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function formatPortScoinLabel(value) {
  return `${formatPortScoinAmount(value)} Scoin`;
}

function resolveQuery(runner = query) {
  if (typeof runner === 'function') return runner;
  if (runner && typeof runner.query === 'function') {
    return (sql, params) => runner.query(sql, params);
  }
  return query;
}

async function ensureMt5PortScoinColumns(runner = query) {
  const q = resolveQuery(runner);
  if (columnsReady) return;
  await q(`
    ALTER TABLE scoin_settings
    ADD COLUMN IF NOT EXISTS mt5_port_temp_scoin NUMERIC(18,4) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS mt5_port_perm_scoin NUMERIC(18,4) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS mt5_port_scoin_updated_at TIMESTAMPTZ
  `).catch(() => {});
  columnsReady = true;
}

async function getMt5PortScoinPrices(runner = query) {
  const q = resolveQuery(runner);
  await ensureMt5PortScoinColumns(q);
  const res = await q(`
    SELECT
      COALESCE(mt5_port_temp_scoin, ${DEFAULT_TEMPORARY}) AS temporary,
      COALESCE(mt5_port_perm_scoin, ${DEFAULT_PERMANENT}) AS permanent,
      mt5_port_scoin_updated_at AS updated_at
    FROM scoin_settings
    WHERE id = 1
    LIMIT 1
  `).catch(() => ({ rows: [] }));

  const row = res.rows?.[0] || {};
  return {
    temporary: Math.max(0, num(row.temporary, DEFAULT_TEMPORARY)),
    permanent: Math.max(0, num(row.permanent, DEFAULT_PERMANENT)),
    updated_at: row.updated_at || null
  };
}

async function getMt5PortScoinPrice(portType, runner = query) {
  const prices = await getMt5PortScoinPrices(runner);
  return String(portType || '').toLowerCase() === 'permanent'
    ? prices.permanent
    : prices.temporary;
}

async function updateMt5PortScoinPrices({ temporary, permanent }, runner = query) {
  const q = resolveQuery(runner);
  await ensureMt5PortScoinColumns(q);
  const temp = Math.max(0, num(temporary, DEFAULT_TEMPORARY));
  const perm = Math.max(0, num(permanent, DEFAULT_PERMANENT));

  await q(`
    INSERT INTO scoin_settings (id, coin_name, coin_symbol, current_price_thb, transfer_fee_percent, is_enabled, updated_at)
    VALUES (1, 'Scoin', 'SCOIN', 0.10, 1.20, TRUE, NOW())
    ON CONFLICT (id) DO NOTHING
  `).catch(() => {});

  await q(`
    UPDATE scoin_settings
    SET
      mt5_port_temp_scoin = $1,
      mt5_port_perm_scoin = $2,
      mt5_port_scoin_updated_at = NOW(),
      updated_at = NOW()
    WHERE id = 1
  `, [temp, perm]);

  return { temporary: temp, permanent: perm };
}

module.exports = {
  DEFAULT_TEMPORARY,
  DEFAULT_PERMANENT,
  formatPortScoinAmount,
  formatPortScoinLabel,
  ensureMt5PortScoinColumns,
  getMt5PortScoinPrices,
  getMt5PortScoinPrice,
  updateMt5PortScoinPrices
};
