'use strict';

const { query } = require('../config/database');
const { computePresetForBot, presetSlugForBot, tradeLevelLabel } = require('./mt5BotPresets');

const DEMO_BOT_CODES = new Set(['SNIPER-DEMO', 'SNIPER_DEMO', 'SNIPER-DEMO', 'BOT_TEST', 'SNIPER-DEMO']);

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isDemoBotCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return (
    DEMO_BOT_CODES.has(c) ||
    c === 'SNIPER-DEMO' ||
    c === 'SNIPER_DEMO' ||
    c === 'BOT_TEST'
  );
}

/** คะแนน PORT สำหรับ Login (สูง = ดี) — ไม่ต้องรอ AI */
function heuristicPortScore(row) {
  const cpu = num(row.cpu_percent);
  const ram = num(row.ram_percent);
  const ping = num(row.ping_ms);
  const maxCpu = Math.max(50, num(row.max_cpu_percent, num(row.cpu_alarm, 80)));
  const maxRam = Math.max(50, num(row.max_ram_percent, num(row.ram_alarm, 85)));
  const maxPing = Math.max(80, num(row.max_ping_ms, num(row.ping_alarm, 150)));
  let score = 100;
  score -= Math.min(35, (cpu / maxCpu) * 35);
  score -= Math.min(30, (ram / maxRam) * 30);
  score -= Math.min(40, (ping / maxPing) * 40);
  score -= num(row.used_ports) * 1.5;
  return Math.round(score * 10) / 10;
}

function pickBestPortRowHeuristic(rows) {
  const list = (rows || []).slice();
  if (!list.length) return null;
  list.sort(
    (a, b) =>
      heuristicPortScore(b) - heuristicPortScore(a) ||
      num(a.port_number) - num(b.port_number) ||
      num(a.cpu_percent) - num(b.cpu_percent)
  );
  return list[0];
}

async function aiRankPorts(candidates) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey || !candidates?.length || candidates.length < 2) return null;

  const compact = candidates.slice(0, 6).map((r, i) => ({
    i,
    vps: r.node_name || r.admin_node_id,
    port: r.port_number,
    cpu: num(r.cpu_percent),
    ram: num(r.ram_percent),
    ping: num(r.ping_ms),
    score: heuristicPortScore(r)
  }));

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CONNECT_MODEL || process.env.OPENAI_INTEL_MODEL || 'gpt-4.1-mini',
        input:
          'เลือก index ของ VPS/PORT ที่เหมาะเปิด MT5 เร็วและเสถียรที่สุด (ตอบเลข index เดียว JSON {"index":0}). ' +
          'พิจารณา ping ต่ำ cpu/ram ต่ำ score สูง: ' +
          JSON.stringify(compact)
      })
    });
    const data = await response.json();
    const text = data.output_text || data.output?.[0]?.content?.[0]?.text || '';
    const parsed = JSON.parse(text);
    const idx = Number(parsed.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
      return candidates[idx];
    }
  } catch (_) {
    /* fallback heuristic */
  }
  return null;
}

/** เลือก PORT ว่าง — heuristic + AI (ถ้ามี key) */
async function pickBestPortForLogin(rows) {
  const list = rows || [];
  if (!list.length) return null;
  const heuristic = pickBestPortRowHeuristic(list);
  if (list.length < 2) return heuristic;

  const topN = pickBestPortRowHeuristic(list)
    ? [...list]
        .map((r) => ({ r, s: heuristicPortScore(r) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 6)
        .map((x) => x.r)
    : list.slice(0, 6);

  const aiPick = await aiRankPorts(topN).catch(() => null);
  return aiPick || heuristic;
}

async function loadDemoBot() {
  const r = await query(
    `
    SELECT *
    FROM vps_system.bot_catalog
    WHERE is_active = TRUE
      AND (is_demo = TRUE OR UPPER(bot_code) IN ('SNIPER-DEMO','SNIPER_DEMO','SNIPER-DEMO','BOT_TEST'))
    ORDER BY sort_order DESC, id DESC
    LIMIT 1
  `
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

function buildDemoTradingPlan({ capital = 0, tradeLevel = 'medium', manualLot = 0 } = {}) {
  const bot = {
    bot_code: 'SNIPER-DEMO',
    display_name: 'SNIPER-DEMO ทดสอบ',
    preset_json: JSON.stringify({ preset_slug: 'sniper-demo' }),
    default_lot: 0.01,
    max_lot: 50
  };
  const calc = computePresetForBot(bot, num(capital, 1000), tradeLevel, manualLot, 0.01, 50, 0.05);
  return {
    botCode: bot.bot_code,
    presetSlug: calc.presetSlug || 'sniper-demo',
    lot: calc.lot,
    lotPlus: calc.lotPlus,
    tradeLevel: calc.trade.trade_level,
    riskLabel: tradeLevelLabel(calc.trade.trade_level),
    tStart: calc.trade.t_start,
    tStop: calc.trade.t_stop,
    eaFile: 'sniper-demo.ex5',
    attachSteps: [
      'เปิดกราฟ XAUUSD',
      'แนบ sniper-demo (หรือ SNIPER-DEMO) จากโฟลเดอร์ Trading Bot',
      'Inputs → Load ไฟล์ .set ที่ระบบสร้าง',
      'เปิด Algo Trading สีเขียว',
      'กด Run BOT บนเว็บ'
    ]
  };
}

async function buildConnectAdvice({ reservedPort, capital, tradeLevel }) {
  const score = reservedPort ? heuristicPortScore(reservedPort) : 0;
  const demo = buildDemoTradingPlan({ capital, tradeLevel });
  const aiUsed = !!(process.env.OPENAI_API_KEY && reservedPort);

  let summary =
    `เลือก ${reservedPort?.node_name || 'VPS'} PORT ${reservedPort?.port_number || '-'} ` +
    `(คะแนน ${score}/100) — เหมาะเปิด MT5`;

  if (aiUsed) {
    summary += ' · AI ช่วยจัดอันดับ';
  }

  return {
    portScore: score,
    aiAssisted: aiUsed,
    summary,
    recommendedBot: demo,
    testingHint:
      'แนะนำใช้ SNIPER-DEMO ทดสอบกับตาราง /admin/mt5-presets/sniper-demo (รองรับทุกเลขบัญชี demo)'
  };
}

module.exports = {
  DEMO_BOT_CODES,
  isDemoBotCode,
  heuristicPortScore,
  pickBestPortForLogin,
  buildDemoTradingPlan,
  buildConnectAdvice,
  loadDemoBot
};
