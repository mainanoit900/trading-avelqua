'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data', 'mt5-presets');
const MIN_RUN_CAPITAL = 100;
const DEFAULT_PIP_STEP = 345;
const DEFAULT_TAKE_PROFIT_AVERAGE = 100;
const CAPITAL_PER_001_LOT = 10000; // $100 → 0.01 lot

const PRODUCTION_BOT_CODE_LIST = [
  'AK-SNIPER-VIP-VER4.0',
  'QUEEN-SNIPER-AI-V1.0',
  'Quantum-Queen-MT5-3.65'
];

const PRODUCTION_BOT_CODES = new Set(
  PRODUCTION_BOT_CODE_LIST.map((code) => String(code || '').trim().toUpperCase())
);

const BOT_MIN_CAPITAL = {
  'AK-SNIPER-VIP-VER4.0': 100,
  'QUEEN-SNIPER-AI-V1.0': 10000,
  'QUANTUM-QUEEN-MT5-3.65': 50000
};

const BOT_CHART_PERIOD = {
  'AK-SNIPER-VIP-VER4.0': 'M15',
  'QUEEN-SNIPER-AI-V1.0': 'H1',
  'QUANTUM-QUEEN-MT5-3.65': 'M15'
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

function lotFromCapital(capital) {
  const cap = num(capital, 0);
  if (cap <= 0) return 0;
  return Number(((cap / 100) * 0.01).toFixed(4));
}

function capitalFromLot(lot) {
  const l = num(lot, 0);
  if (l <= 0) return 0;
  return Number((l * CAPITAL_PER_001_LOT).toFixed(2));
}

/** คู่ทุน/Lot ที่ผู้ใช้ส่ง — ไม่ fallback equity ถ้ามี lot ชัดเจน */
function resolveRunCapitalAndLot({
  capitalManual = 0,
  manualLot = 0,
  syncField = 'capital',
  equityFallback = 0,
  lotMin = 0.01,
  lotMax = 0.05
} = {}) {
  let capital = num(capitalManual, 0);
  const lotIn = num(manualLot, 0);
  const sync = String(syncField || 'capital').toLowerCase() === 'lot' ? 'lot' : 'capital';

  if (capital <= 0 && lotIn > 0) {
    capital = capitalFromLot(clampLot(lotIn, lotMin, lotMax));
  } else if (capital <= 0) {
    capital = num(equityFallback, 0);
  }

  if (capital > 0 && lotIn > 0) {
    const lotManual = clampLot(lotIn, lotMin, lotMax);
    const lotFromCap = clampLot(lotFromCapital(capital), lotMin, lotMax);
    if (Math.abs(lotFromCap - lotManual) < 0.0005) {
      return { capital, manualLot: lotManual, syncField: sync };
    }
    if (sync === 'lot') {
      return { capital: capitalFromLot(lotManual), manualLot: lotManual, syncField: 'lot' };
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

function queenLotFromCapital(capital) {
  const cap = num(capital, 0);
  if (cap < BOT_MIN_CAPITAL['QUEEN-SNIPER-AI-V1.0']) return 0;
  return Number((Math.floor(cap / 10000) * 0.01).toFixed(2));
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

function computeAkPreset(bot, capital, tradeLevel, manualLot, lotMin, lotMax, syncFieldIn = 'capital') {
  const capIn = num(capital, 0);
  const manual = num(manualLot, 0);
  let cap = capIn;
  let lot;
  const syncField = String(syncFieldIn || 'capital').toLowerCase() === 'lot' ? 'lot' : 'capital';

  let packageCapped = false;
  if (manual > 0 && capIn > 0) {
    const lotManual = clampLot(manual, lotMin, lotMax);
    const lotFromCap = clampLot(lotFromCapital(capIn), lotMin, lotMax);
    if (Math.abs(lotFromCap - lotManual) < 0.0005) {
      lot = lotManual;
      cap = capIn;
    } else if (syncField === 'lot') {
      lot = lotManual;
      cap = capitalFromLot(lot);
    } else {
      const ideal = lotFromCap;
      if (ideal > lotMax + 0.0001) {
        packageCapped = true;
        lot = lotMax;
        cap = capitalFromLot(lot);
      } else {
        lot = ideal;
        cap = capIn;
      }
    }
  } else if (syncField === 'lot' && manual > 0) {
    lot = clampLot(manual, lotMin, lotMax);
    cap = capitalFromLot(lot);
  } else {
    const ideal = lotFromCapital(capIn);
    if (ideal > lotMax + 0.0001) {
      packageCapped = true;
      lot = lotMax;
      cap = capitalFromLot(lot);
    } else {
      lot = clampLot(ideal, lotMin, lotMax);
    }
  }

  const trail = akTrailing(lot, tradeLevel, cap);

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
    minCapital: BOT_MIN_CAPITAL['AK-SNIPER-VIP-VER4.0'],
    packageCapped,
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

function computeQueenPreset(bot, capital, lotMin, lotMax) {
  const cap = num(capital, 0);
  const minCap = BOT_MIN_CAPITAL['QUEEN-SNIPER-AI-V1.0'];
  const lotRaw = queenLotFromCapital(cap);
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
    syncField: 'capital',
    trade: { trade_level: 'medium', t_start: 0, t_stop: 0 },
    pipStep: DEFAULT_PIP_STEP,
    takeProfitAverage: DEFAULT_TAKE_PROFIT_AVERAGE,
    lotOverride: false,
    presetMatchBy: 'formula',
    chartPeriod: BOT_CHART_PERIOD['QUEEN-SNIPER-AI-V1.0']
  };
}

function computeQuantumPreset(bot, capital) {
  const cap = num(capital, 0);
  const minCap = BOT_MIN_CAPITAL['QUANTUM-QUEEN-MT5-3.65'];

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
  syncFieldIn = 'capital'
) {
  const kind = botKind(bot);
  if (kind === 'queen') {
    return computeQueenPreset(bot, capital, lotMin, lotMax);
  }
  if (kind === 'quantum') {
    return computeQuantumPreset(bot, capital);
  }
  if (kind === 'ak') {
    return computeAkPreset(bot, capital, tradeLevel, manualLot, lotMin, lotMax, syncFieldIn);
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
    chartPeriod: 'H1'
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
  if (!summary || summary.botKind === 'quantum') return 'EA อัตโนมัติ';
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
    chartPeriod: calc.chartPeriod || 'H1',
    minCapital: calc.minCapital
  };
}

/** ค่าที่แสดงใน "สรุปก่อน Run" — เก็บใน run_payload.runSummary */
function buildRunSummary(calc, tradeLevel, runTimeMode) {
  const base = presetSummary(calc, tradeLevel) || {};
  const mode = String(runTimeMode || 'auto').trim().toLowerCase();
  let timeLabel = mode === '24h' ? 'Open 24H.' : 'Auto trading';
  if (base.botKind === 'quantum') {
    timeLabel += ' · TF M15';
  } else if (base.botKind === 'queen') {
    timeLabel = 'บอทตั้ง Lot อัตโนมัติ (ทุน 10,000 USD / +0.01 Lot)';
  }
  return {
    ...base,
    capital: num(calc?.capitalUsed ?? base.capital, 0),
    lot: base.botKind === 'quantum' ? null : num(base.lot, 0),
    lotPlus: base.botKind === 'quantum' ? null : num(base.lotPlus, 0),
    runTimeMode: mode === '24h' ? '24h' : 'auto',
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

function validateRunCapital(capital, bot) {
  const cap = num(capital, 0);
  const code = botCodeKey(bot);
  const minCap = BOT_MIN_CAPITAL[code] || MIN_RUN_CAPITAL;
  if (cap < minCap) {
    const label = code.includes('QUEEN') && !code.includes('QUANTUM')
      ? 'QUEEN-SNIPER-AI-V1.0'
      : code.includes('QUANTUM')
        ? 'Quantum-Queen-MT5-3.65'
        : 'AK-SNIPER-VIP-VER4.0';
    return {
      ok: false,
      message:
        code.includes('QUANTUM')
          ? `เงินทุนไม่พอใช้บอท ${label} (ขั้นต่ำ ${minCap.toLocaleString()} USD)`
          : code.includes('QUEEN') && !code.includes('QUANTUM')
            ? `เงินทุนไม่พอใช้บอทตัวนี้ (ขั้นต่ำ ${minCap.toLocaleString()} USD)`
            : `เงินทุนต้องไม่ต่ำกว่า ${minCap}`
    };
  }
  const calc = computePresetForBot(bot, cap, 'medium', 0, 0.01, 1, 0.05);
  if (calc.botKind === 'queen' && calc.lot <= 0) {
    return { ok: false, message: 'เงินทุนไม่พอใช้บอทตัวนี้ (ขั้นต่ำ 10,000 USD)' };
  }
  return { ok: true, capital: cap };
}

function defaultCapitalForBot(bot, equity = 0) {
  const code = botCodeKey(bot);
  const kind = botKind(bot);
  const eq = num(equity, 0);
  if (kind === 'queen' || kind === 'quantum') {
    return eq > 0 ? eq : 0;
  }
  if (eq > 0) return eq;
  return BOT_MIN_CAPITAL[code] || MIN_RUN_CAPITAL;
}

function capitalHintForBot(bot) {
  const code = botCodeKey(bot);
  const kind = botKind(bot);
  const minCap = BOT_MIN_CAPITAL[code] || MIN_RUN_CAPITAL;
  if (kind === 'ak') {
    return `ขั้นต่ำ ${minCap} USD · 100 USD ต่อ 0.01 Lot · แก้ทุนหรือ Lot ได้`;
  }
  if (kind === 'queen') {
    return `อิงจาก Equity · ขั้นต่ำ ${minCap.toLocaleString()} USD · ทุน 10,000 ต่อ +0.01 Lot`;
  }
  if (kind === 'quantum') {
    return `อิงจาก Equity · ขั้นต่ำ ${minCap.toLocaleString()} USD · บอทคำนวณอัตโนมัติ (M15)`;
  }
  return `ขั้นต่ำ ${minCap} USD`;
}

function akRiskLevelsVisible(capital) {
  return num(capital, 0) >= 300;
}

function botUiMeta(bot) {
  const code = botCodeKey(bot);
  const kind = botKind(bot);
  const minCap = BOT_MIN_CAPITAL[code] || MIN_RUN_CAPITAL;
  return {
    code,
    kind,
    minCapital: minCap,
    defaultCapital: defaultCapitalForBot(bot, 0),
    equityBased: kind === 'queen' || kind === 'quantum',
    capitalHint: capitalHintForBot(bot),
    chartPeriod: BOT_CHART_PERIOD[code] || 'H1',
    showTradeLevel: kind === 'ak',
    showRunTimeMode: kind === 'ak',
    showLotField: kind !== 'quantum',
    lotReadonly: kind === 'queen' || kind === 'quantum'
  };
}

module.exports = {
  MIN_RUN_CAPITAL,
  CAPITAL_PER_001_LOT,
  DEFAULT_PIP_STEP,
  DEFAULT_TAKE_PROFIT_AVERAGE,
  PRODUCTION_BOT_CODE_LIST,
  PRODUCTION_BOT_CODES,
  BOT_MIN_CAPITAL,
  BOT_CHART_PERIOD,
  PACKAGE_LOT_POLICY,
  packageGroupFromSummary,
  packageLotLimits,
  botCodeKey,
  botKind,
  botUiMeta,
  resolveRunCapitalAndLot,
  lotFromCapital,
  capitalFromLot,
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
