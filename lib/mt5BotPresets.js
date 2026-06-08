'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data', 'mt5-presets');
const MIN_RUN_CAPITAL = 100;
const DEFAULT_PIP_STEP = 345;
const DEFAULT_TAKE_PROFIT_AVERAGE = 100;
const CAPITAL_PER_001_LOT = 10000; // $100 → 0.01 lot (USD base)
// Currency scale: 1=USD (login 8xxxx), 100=US Cent (login 2xxxxxxxx)
const CURRENCY_SCALE_USD = 1;
const CURRENCY_SCALE_CENT = 100;

const PRODUCTION_BOT_CODE_LIST = [
  'AK-SNIPER-VIP-VER4.0',
  'QUEEN-SNIPER-AI-V1.0',
  'Quantum-Queen-MT5-3.65',
  'SNIPER-AI-TRADING'
];

const PRODUCTION_BOT_CODES = new Set(
  PRODUCTION_BOT_CODE_LIST.map((code) => String(code || '').trim().toUpperCase())
);

// Min capitals in USD — multiply by currencyScale for actual display
const BOT_MIN_CAPITAL_USD = {
  'AK-SNIPER-VIP-VER4.0': 100,
  'QUEEN-SNIPER-AI-V1.0': 100,
  'QUANTUM-QUEEN-MT5-3.65': 500,
  'SNIPER-AI-TRADING': 100
};

// Backward-compat alias — kept in sync with BOT_MIN_CAPITAL_USD
const BOT_MIN_CAPITAL = {
  'AK-SNIPER-VIP-VER4.0': 100,
  'QUEEN-SNIPER-AI-V1.0': 100,
  'QUANTUM-QUEEN-MT5-3.65': 500,
  'SNIPER-AI-TRADING': 100
};

function isUsdLogin(mt5Login) {
  return /^8/.test(String(mt5Login || '').trim());
}

function loginCurrencyScale(mt5Login) {
  return isUsdLogin(mt5Login) ? CURRENCY_SCALE_USD : CURRENCY_SCALE_CENT;
}

function loginCurrencyLabel(mt5Login) {
  return isUsdLogin(mt5Login) ? 'USD' : 'US Cent';
}

function minCapitalForBotScaled(botCodeKey, currencyScale) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD);
  const usdMin = BOT_MIN_CAPITAL_USD[botCodeKey] || MIN_RUN_CAPITAL;
  return usdMin * scale;
}

const BOT_CHART_PERIOD = {
  'AK-SNIPER-VIP-VER4.0': 'M15',
  'QUEEN-SNIPER-AI-V1.0': 'M15',
  'QUANTUM-QUEEN-MT5-3.65': 'M15',
  'SNIPER-AI-TRADING': 'M5'
};

const PACKAGE_LOT_POLICY = {
  BASIC: { lotMin: 0.01, lotMax: 0.05 },
  PRO: { lotMin: 0.01, lotMax: 0.19 },
  ADVANCED: { lotMin: 0.01, lotMax: 0.19 }
};

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function botCodeKey(bot) {
  return String(bot?.bot_code || bot?.code || bot || '').trim().toUpperCase();
}

function botKind(bot) {
  const code = botCodeKey(bot);
  if (code.includes('SNIPER-AI-TRADING')) return 'sniper_ai';
  if (code.includes('QUEEN-SNIPER') && !code.includes('QUANTUM')) return 'queen';
  if (code.includes('QUANTUM-QUEEN')) return 'quantum';
  if (code.includes('AK-SNIPER')) return 'ak';
  return 'legacy';
}

function packageGroupFromSummary(summary) {
  const pkg = summary?.pkg || summary || {};
  return String(pkg.package_group || pkg.group_name || 'BASIC').trim().toUpperCase();
}

function packageLotLimits(summary) {
  const group = packageGroupFromSummary(summary);
  const policy = PACKAGE_LOT_POLICY[group] || PACKAGE_LOT_POLICY.BASIC;
  const pkg = summary?.pkg || summary || {};
  const dbLotMin = num(pkg.lot_min, 0);
  const dbLotMax = num(pkg.lot_max, 0);
  const lotMin = dbLotMin > 0 ? dbLotMin : policy.lotMin;
  const lotMax = Math.max(lotMin, dbLotMax > 0 ? dbLotMax : policy.lotMax);
  const defaultLot = Math.min(Math.max(policy.lotMax, lotMin), lotMax);
  return {
    packageGroup: group,
    lotMin,
    lotMax,
    defaultLot
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

function lotFromCapital(capital, currencyScale = CURRENCY_SCALE_USD) {
  const cap = num(capital, 0);
  if (cap <= 0) return 0;
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  // USD: 100 cap = 0.01 lot (cap/10000); US Cent: 10000 cap = 0.01 lot (cap/1000000)
  return Number((cap / (10000 * scale)).toFixed(4));
}

function capitalFromLot(lot, currencyScale = CURRENCY_SCALE_USD) {
  const l = num(lot, 0);
  if (l <= 0) return 0;
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  return Number((l * CAPITAL_PER_001_LOT * scale).toFixed(2));
}

/** คู่ทุน/Lot ที่ผู้ใช้ส่ง — ไม่ fallback equity ถ้ามี lot ชัดเจน */
function resolveRunCapitalAndLot({
  capitalManual = 0,
  manualLot = 0,
  syncField = 'capital',
  equityFallback = 0,
  lotMin = 0.01,
  lotMax = 0.05,
  currencyScale = CURRENCY_SCALE_USD
} = {}) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  let capital = num(capitalManual, 0);
  const lotIn = num(manualLot, 0);
  const sync = String(syncField || 'capital').toLowerCase() === 'lot' ? 'lot' : 'capital';

  if (capital <= 0 && lotIn > 0) {
    capital = capitalFromLot(clampLot(lotIn, lotMin, lotMax), scale);
  } else if (capital <= 0) {
    capital = num(equityFallback, 0);
  }

  if (capital > 0 && lotIn > 0) {
    const lotManual = clampLot(lotIn, lotMin, lotMax);
    const lotFromCap = clampLot(lotFromCapital(capital, scale), lotMin, lotMax);
    if (Math.abs(lotFromCap - lotManual) < 0.0005) {
      return { capital, manualLot: lotManual, syncField: sync };
    }
    if (sync === 'lot') {
      return { capital: capitalFromLot(lotManual, scale), manualLot: lotManual, syncField: 'lot' };
    }
  }

  return { capital, manualLot: lotIn > 0 ? lotIn : 0, syncField: sync };
}

function roundTrailLow(value) {
  const v = num(value, 0);
  const frac = v - Math.floor(v);
  return frac < 0.5 ? Math.floor(v) : Math.ceil(v);
}

function roundTrailMediumStop(value) {
  const v = num(value, 0);
  const frac = v - Math.floor(v);
  return frac > 0.5 ? Math.ceil(v) : Math.floor(v);
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

function akTrailing(lot, level, capital) {
  const l = num(lot, 0.01);
  const cap = num(capital, 0);
  const lv = normalizeTradeLevel(level);
  if (lv === 'high') {
    return {
      t_start: Number((l * 200).toFixed(2)),
      t_stop: Number((l * 100).toFixed(2))
    };
  }
  if (cap >= 300 && lv === 'low') {
    return {
      t_start: roundTrailLow(l * 170),
      t_stop: roundTrailLow(l * 70)
    };
  }
  if (cap >= 300 && lv === 'medium') {
    return {
      t_start: roundTrailLow(l * 170),
      t_stop: roundTrailMediumStop(l * 85)
    };
  }
  return {
    t_start: Number((l * 170).toFixed(2)),
    t_stop: Number((l * 85).toFixed(2))
  };
}

function queenLotFromCapital(capital, currencyScale = CURRENCY_SCALE_USD) {
  const cap = num(capital, 0);
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  // 100 USD or 10000 US Cent per 0.01 lot
  const threshold = 100 * scale;
  if (cap < threshold) return 0;
  return Number((Math.floor(cap / threshold) * 0.01).toFixed(2));
}

function applyPackageLotCap(capital, lot, lotMin, lotMax) {
  let lotOut = clampLot(lot, lotMin, lotMax);
  let capOut = num(capital, 0);
  let packageCapped = false;
  const idealLot = lotFromCapital(capOut);
  if (idealLot > lotMax + 0.0001) {
    packageCapped = true;
    lotOut = lotMax;
    capOut = capitalFromLot(lotOut);
  } else if (idealLot > 0) {
    lotOut = clampLot(idealLot, lotMin, lotMax);
    if (Math.abs(lotOut - idealLot) > 0.0001) {
      packageCapped = true;
      capOut = capitalFromLot(lotOut);
    }
  }
  return { lot: lotOut, capital: capOut, packageCapped };
}

function computeAkPreset(bot, capital, tradeLevel, manualLot, lotMin, lotMax, syncFieldIn = 'capital', currencyScale = CURRENCY_SCALE_USD) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const capIn = num(capital, 0);
  const manual = num(manualLot, 0);
  let cap = capIn;
  let lot;
  const syncField = String(syncFieldIn || 'capital').toLowerCase() === 'lot' ? 'lot' : 'capital';

  let packageCapped = false;
  if (manual > 0 && capIn > 0) {
    const lotManual = clampLot(manual, lotMin, lotMax);
    const lotFromCap = clampLot(lotFromCapital(capIn, scale), lotMin, lotMax);
    if (Math.abs(lotFromCap - lotManual) < 0.0005) {
      lot = lotManual;
      cap = capIn;
    } else if (syncField === 'lot') {
      lot = lotManual;
      cap = capitalFromLot(lot, scale);
    } else {
      const ideal = lotFromCapital(capIn, scale);
      if (ideal > lotMax + 0.0001) {
        packageCapped = true;
        lot = lotMax;
        cap = capIn;
      } else {
        lot = clampLot(ideal, lotMin, lotMax);
        cap = capIn;
      }
    }
  } else if (syncField === 'lot' && manual > 0) {
    lot = clampLot(manual, lotMin, lotMax);
    cap = capitalFromLot(lot, scale);
  } else {
    const ideal = lotFromCapital(capIn, scale);
    if (ideal > lotMax + 0.0001) {
      packageCapped = true;
      lot = lotMax;
      cap = capIn;
    } else {
      lot = clampLot(ideal, lotMin, lotMax);
    }
  }

  const trail = akTrailing(lot, tradeLevel, cap);
  const minCap = minCapitalForBotScaled('AK-SNIPER-VIP-VER4.0', scale);

  return {
    botKind: 'ak',
    capital: cap,
    capitalUsed: cap,
    lot,
    lotPlus: lot,
    lotReadonly: false,
    capitalReadonly: false,
    showTradeLevel: true,
    showRunTimeMode: true,
    showLotField: true,
    minCapital: minCap,
    packageCapped,
    currencyScale: scale,
    syncField,
    trade: {
      trade_level: normalizeTradeLevel(tradeLevel),
      t_start: trail.t_start,
      t_stop: trail.t_stop
    },
    pipStep: DEFAULT_PIP_STEP,
    takeProfitAverage: DEFAULT_TAKE_PROFIT_AVERAGE,
    lotOverride: manual > 0,
    presetMatchBy: 'formula',
    chartPeriod: BOT_CHART_PERIOD['AK-SNIPER-VIP-VER4.0']
  };
}

function computeQueenPreset(bot, capital, lotMin, lotMax, currencyScale = CURRENCY_SCALE_USD) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const cap = num(capital, 0);
  const minCap = minCapitalForBotScaled('QUEEN-SNIPER-AI-V1.0', scale);
  const lotRaw = queenLotFromCapital(cap, scale);
  const lot = lotRaw > 0 ? clampLot(lotRaw, lotMin, lotMax) : 0;

  return {
    botKind: 'queen',
    capital: cap,
    capitalUsed: cap,
    lot,
    lotPlus: lot,
    lotReadonly: true,
    capitalReadonly: false,
    showTradeLevel: false,
    showRunTimeMode: false,
    showLotField: true,
    minCapital: minCap,
    packageCapped: false,
    currencyScale: scale,
    syncField: 'capital',
    trade: { trade_level: 'medium', t_start: 0, t_stop: 0 },
    pipStep: DEFAULT_PIP_STEP,
    takeProfitAverage: DEFAULT_TAKE_PROFIT_AVERAGE,
    lotOverride: false,
    presetMatchBy: 'formula',
    chartPeriod: BOT_CHART_PERIOD['QUEEN-SNIPER-AI-V1.0']
  };
}

function computeSniperAiPreset(bot, capital, currencyScale = CURRENCY_SCALE_USD) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const cap = num(capital, 0);
  const minCap = minCapitalForBotScaled('SNIPER-AI-TRADING', scale);

  return {
    botKind: 'sniper_ai',
    capital: cap,
    capitalUsed: cap,
    lot: 0,
    lotPlus: 0,
    lotReadonly: true,
    capitalReadonly: false,
    showTradeLevel: false,
    showRunTimeMode: false,
    showLotField: false,
    minCapital: minCap,
    packageCapped: false,
    currencyScale: scale,
    syncField: 'capital',
    trade: { trade_level: 'medium', t_start: 0, t_stop: 0 },
    pipStep: DEFAULT_PIP_STEP,
    takeProfitAverage: DEFAULT_TAKE_PROFIT_AVERAGE,
    lotOverride: false,
    presetMatchBy: 'ea_auto',
    chartPeriod: BOT_CHART_PERIOD['SNIPER-AI-TRADING']
  };
}

function computeQuantumPreset(bot, capital, currencyScale = CURRENCY_SCALE_USD) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const cap = num(capital, 0);
  const minCap = minCapitalForBotScaled('QUANTUM-QUEEN-MT5-3.65', scale);

  return {
    botKind: 'quantum',
    capital: cap,
    capitalUsed: cap,
    lot: 0,
    lotPlus: 0,
    lotReadonly: true,
    capitalReadonly: false,
    showTradeLevel: false,
    showRunTimeMode: false,
    showLotField: false,
    minCapital: minCap,
    packageCapped: false,
    currencyScale: scale,
    syncField: 'capital',
    trade: { trade_level: 'medium', t_start: 0, t_stop: 0 },
    pipStep: DEFAULT_PIP_STEP,
    takeProfitAverage: DEFAULT_TAKE_PROFIT_AVERAGE,
    lotOverride: false,
    presetMatchBy: 'ea_auto',
    chartPeriod: BOT_CHART_PERIOD['QUANTUM-QUEEN-MT5-3.65']
  };
}

function computePresetForBot(
  bot,
  capital,
  tradeLevel,
  manualLot,
  lotMin,
  lotMax,
  packageDefaultLot,
  syncFieldIn = 'capital',
  currencyScale = CURRENCY_SCALE_USD
) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const kind = botKind(bot);
  if (kind === 'sniper_ai') {
    return computeSniperAiPreset(bot, capital, scale);
  }
  if (kind === 'queen') {
    return computeQueenPreset(bot, capital, lotMin, lotMax, scale);
  }
  if (kind === 'quantum') {
    return computeQuantumPreset(bot, capital, scale);
  }
  if (kind === 'ak') {
    return computeAkPreset(bot, capital, tradeLevel, manualLot, lotMin, lotMax, syncFieldIn, scale);
  }

  // legacy table fallback
  const slug = presetSlugForBot(bot);
  const rows = readPresetRows(slug).map(enrichPresetRow);
  const cap = num(capital, 0);
  const preset = nearestPresetRow(rows, cap) || rows[0] || null;
  const trade = settingFromPresetRow(preset, tradeLevel);
  const rowLot = preset ? num(preset.lot_size, packageDefaultLot) : num(packageDefaultLot, lotMax);
  const manual = num(manualLot, 0);
  let lot = manual > 0 ? clampLot(manual, lotMin, lotMax) : clampLot(rowLot, lotMin, lotMax);
  return {
    botKind: 'legacy',
    capital: cap,
    capitalUsed: cap,
    lot,
    lotPlus: clampLot(preset ? num(preset.lot_plus, lot) : lot, lotMin, lotMax),
    lotReadonly: false,
    capitalReadonly: false,
    showTradeLevel: true,
    showRunTimeMode: true,
    showLotField: true,
    minCapital: MIN_RUN_CAPITAL,
    packageCapped: false,
    preset,
    presetSlug: slug,
    trade,
    pipStep: preset ? num(preset.pip_step, DEFAULT_PIP_STEP) : DEFAULT_PIP_STEP,
    takeProfitAverage: preset
      ? num(preset.take_profit_average, DEFAULT_TAKE_PROFIT_AVERAGE)
      : DEFAULT_TAKE_PROFIT_AVERAGE,
    lotOverride: manual > 0,
    presetMatchBy: 'capital',
    chartPeriod: 'M15'
  };
}

function presetSlugForBot(bot) {
  const code = botCodeKey(bot);
  const map = {
    'AK-SNIPER-VIP-VER4.0': 'ak-sniper',
    'AK-SNIPER': 'ak-sniper'
  };
  return map[code] || '';
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

function enrichPresetRow(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    pip_step: num(row.pip_step, DEFAULT_PIP_STEP) || DEFAULT_PIP_STEP,
    take_profit_average: num(row.take_profit_average, DEFAULT_TAKE_PROFIT_AVERAGE) || DEFAULT_TAKE_PROFIT_AVERAGE
  };
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

function settingFromPresetRow(preset, level) {
  const l = normalizeTradeLevel(level);
  if (!preset) return { trade_level: l, t_start: 0, t_stop: 0 };
  if (l === 'high') {
    return { trade_level: 'high', t_start: num(preset.t_start), t_stop: num(preset.t_stop) };
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

function formatRunConfigLotText(summary) {
  if (!summary || summary.botKind === 'quantum' || summary.botKind === 'sniper_ai') return 'EA อัตโนมัติ';
  const lot = num(summary.lot, NaN);
  if (!Number.isFinite(lot)) return '-';
  const lotPlus = num(summary.lotPlus, lot);
  if (Math.abs(lotPlus - lot) > 0.0001) {
    return `${Number(lot.toFixed(2))} / ${Number(lotPlus.toFixed(2))}`;
  }
  return Number(lot.toFixed(2)).toFixed(2);
}

function presetSummary(calc, tradeLevel) {
  if (!calc) return null;
  const level = tradeLevelLabel(normalizeTradeLevel(tradeLevel || calc.trade?.trade_level));
  return {
    botKind: calc.botKind,
    capital: num(calc.capitalUsed ?? calc.capital, 0),
    lot: calc.lot,
    lotPlus: calc.lotPlus,
    lotOverride: !!calc.lotOverride,
    packageCapped: !!calc.packageCapped,
    presetMatchBy: calc.presetMatchBy || 'formula',
    tradeLevel: level,
    tStart: calc.trade?.t_start ?? null,
    tStop: calc.trade?.t_stop ?? null,
    pipStep: calc.pipStep,
    takeProfitAverage: calc.takeProfitAverage,
    chartPeriod: calc.chartPeriod || 'M15',
    minCapital: calc.minCapital,
    currencyScale: num(calc.currencyScale, CURRENCY_SCALE_USD) || CURRENCY_SCALE_USD
  };
}

/** ค่าที่แสดงใน "สรุปก่อน Run" — เก็บใน run_payload.runSummary */
function buildRunSummary(calc, tradeLevel, runTimeMode) {
  const base = presetSummary(calc, tradeLevel) || {};
  const mode = String(runTimeMode || 'auto').trim().toLowerCase();
  let timeLabel = mode === '24h' ? 'Open 24H.' : 'Auto trading';
  const chartPeriod = base.chartPeriod || 'M15';
  if (base.botKind === 'sniper_ai') {
    timeLabel = 'AI Scalping อัตโนมัติ (M5) — ไม่ต้องตั้งค่า';
  } else if (base.botKind === 'quantum') {
    timeLabel = 'Auto trading';
  } else if (base.botKind === 'queen') {
    const scale = num(calc?.currencyScale, CURRENCY_SCALE_USD) || CURRENCY_SCALE_USD;
    const unit = scale === CURRENCY_SCALE_USD ? 'USD' : 'US Cent';
    const perLot = 100 * scale;
    timeLabel = `บอทตั้ง Lot อัตโนมัติ (ทุน ${perLot.toLocaleString()} ${unit} / +0.01 Lot)`;
  }
  return {
    ...base,
    capital: num(calc?.capitalUsed ?? base.capital, 0),
    lot: (base.botKind === 'quantum' || base.botKind === 'sniper_ai') ? null : num(base.lot, 0),
    lotPlus: (base.botKind === 'quantum' || base.botKind === 'sniper_ai') ? null : num(base.lotPlus, 0),
    runTimeMode: mode === '24h' ? '24h' : 'auto',
    chartPeriod,
    timeLabel
  };
}

/** ค่าที่ผู้ใช้ยืนยันก่อน Run — ใช้แสดงในประวัติ (ไม่เปลี่ยนตาม lot_used ที่ปรับทีหลัง) */
function buildRunConfigSnapshot(calc, tradeLevel, runTimeMode) {
  const summary = buildRunSummary(calc, tradeLevel, runTimeMode);
  return {
    ...summary,
    capital: num(calc?.capitalUsed ?? summary.capital, 0),
    lot: summary.lot,
    lotPlus: summary.lotPlus,
    lotText: formatRunConfigLotText(summary),
    tradeLevel: summary.tradeLevel,
    savedAt: new Date().toISOString()
  };
}

function isProductionBot(bot) {
  return PRODUCTION_BOT_CODES.has(botCodeKey(bot));
}

function validateRunCapital(capital, bot, currencyScale = CURRENCY_SCALE_USD) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const cap = num(capital, 0);
  const code = botCodeKey(bot);
  const minCap = minCapitalForBotScaled(code, scale);
  const unit = scale === CURRENCY_SCALE_USD ? 'USD' : 'US Cent';
  if (cap < minCap) {
    const label = code.includes('QUANTUM')
      ? 'Quantum-Queen-MT5-3.65'
      : code.includes('QUEEN') ? 'QUEEN-SNIPER-AI-V1.0' : 'AK-SNIPER-VIP-VER4.0';
    return {
      ok: false,
      message: code.includes('QUANTUM')
        ? `เงินทุนไม่พอใช้บอท ${label} (ขั้นต่ำ ${minCap.toLocaleString()} ${unit})`
        : code.includes('QUEEN')
          ? `เงินทุนไม่พอใช้บอทตัวนี้ (ขั้นต่ำ ${minCap.toLocaleString()} ${unit})`
          : `เงินทุนต้องไม่ต่ำกว่า ${minCap} ${unit}`
    };
  }
  const calc = computePresetForBot(bot, cap, 'medium', 0, 0.01, 1, 0.05, 'capital', scale);
  if (calc.botKind === 'queen' && calc.lot <= 0) {
    return { ok: false, message: `เงินทุนไม่พอใช้บอทตัวนี้ (ขั้นต่ำ ${minCap.toLocaleString()} ${unit})` };
  }
  return { ok: true, capital: cap };
}

function defaultCapitalForBot(bot, equity = 0, currencyScale = CURRENCY_SCALE_USD) {
  const code = botCodeKey(bot);
  const kind = botKind(bot);
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const eq = num(equity, 0);
  if (kind === 'queen' || kind === 'quantum' || kind === 'sniper_ai') {
    return eq > 0 ? eq : 0;
  }
  if (eq > 0) return eq;
  return minCapitalForBotScaled(code, scale);
}

function capitalHintForBot(bot, currencyScale = CURRENCY_SCALE_USD) {
  const code = botCodeKey(bot);
  const kind = botKind(bot);
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const minCap = minCapitalForBotScaled(code, scale);
  const unit = scale === CURRENCY_SCALE_USD ? 'USD' : 'US Cent';
  const perLot = 100 * scale; // 100 USD or 10,000 US Cent per 0.01 lot
  if (kind === 'ak') {
    return `ขั้นต่ำ ${minCap.toLocaleString()} ${unit} · ${perLot.toLocaleString()} ${unit} ต่อ 0.01 Lot · แก้ทุนหรือ Lot ได้`;
  }
  if (kind === 'queen') {
    return `อิงจาก Equity · ขั้นต่ำ ${minCap.toLocaleString()} ${unit} · ทุน ${perLot.toLocaleString()} ${unit} ต่อ +0.01 Lot · M15`;
  }
  if (kind === 'sniper_ai') {
    return `อิงจาก Equity · ขั้นต่ำ ${minCap.toLocaleString()} ${unit} · AI คำนวณ Lot/SL/TP อัตโนมัติ (M5)`;
  }
  if (kind === 'quantum') {
    return `อิงจาก Equity · ขั้นต่ำ ${minCap.toLocaleString()} ${unit} · บอทคำนวณอัตโนมัติ (M15)`;
  }
  return `ขั้นต่ำ ${minCap.toLocaleString()} ${unit}`;
}

function akRiskLevelsVisible(capital, currencyScale = CURRENCY_SCALE_USD) {
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  return num(capital, 0) >= 300 * scale;
}

function botUiMeta(bot, currencyScale = CURRENCY_SCALE_USD) {
  const code = botCodeKey(bot);
  const kind = botKind(bot);
  const scale = num(currencyScale, CURRENCY_SCALE_USD) || 1;
  const minCap = minCapitalForBotScaled(code, scale);
  return {
    code,
    kind,
    minCapital: minCap,
    minCapitalUsd: BOT_MIN_CAPITAL_USD[code] || MIN_RUN_CAPITAL,
    currencyScale: scale,
    defaultCapital: defaultCapitalForBot(bot, 0, scale),
    equityBased: kind === 'queen' || kind === 'quantum' || kind === 'sniper_ai',
    capitalHint: capitalHintForBot(bot, scale),
    chartPeriod: BOT_CHART_PERIOD[code] || 'M15',
    showTradeLevel: kind === 'ak',
    showRunTimeMode: kind === 'ak',
    showLotField: kind !== 'quantum' && kind !== 'sniper_ai',
    lotReadonly: kind === 'queen' || kind === 'quantum' || kind === 'sniper_ai'
  };
}

module.exports = {
  MIN_RUN_CAPITAL,
  CAPITAL_PER_001_LOT,
  CURRENCY_SCALE_USD,
  CURRENCY_SCALE_CENT,
  DEFAULT_PIP_STEP,
  DEFAULT_TAKE_PROFIT_AVERAGE,
  PRODUCTION_BOT_CODE_LIST,
  PRODUCTION_BOT_CODES,
  BOT_MIN_CAPITAL,
  BOT_MIN_CAPITAL_USD,
  BOT_CHART_PERIOD,
  PACKAGE_LOT_POLICY,
  isUsdLogin,
  loginCurrencyScale,
  loginCurrencyLabel,
  minCapitalForBotScaled,
  packageGroupFromSummary,
  packageLotLimits,
  botCodeKey,
  botKind,
  botUiMeta,
  resolveRunCapitalAndLot,
  lotFromCapital,
  capitalFromLot,
  queenLotFromCapital,
  clampLot,
  normalizeTradeLevel,
  tradeLevelLabel,
  computePresetForBot,
  presetSummary,
  buildRunSummary,
  buildRunConfigSnapshot,
  formatRunConfigLotText,
  isProductionBot,
  validateRunCapital,
  defaultCapitalForBot,
  capitalHintForBot,
  akRiskLevelsVisible,
  presetSlugForBot,
  readPresetRows
};
