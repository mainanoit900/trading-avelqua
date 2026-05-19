'use strict';

const fs = require('fs');
const path = require('path');
const { eaDefaultsForSlug } = require('./mt5EaSet');

const DATA_DIR = path.join(process.cwd(), 'data', 'mt5-presets');
const MIN_RUN_CAPITAL = 100;

/** bot_code ใน catalog → slug ตาราง admin */
const BOT_PRESET_SLUG = {
  'AK-SNIPER-VIP-VER4.0': 'ak-sniper',
  'AK-SNIPER': 'ak-sniper',
  'PA-SNIPER-VER2.0': 'pa-sniper',
  'PA-SNIPER': 'pa-sniper',
  '5PA-SNIPER': '5pa-sniper',
  'SNIPER-DEMO': 'sniper-demo',
  'BOT_TEST': 'sniper-demo',
  'BOT_Test': 'sniper-demo',
  'sniper-demo': 'sniper-demo'
};

const PRODUCTION_BOT_CODE_LIST = [
  'AK-SNIPER-VIP-VER4.0',
  'PA-SNIPER-VER2.0',
  '5PA-SNIPER',
  'sniper-demo'
];

const PRODUCTION_BOT_CODES = new Set(
  PRODUCTION_BOT_CODE_LIST.map((c) => String(c).trim().toUpperCase())
);

/** ค่าเริ่มต้นเมื่อ packages ไม่มี lot_min/lot_max */
const PACKAGE_LOT_POLICY = {
  BASIC: { lotMin: 0.01, lotMax: 0.5 },
  PRO: { lotMin: 0.01, lotMax: 0.5 },
  ADVANCED: { lotMin: 0.01, lotMax: 0.5 }
};

function packageGroupFromSummary(summary) {
  const pkg = summary?.pkg || summary || {};
  return String(pkg.package_group || pkg.group_name || 'BASIC').trim().toUpperCase();
}

function packageLotLimits(summary) {
  const group = packageGroupFromSummary(summary);
  const policy = PACKAGE_LOT_POLICY[group] || PACKAGE_LOT_POLICY.BASIC;
  const pkg = summary?.pkg || {};
  const dbMin = num(pkg.lot_min, 0);
  const dbMax = num(pkg.lot_max, 0);
  const lotMin = dbMin > 0 ? dbMin : policy.lotMin;
  let lotMax = dbMax > 0 ? dbMax : policy.lotMax;
  if (lotMax < lotMin) lotMax = lotMin;
  return {
    packageGroup: group,
    lotMin,
    lotMax,
    defaultLot: lotMax
  };
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function presetSlugForBot(bot) {
  if (!bot) return '';
  const code = String(bot.bot_code || bot.code || '').trim().toUpperCase();
  if (BOT_PRESET_SLUG[code]) return BOT_PRESET_SLUG[code];
  try {
    const pj = typeof bot.preset_json === 'string' ? JSON.parse(bot.preset_json) : bot.preset_json;
    if (pj && pj.preset_slug) return String(pj.preset_slug).trim().toLowerCase();
  } catch (_) {}
  return '';
}

function readPresetRows(slug) {
  if (!slug) return [];
  const file = path.join(DATA_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** อิงแถวตารางจาก LOT SIZE (ตาม admin) */
function nearestPresetRowByLot(rows, lot) {
  const target = num(lot, 0);
  if (!rows || !rows.length || target <= 0) return null;
  let exact = null;
  for (const row of rows) {
    if (Math.abs(num(row.lot_size, 0) - target) < 0.0001) {
      exact = row;
      break;
    }
  }
  if (exact) return exact;
  let best = rows[0];
  let bestDiff = Math.abs(num(best.lot_size, 0) - target);
  for (const row of rows) {
    const diff = Math.abs(num(row.lot_size, 0) - target);
    if (diff < bestDiff) {
      best = row;
      bestDiff = diff;
    }
  }
  return best;
}

function nearestPresetRow(rows, capital) {
  const cap = num(capital, 0);
  if (!rows || !rows.length) return null;
  let best = rows[0];
  let bestDiff = Math.abs(num(best.capital_recommend, 0) - cap);
  for (const row of rows) {
    const diff = Math.abs(num(row.capital_recommend, 0) - cap);
    if (diff < bestDiff) {
      best = row;
      bestDiff = diff;
    }
  }
  return best;
}

/** 🔴 สูง → t_* · 🟡 กลาง → medium_* · 🟢 ต่ำ → fast_* (ตามหัวตาราง admin) */
function normalizeTradeLevel(level) {
  const l = String(level || '').toLowerCase();
  if (l === 'high' || l === 'fast') return 'high';
  if (l === 'medium') return 'medium';
  if (l === 'low' || l === 'safe') return 'low';
  return 'medium';
}

function tradeLevelLabel(level) {
  const l = normalizeTradeLevel(level);
  if (l === 'high') return '🔴 เสี่ยงสูง';
  if (l === 'medium') return '🟡 เสี่ยงกลาง';
  return '🟢 เสี่ยงต่ำ';
}

function settingFromPresetRow(preset, level) {
  if (!preset) {
    const n = normalizeTradeLevel(level);
    return { trade_level: n, t_start: 0, t_stop: 0 };
  }
  const l = normalizeTradeLevel(level);
  if (l === 'high') {
    return {
      trade_level: 'high',
      t_start: num(preset.t_start),
      t_stop: num(preset.t_stop)
    };
  }
  if (l === 'medium') {
    return {
      trade_level: 'medium',
      t_start: num(preset.medium_t_start || preset.t_start),
      t_stop: num(preset.medium_t_stop || preset.t_stop)
    };
  }
  return {
    trade_level: 'low',
    t_start: num(preset.fast_t_start || preset.medium_t_start || preset.t_start),
    t_stop: num(preset.fast_t_stop || preset.medium_t_stop || preset.t_stop)
  };
}

/** ทุนตรงตาราง → ใช้ทุนเซฟจากตาราง · ไม่ตรง → 200% / 300% */
function resolveCapitalBounds(preset, userCapital) {
  const cap = num(userCapital, 0);
  if (cap <= 0) {
    return {
      capital_recommend: null,
      capital_safe: null,
      capital_max_safe: null,
      capitalFromTable: false
    };
  }
  if (!preset) {
    return {
      capital_recommend: cap,
      capital_safe: Math.round(cap * 2 * 100) / 100,
      capital_max_safe: Math.round(cap * 3 * 100) / 100,
      capitalFromTable: false
    };
  }
  const rec = num(preset.capital_recommend, 0);
  const tol = Math.max(5, rec * 0.05);
  const matchesTable = rec > 0 && Math.abs(rec - cap) <= tol;
  if (matchesTable) {
    return {
      capital_recommend: rec,
      capital_safe: num(preset.capital_safe, cap * 2),
      capital_max_safe: num(preset.capital_max_safe, cap * 3),
      capitalFromTable: true
    };
  }
  return {
    capital_recommend: rec || cap,
    capital_safe: Math.round(cap * 2 * 100) / 100,
    capital_max_safe: Math.round(cap * 3 * 100) / 100,
    capitalFromTable: false
  };
}

function clampLot(lot, lotMin, lotMax) {
  let v = num(lot, 0.01);
  const min = num(lotMin, 0.01);
  const max = num(lotMax, min);
  if (v < min) v = min;
  if (v > max) v = max;
  return Number(v.toFixed(2));
}

function resolveRunLot({
  preset,
  manualLot,
  botDefaultLot,
  botMaxLot,
  lotMin,
  lotMax,
  packageDefaultLot
}) {
  const effectiveMax = Math.min(
    num(lotMax, 0.5),
    num(botMaxLot, 0) > 0 ? num(botMaxLot) : num(lotMax, 0.5)
  );
  const pkgLot = num(packageDefaultLot, effectiveMax) || effectiveMax;
  const fromPreset = preset ? num(preset.lot_size, pkgLot) : pkgLot;
  const suggested = num(manualLot, 0) > 0 ? num(manualLot) : pkgLot;
  const raw = num(manualLot, 0) > 0 ? num(manualLot) : pkgLot;
  return {
    suggestedLot: clampLot(suggested || fromPreset || pkgLot, lotMin, effectiveMax),
    lot: clampLot(raw || pkgLot, lotMin, effectiveMax),
    packageDefaultLot: clampLot(pkgLot, lotMin, effectiveMax)
  };
}

function computePresetForBot(bot, capital, tradeLevel, manualLot, lotMin, lotMax, packageDefaultLot) {
  const slug = presetSlugForBot(bot);
  const rows = readPresetRows(slug);
  const lots = resolveRunLot({
    preset: null,
    manualLot,
    botDefaultLot: bot?.default_lot,
    botMaxLot: bot?.max_lot,
    lotMin,
    lotMax,
    packageDefaultLot
  });
  const preset =
    nearestPresetRowByLot(rows, lots.lot) ||
    nearestPresetRow(rows, capital) ||
    null;
  const trade = settingFromPresetRow(preset, tradeLevel);
  const capBounds = resolveCapitalBounds(preset, capital);
  const lotPlus = preset ? num(preset.lot_plus, lots.lot) : lots.lot;

  const defs = slug ? eaDefaultsForSlug(slug) : {};

  return {
    presetSlug: slug,
    preset,
    trade,
    lot: lots.lot,
    lotPlus: clampLot(lotPlus, lotMin, lotMax),
    pip_step: preset?.pip_step != null && preset.pip_step !== '' ? num(preset.pip_step) : defs.pip_step,
    take_profit_average:
      preset?.take_profit_average != null && preset.take_profit_average !== ''
        ? num(preset.take_profit_average)
        : defs.take_profit_average,
    suggestedLot: lots.suggestedLot,
    packageDefaultLot: lots.packageDefaultLot,
    capital_recommend: capBounds.capital_recommend,
    capital_safe: capBounds.capital_safe,
    capital_max_safe: capBounds.capital_max_safe,
    capitalFromTable: capBounds.capitalFromTable,
    matchedByLot: !!(preset && Math.abs(num(preset.lot_size) - lots.lot) < 0.0001),
    expertsPathHint: slug
      ? `MQL5\\Experts\\Trading Bot\\${String(bot?.bot_code || 'EA')}.ex5`
      : ''
  };
}

function isProductionBot(bot) {
  const code = String(bot?.bot_code || bot?.code || '').trim().toUpperCase();
  if (!code) return false;
  return PRODUCTION_BOT_CODES.has(code);
}

function validateRunCapital(capital) {
  const cap = num(capital, 0);
  if (cap < MIN_RUN_CAPITAL) {
    return {
      ok: false,
      message: `เงินทุนต้องไม่ต่ำกว่า $${MIN_RUN_CAPITAL} (ดึงจาก MT5 หรือใส่เอง)`
    };
  }
  return { ok: true, capital: cap };
}

module.exports = {
  MIN_RUN_CAPITAL,
  BOT_PRESET_SLUG,
  PRODUCTION_BOT_CODE_LIST,
  PRODUCTION_BOT_CODES,
  PACKAGE_LOT_POLICY,
  packageGroupFromSummary,
  packageLotLimits,
  presetSlugForBot,
  readPresetRows,
  nearestPresetRow,
  nearestPresetRowByLot,
  normalizeTradeLevel,
  tradeLevelLabel,
  settingFromPresetRow,
  resolveCapitalBounds,
  clampLot,
  resolveRunLot,
  computePresetForBot,
  isProductionBot,
  validateRunCapital
};
