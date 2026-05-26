'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data', 'mt5-presets');
const MIN_RUN_CAPITAL = 100;

const BOT_PRESET_SLUG = {
  'AK-SNIPER-VIP-VER4.0': 'ak-sniper',
  'AK-SNIPER': 'ak-sniper',
  'PA-SNIPER-VER2.0': 'pa-sniper',
  'PA-SNIPER': 'pa-sniper',
  '5PA-SNIPER': '5pa-sniper',
  'SNIPER-DEMO': 'sniper-demo',
  'sniper-demo': 'sniper-demo'
};

const PRODUCTION_BOT_CODE_LIST = [
  'AK-SNIPER-VIP-VER4.0',
  '5PA-SNIPER',
  'PA-SNIPER-VER2.0',
  'SNIPER-DEMO'
];

const PRODUCTION_BOT_CODES = new Set(
  PRODUCTION_BOT_CODE_LIST.map((code) => String(code || '').trim().toUpperCase())
);

const PACKAGE_LOT_POLICY = {
  BASIC: { lotMin: 0.01, lotMax: 0.05 },
  PRO: { lotMin: 0.01, lotMax: 0.19 },
  ADVANCED: { lotMin: 0.01, lotMax: 0.19 }
};

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function packageGroupFromSummary(summary) {
  const pkg = summary?.pkg || summary || {};
  return String(pkg.package_group || pkg.group_name || 'BASIC').trim().toUpperCase();
}

function packageLotLimits(summary) {
  const group = packageGroupFromSummary(summary);
  const policy = PACKAGE_LOT_POLICY[group] || PACKAGE_LOT_POLICY.BASIC;
  return {
    packageGroup: group,
    lotMin: policy.lotMin,
    lotMax: policy.lotMax,
    defaultLot: policy.lotMax
  };
}

function presetSlugForBot(bot) {
  if (!bot) return '';
  const code = String(bot.bot_code || bot.code || '').trim();
  return BOT_PRESET_SLUG[code] || BOT_PRESET_SLUG[code.toUpperCase()] || '';
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

function nearestPresetRowByLot(rows, lot) {
  const target = num(lot, 0);
  if (!rows || !rows.length || target <= 0) return null;
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

function normalizeTradeLevel(level) {
  const l = String(level || '').trim().toLowerCase();
  if (l === 'high' || l === 'fast') return 'high';
  if (l === 'medium') return 'medium';
  if (l === 'low' || l === 'safe') return 'low';
  return 'medium';
}

function tradeLevelLabel(level) {
  const l = normalizeTradeLevel(level);
  if (l === 'high') return 'เสี่ยงสูง';
  if (l === 'medium') return 'เสี่ยงกลาง';
  return 'เสี่ยงต่ำ';
}

function settingFromPresetRow(preset, level) {
  const l = normalizeTradeLevel(level);
  if (!preset) return { trade_level: l, t_start: 0, t_stop: 0 };
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

function clampLot(lot, lotMin, lotMax) {
  let value = num(lot, lotMin || 0.01);
  const min = num(lotMin, 0.01);
  const max = Math.max(min, num(lotMax, min));
  if (value < min) value = min;
  if (value > max) value = max;
  return Number(value.toFixed(2));
}

function computePresetForBot(bot, capital, tradeLevel, manualLot, lotMin, lotMax, packageDefaultLot) {
  const slug = presetSlugForBot(bot);
  const rows = readPresetRows(slug);
  const requestedLot = num(manualLot, 0) > 0 ? num(manualLot) : num(packageDefaultLot, lotMax);
  const lot = clampLot(requestedLot || lotMax, lotMin, lotMax);
  const preset = nearestPresetRowByLot(rows, lot) || nearestPresetRow(rows, capital) || null;
  const trade = settingFromPresetRow(preset, tradeLevel);
  const lotPlus = clampLot(preset ? num(preset.lot_plus, lot) : lot, lotMin, lotMax);
  return {
    presetSlug: slug,
    preset,
    trade,
    lot,
    lotPlus,
    suggestedLot: lot,
    packageDefaultLot: clampLot(packageDefaultLot || lotMax, lotMin, lotMax)
  };
}

function isProductionBot(bot) {
  const code = String(bot?.bot_code || bot?.code || '').trim().toUpperCase();
  return Boolean(code && PRODUCTION_BOT_CODES.has(code));
}

function validateRunCapital(capital) {
  const cap = num(capital, 0);
  if (cap < MIN_RUN_CAPITAL) {
    return {
      ok: false,
      message: `เงินทุนต้องไม่ต่ำกว่า ${MIN_RUN_CAPITAL}`
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
  clampLot,
  computePresetForBot,
  isProductionBot,
  validateRunCapital
};
