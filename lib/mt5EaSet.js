'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_EA_SESSIONS } = require('./mt5EaTimeProfile');

const META_FILES = {
  'ak-sniper': 'ak-sniper-ea-meta.json',
  'pa-sniper': 'ak-sniper-ea-meta.json',
  '5pa-sniper': 'ak-sniper-ea-meta.json',
  'sniper-demo': 'sniper-demo-ea-meta.json'
};

/** ค่าเริ่มต้นเมื่อแถวตาราง legacy ไม่ได้กรอก */
const EA_DEFAULTS_BY_SLUG = {
  'ak-sniper': {
    pip_step: 345,
    take_profit_average: 100,
    cut_loss_pct: 100,
    magic_number: 2122025,
    soft_close: 0
  },
  'pa-sniper': { pip_step: 345, take_profit_average: 100, cut_loss_pct: 100, magic_number: 2122025, soft_close: 0 },
  '5pa-sniper': { pip_step: 345, take_profit_average: 100, cut_loss_pct: 100, magic_number: 2122025, soft_close: 0 },
  'sniper-demo': { pip_step: 345, take_profit_average: 100, cut_loss_pct: 100, magic_number: 2122099, soft_close: 0 }
};

function readEaMetaDefaults(slug) {
  const file = META_FILES[String(slug || '').toLowerCase()];
  if (!file) return {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data', 'mt5-presets', file), 'utf8')
    );
    return raw.set_only_defaults || {};
  } catch {
    return {};
  }
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function botKindFromCode(botCode) {
  const code = String(botCode || '').trim().toUpperCase();
  if (code.includes('QUANTUM-QUEEN')) return 'quantum';
  if (code.includes('QUEEN-SNIPER')) return 'queen';
  if (code.includes('AK-SNIPER')) return 'ak';
  return 'legacy';
}

/** บรรทัดพารามิเตอร์แบบ MT5: name=val||default||min||max||step||N */
function setLine(name, value, opts = {}) {
  const v = num(value, opts.default ?? 0);
  const def = num(opts.default ?? v, v);
  const min = num(opts.min ?? v, v);
  const max = num(opts.max ?? v, v);
  const step = opts.step != null ? num(opts.step, 0.01) : Number.isInteger(v) ? 1 : 0.01;
  const s = Number.isInteger(v) && step >= 1 ? String(Math.trunc(v)) : String(v);
  const sd = Number.isInteger(def) && step >= 1 ? String(Math.trunc(def)) : String(def);
  return `${name}=${s}||${sd}||${min}||${max}||${step}||N`;
}

function setBoolLine(name, value) {
  const flag = value ? '1' : '0';
  return `${name}=${flag}||${flag}||0||1||1||N`;
}

function setStrLine(name, value) {
  const safe = String(value || '').trim() || '00:00';
  return `${name}=${safe}||${safe}||0||235959||1||N`;
}

function eaSetFileName(botCode, tradeLevel, capital, runTimeMode) {
  const code = String(botCode || 'BOT').replace(/[^\w.-]+/g, '_');
  const lvl = String(tradeLevel || 'safe').toLowerCase();
  const cap = Math.round(num(capital, 0));
  const mode = String(runTimeMode || 'auto').trim().toLowerCase() === '24h' ? '24h' : 'auto';
  return `Avelqua_${code}_${lvl}_${cap || 0}_${mode}.set`;
}

function eaDefaultsForSlug(presetSlug) {
  const slug = String(presetSlug || 'ak-sniper').toLowerCase();
  const fromMeta = readEaMetaDefaults(slug);
  return { ...(EA_DEFAULTS_BY_SLUG[slug] || EA_DEFAULTS_BY_SLUG['ak-sniper']), ...fromMeta };
}

function normalizeSessions(eaTimeProfile, runTimeMode) {
  const prof = eaTimeProfile && typeof eaTimeProfile === 'object' ? eaTimeProfile : {};
  const mode = String(runTimeMode || prof.runTimeMode || 'auto').trim().toLowerCase();
  const useTimeFilter = prof.useTimeFilter === true || (prof.useTimeFilter == null && mode !== '24h');
  const incoming = Array.isArray(prof.sessions) ? prof.sessions : [];
  const out = [];
  for (let i = 0; i < 3; i += 1) {
    const row = incoming[i];
    const def = DEFAULT_EA_SESSIONS[i] || DEFAULT_EA_SESSIONS[0];
    out.push({
      use: useTimeFilter && (row?.use != null ? !!row.use : !!def.use),
      start: String(row?.start || def.start || '03:00'),
      stop: String(row?.stop || def.stop || '06:00')
    });
  }
  return out;
}

/** AK-SNIPER: เฉพาะค่าที่หน้าเว็บกำหนด — ที่เหลือใช้ default ใน .mq5 */
function buildAkEaSetContent({
  botCode,
  lot,
  lotPlus,
  tStart,
  tStop,
  tradeLevel,
  capital,
  eaTimeProfile,
  runTimeMode
}) {
  const lotVal = num(lot, 0.01);
  const lotPlusVal = num(lotPlus, lotVal);
  const mode = String(runTimeMode || eaTimeProfile?.runTimeMode || 'auto').trim().toLowerCase();
  const useTimeFilter = eaTimeProfile?.useTimeFilter === true
    || (eaTimeProfile?.useTimeFilter == null && mode !== '24h');
  const sessions = normalizeSessions(eaTimeProfile, mode);

  const lines = [
    '; Avelqua — AK-SNIPER (web overrides only)',
    `; bot=${botCode || ''} level=${tradeLevel || ''} capital=${capital || 0} time=${mode}`,
    `; generated=${new Date().toISOString()}`,
    '',
    setLine('InpLotSize', lotVal, { default: 0.02, min: 0.01, max: 100, step: 0.01 }),
    setLine('InpLotPlus', lotPlusVal, { default: 0.02, min: 0.01, max: 100, step: 0.01 }),
    setLine('InpTrailingStartMoney', num(tStart, 0), { default: 8, min: 0, max: 500, step: 0.1 }),
    setLine('InpTrailingStopMoney', num(tStop, 0), { default: 5, min: 0, max: 500, step: 0.1 }),
    setBoolLine('InpUseTimeFilter', useTimeFilter)
  ];

  for (let i = 0; i < 3; i += 1) {
    const sess = sessions[i];
    const n = i + 1;
    const sessOn = useTimeFilter && !!sess.use;
    lines.push(setBoolLine(`InpUseSession${n}`, sessOn));
    lines.push(setStrLine(`InpStartTime${n}`, sess.start));
    lines.push(setStrLine(`InpStopTime${n}`, sess.stop));
  }

  lines.push('');
  return lines.join('\r\n');
}

/** QUEEN-SNIPER: เฉพาะ Start Lot จากทุน */
function buildQueenEaSetContent({ botCode, lot, capital }) {
  const lotVal = num(lot, 0.01);
  const lines = [
    '; Avelqua — QUEEN-SNIPER (web: start lot only)',
    `; bot=${botCode || ''} capital=${capital || 0}`,
    `; generated=${new Date().toISOString()}`,
    '',
    setLine('InpLotStart', lotVal, { default: 0.05, min: 0.01, max: 100, step: 0.01 }),
    ''
  ];
  return lines.join('\r\n');
}

/** legacy / ตาราง admin — คงพฤติกรรมเดิม */
function buildLegacyEaSetContent({
  botCode,
  lot,
  lotPlus,
  tradeLevel,
  tStart,
  tStop,
  capital,
  pipStep,
  takeProfitAverage,
  magicNumber,
  softClose = false,
  presetSlug = 'ak-sniper'
}) {
  const defs = eaDefaultsForSlug(presetSlug);
  const lotVal = num(lot, 0.01);
  const lotPlusVal = num(lotPlus, lotVal);
  const pipVal = num(pipStep, defs.pip_step);
  const tpVal = num(takeProfitAverage, defs.take_profit_average);
  const magicVal = num(magicNumber, defs.magic_number);

  const lines = [
    '; Avelqua — auto-generated EA preset (legacy)',
    `; bot=${botCode || ''} level=${tradeLevel || 'safe'} capital=${capital || 0}`,
    `; preset_slug=${presetSlug || ''}`,
    `; generated=${new Date().toISOString()}`,
    '',
    setLine('InpSoftClose', softClose ? 1 : 0, { default: defs.soft_close, min: 0, max: 1, step: 1 }),
    setLine('InpLotSize', lotVal, { default: 0.02, min: 0.01, max: 100, step: 0.01 }),
    setLine('InpLotPlus', lotPlusVal, { default: 0.02, min: 0.01, max: 100, step: 0.01 }),
    setLine('InpPipStep', pipVal, { default: defs.pip_step, min: 10, max: 2000, step: 1 }),
    setLine('InpTakeProfitAverage', tpVal, { default: defs.take_profit_average, min: 10, max: 5000, step: 1 }),
    setLine('InpTrailingStartMoney', num(tStart, 0), { default: 8, min: 0, max: 500, step: 0.1 }),
    setLine('InpTrailingStopMoney', num(tStop, 0), { default: 5, min: 0, max: 500, step: 0.1 }),
    setLine('InpCutLossPct', defs.cut_loss_pct, { default: 100, min: 1, max: 100, step: 1 }),
    setLine('InpMagicNumber', magicVal, { default: defs.magic_number, min: 1, max: 999999999, step: 1 }),
    ''
  ];
  return lines.join('\r\n');
}

function buildEaSetContent(opts = {}) {
  const kind = String(opts.botKind || botKindFromCode(opts.botCode)).toLowerCase();
  if (kind === 'ak') return buildAkEaSetContent(opts);
  if (kind === 'queen') return buildQueenEaSetContent(opts);
  if (kind === 'quantum') return '';
  return buildLegacyEaSetContent(opts);
}

/**
 * ฟิลด์ .set สำหรับ run_mt5_bot — Agent แนบ EA + โหลด preset ทันที
 */
function buildEaSetPayloadFields({
  bot,
  botKind,
  lot,
  lotPlus,
  capital,
  trade,
  preset,
  presetSlug,
  eaTimeProfile,
  runTimeMode
}) {
  const botCode = String(bot?.bot_code || bot?.code || '').trim();
  const tradeLevel = trade?.trade_level || 'medium';
  const kind = String(botKind || botKindFromCode(botCode)).toLowerCase();
  const capitalUsed = num(capital, 0);
  const lotVal = num(lot, 0.01);
  const lotPlusVal = num(lotPlus, lotVal);
  const tStart = num(trade?.t_start, 0);
  const tStop = num(trade?.t_stop, 0);

  if (kind === 'quantum') {
    return {
      botKind: kind,
      eaSetSkip: true,
      eaSetFileName: '',
      eaSetContent: '',
      eaSetPaths: [],
      eaAttachHint: `แนบ EA ${botCode} บน XAUUSD M15 — ใช้ค่า default ใน EA (ทุน ${capitalUsed})`
    };
  }

  const setFileName = eaSetFileName(botCode, tradeLevel, capitalUsed, runTimeMode);
  const eaSetContent = buildEaSetContent({
    botCode,
    botKind: kind,
    lot: lotVal,
    lotPlus: lotPlusVal,
    tradeLevel,
    tStart,
    tStop,
    capital: capitalUsed,
    eaTimeProfile,
    runTimeMode,
    pipStep: num(preset?.pip_step, 345),
    takeProfitAverage: num(preset?.take_profit_average, 100),
    magicNumber: num(preset?.magic_number, 2122025),
    presetSlug: String(presetSlug || preset?.preset_slug || 'ak-sniper').toLowerCase()
  });

  const attachName = kind === 'queen' ? 'QUEEN-SNIPER-AI-V1.0' : botCode;
  const periodHint = kind === 'queen' ? 'H1' : 'H1';

  return {
    botKind: kind,
    eaSetSkip: false,
    lotPlus: lotPlusVal,
    presetSlug: String(presetSlug || preset?.preset_slug || '').toLowerCase() || null,
    eaSetFileName: setFileName,
    eaSetContent,
    eaSetPaths: [
      `MQL5\\Presets\\${setFileName}`,
      `MQL5\\Presets\\Experts\\${setFileName}`,
      `MQL5\\Experts\\Trading Bot\\${setFileName}`
    ],
    eaAttachHint: `แนบ EA ${attachName} บนกราฟ XAUUSD ${periodHint} → Inputs → Load → ${setFileName}`
  };
}

module.exports = {
  EA_DEFAULTS_BY_SLUG,
  botKindFromCode,
  setLine,
  setBoolLine,
  setStrLine,
  eaSetFileName,
  eaDefaultsForSlug,
  buildAkEaSetContent,
  buildQueenEaSetContent,
  buildEaSetContent,
  buildEaSetPayloadFields
};
