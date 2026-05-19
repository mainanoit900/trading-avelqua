'use strict';

const fs = require('fs');
const path = require('path');

const META_FILES = {
  'ak-sniper': 'ak-sniper-ea-meta.json',
  'pa-sniper': 'ak-sniper-ea-meta.json',
  '5pa-sniper': 'ak-sniper-ea-meta.json',
  'sniper-demo': 'sniper-demo-ea-meta.json'
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

/**
 * สร้างไฟล์ .set สำหรับ EA จาก BOT_MT5 (Ultima Grid)
 * ไม่แก้ source .mq5 — แค่ map ตาราง admin → input ของ EA
 */

/** ค่าเริ่มต้นเมื่อแถวตารางไม่ได้กรอก (อิง AK-SNIPER-VIP-VER4.0.mq5 defaults) */
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

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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

function eaSetFileName(botCode, tradeLevel, capital) {
  const code = String(botCode || 'BOT').replace(/[^\w.-]+/g, '_');
  const lvl = String(tradeLevel || 'safe').toLowerCase();
  const cap = Math.round(num(capital, 0));
  return `Avelqua_${code}_${lvl}_${cap || 0}.set`;
}

/**
 * สร้างเนื้อหา .set จาก payload / preset row
 */
function eaDefaultsForSlug(presetSlug) {
  const slug = String(presetSlug || 'ak-sniper').toLowerCase();
  const fromMeta = readEaMetaDefaults(slug);
  return { ...(EA_DEFAULTS_BY_SLUG[slug] || EA_DEFAULTS_BY_SLUG['ak-sniper']), ...fromMeta };
}

function buildEaSetContent({
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
  const tStartVal = num(tStart, 2);
  const tStopVal = num(tStop, 1);
  const pipVal = num(pipStep, defs.pip_step);
  const tpVal = num(takeProfitAverage, defs.take_profit_average);
  const magicVal = num(magicNumber, defs.magic_number);

  const lines = [
    '; Avelqua — auto-generated EA preset (do not edit header)',
    `; bot=${botCode || ''} level=${tradeLevel || 'safe'} capital=${capital || 0}`,
    `; preset_slug=${presetSlug || ''}`,
    `; generated=${new Date().toISOString()}`,
    '',
    setLine('InpSoftClose', softClose ? 1 : 0, { default: defs.soft_close, min: 0, max: 1, step: 1 }),
    setLine('InpLotSize', lotVal, { default: 0.02, min: 0.01, max: 100, step: 0.01 }),
    setLine('InpLotPlus', lotPlusVal, { default: 0.02, min: 0.01, max: 100, step: 0.01 }),
    setLine('InpPipStep', pipVal, { default: defs.pip_step, min: 10, max: 2000, step: 1 }),
    setLine('InpTakeProfitAverage', tpVal, { default: defs.take_profit_average, min: 10, max: 5000, step: 1 }),
    setLine('InpTrailingStartMoney', tStartVal, { default: 8, min: 0, max: 500, step: 0.1 }),
    setLine('InpTrailingStopMoney', tStopVal, { default: 5, min: 0, max: 500, step: 0.1 }),
    setLine('InpCutLossPct', defs.cut_loss_pct, { default: 100, min: 1, max: 100, step: 1 }),
    setLine('InpMagicNumber', magicVal, { default: defs.magic_number, min: 1, max: 999999999, step: 1 }),
    ''
  ];
  return lines.join('\r\n');
}

/**
 * ฟิลด์ที่แนบใน run_bot payload ให้ Agent เขียน .set
 */
function buildEaSetPayloadFields({ bot, lot, capital, trade, preset, presetSlug }) {
  const botCode = String(bot?.bot_code || bot?.code || '').trim();
  const tradeLevel = trade?.trade_level || 'safe';
  const slug = String(presetSlug || preset?.preset_slug || 'ak-sniper').toLowerCase();
  const defs = eaDefaultsForSlug(slug);
  const lotPlus = num(preset?.lot_plus, num(lot, 0.01));
  const tStart = num(trade?.t_start, num(preset?.t_start, 2));
  const tStop = num(trade?.t_stop, num(preset?.t_stop, 1));
  const pipStep = num(preset?.pip_step, defs.pip_step);
  const takeProfitAverage = num(preset?.take_profit_average, defs.take_profit_average);
  const magicNumber = num(preset?.magic_number, defs.magic_number);

  const setFileName = eaSetFileName(botCode, tradeLevel, capital);
  const eaSetContent = buildEaSetContent({
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
    presetSlug: slug
  });

  return {
    lotPlus,
    pipStep,
    takeProfitAverage,
    magicNumber,
    presetSlug: slug,
    eaSetFileName: setFileName,
    eaSetContent,
    eaSetPaths: [
      `MQL5\\Presets\\${setFileName}`,
      `MQL5\\Presets\\Experts\\${setFileName}`,
      `MQL5\\Experts\\Trading Bot\\${setFileName}`
    ],
    eaAttachHint: `แนบ EA ${botCode === 'sniper-demo' || botCode === 'SNIPER-DEMO' ? 'sniper-demo' : botCode} บนกราฟ XAUUSD → Inputs → Load → ${setFileName}`
  };
}

module.exports = {
  EA_DEFAULTS_BY_SLUG,
  setLine,
  eaSetFileName,
  eaDefaultsForSlug,
  buildEaSetContent,
  buildEaSetPayloadFields
};
