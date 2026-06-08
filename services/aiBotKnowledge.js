'use strict';

const { query } = require('../config/database');
const { fullUrl } = require('./aiSupportKnowledge');

const PACKAGE_LOT = {
  BASIC: { lotMin: 0.01, lotMax: 0.05, label: 'มือใหม่ / ทุนน้อย' },
  PRO: { lotMin: 0.01, lotMax: 0.19, label: 'ใช้งานจริง / หลายพอร์ต' },
  ADVANCED: { lotMin: 0.01, lotMax: 0.19, label: 'ผู้ใช้ระดับสูง / ยืดหยุ่นสูง' }
};

const BOT_PROFILES = {
  'AK-SNIPER-VIP-VER4.0': {
    code: 'AK-SNIPER-VIP-VER4.0',
    name: 'AK-SNIPER-VIP-VER4.0',
    symbol: 'XAUUSD (ทองคำ)',
    timeframe: 'M15',
    minCapitalUsd: 100,
    strategy:
      'บอท Sniper สไตล์ AK — เปิดออเดอร์ตามจังหวะ M15 ปรับ Lot และระดับความเสี่ยง (Trade Level) ได้ มีโหมดเวลารัน และ Trailing Stop ตาม Lot',
    howItWorks: [
      'เชื่อม MT5 ที่ /app/mt5 ให้สถานะ connected',
      'เลือก PORT ว่าง → เลือกบอท AK-SNIPER',
      'ตั้งทุน (Capital) หรือ Lot ได้เอง — 100 USD ต่อ 0.01 Lot',
      'เลือก Trade Level (ความเสี่ยง) และกด Run',
      'บอทเทรดทอง XAUUSD อัตโนมัติบน VPS'
    ],
    pros: [
      'ควบคุม Lot และระดับความเสี่ยงได้เอง',
      'ทุนขั้นต่ำต่ำ (100 USD) เหมาะมือใหม่',
      'ปรับทุนหรือ Lot ได้ยืดหยุ่น',
      'มี Trailing Stop ช่วยล็อกกำไร'
    ],
    cons: [
      'ต้องเข้าใจการตั้ง Lot/Trade Level บ้าง',
      'Lot สูงเกินแพ็กเกจจะถูกจำกัด',
      'ผลขึ้นกับสภาพตลาดทอง — ไม่มีกำไรการันตี'
    ],
    suitableFor: [
      'มือใหม่ที่อยากลองบอททองด้วยทุนเริ่มต้น ~100 USD',
      'ผู้ที่ต้องการปรับ Lot และระดับความเสี่ยงเอง',
      'แพ็กเกจ BASIC/PRO ที่ Lot 0.01–0.05 หรือ 0.19'
    ],
    notSuitableFor: [
      'ผู้ที่ไม่อยากตั้งค่า Lot/Trade Level เลย (ลอง QUEEN หรือ Quantum)',
      'ทุนต่ำกว่า 100 USD (USD account) หรือเทียบเท่า US Cent'
    ]
  },
  'QUEEN-SNIPER-AI-V1.0': {
    code: 'QUEEN-SNIPER-AI-V1.0',
    name: 'QUEEN-SNIPER-AI-V1.0',
    symbol: 'XAUUSD (ทองคำ)',
    timeframe: 'M15',
    minCapitalUsd: 100,
    strategy:
      'บอท Queen Sniper AI — ใช้ Equity ของบัญชีเป็นฐาน คำนวณ Lot อัตโนมัติจากทุน (100 USD ต่อ +0.01 Lot) เน้น Sniper M15 ไม่ต้องตั้ง Trade Level',
    howItWorks: [
      'เชื่อม MT5 ให้ connected ที่ /app/mt5',
      'เลือก PORT → เลือก QUEEN-SNIPER-AI',
      'ระบบดึง Equity เป็นทุนเริ่มต้น Lot คำนวณให้อัตโนมัติ',
      'กด Run — บอทเทรดทอง M15 บน VPS'
    ],
    pros: [
      'ไม่ต้องตั้ง Lot เอง — ระบบคำนวณจาก Equity',
      'ใช้งานง่ายกว่า AK สำหรับมือใหม่',
      'ทุนขั้นต่ำ 100 USD',
      'เหมาะกับคนที่อยากให้บอทจัดการ Lot ตามทุน'
    ],
    cons: [
      'Lot ถูกคำนวณตามทุน — ปรับ Lot เองได้จำกัด',
      'Equity ต่ำ Lot จะเล็ก กำไรอาจช้า',
      'ไม่มี Trade Level แบบ AK'
    ],
    suitableFor: [
      'มือใหม่ที่อยากให้ระบบคำนวณ Lot ให้',
      'ผู้ที่มี Equity พอสมควรและไม่อยากตั้งค่าซับซ้อน',
      'ผู้เทรดทอง M15 แบบ Sniper'
    ],
    notSuitableFor: [
      'ผู้ที่ต้องการควบคุม Lot/Trailing ละเอียดเอง (ใช้ AK)',
      'ทุนต่ำมากกว่า min capital'
    ]
  },
  'Quantum-Queen-MT5-3.65': {
    code: 'Quantum-Queen-MT5-3.65',
    name: 'Quantum-Queen-MT5-3.65',
    symbol: 'XAUUSD (ทองคำ)',
    timeframe: 'M15',
    minCapitalUsd: 500,
    strategy:
      'บอท Quantum Queen — อัลกอริทึมขั้นสูง ใช้ Equity เป็นฐาน บอทคำนวณ Lot และพารามิเตอร์ภายในอัตโนมัติ (ea_auto) เน้นผู้มีทุนมากกว่า',
    howItWorks: [
      'เชื่อม MT5 connected ที่ /app/mt5',
      'เลือก PORT → เลือก Quantum-Queen',
      'ตั้งทุนจาก Equity (ขั้นต่ำ ~500 USD)',
      'กด Run — EA จัดการ Lot/พารามิเตอร์เอง M15'
    ],
    pros: [
      'ตั้งค่าน้อยที่สุด — EA จัดการเองเกือบทั้งหมด',
      'เหมาะผู้มีทุนและประสบการณ์มากขึ้น',
      'ออกแบบสำหรับทอง XAUUSD M15'
    ],
    cons: [
      'ทุนขั้นต่ำสูงกว่า (500 USD)',
      'ควบคุม Lot เองได้น้อย',
      'ไม่เหมาะทุนเล็กหรือมือใหม่มาก'
    ],
    suitableFor: [
      'ผู้มี Equity ≥ 500 USD ที่อยากใช้ EA อัตโนมัติเต็มรูปแบบ',
      'ผู้ใช้ PRO/ADVANCED ที่ต้องการ Lot สูงขึ้น',
      'ผู้ที่เคยใช้บอทและเข้าใจความเสี่ยง'
    ],
    notSuitableFor: [
      'มือใหม่ทุนน้อย (แนะนำ AK หรือ QUEEN)',
      'ผู้ที่ต้องการปรับ Lot/Trade Level เองทุกครั้ง'
    ]
  }
};

const OPEN_BOT_STEPS_GUEST = [
  '1) ดูรายละเอียดบอททั้งหมด → ' + fullUrl('/bots'),
  '2) เปรียบเทียบแพ็กเกจ → ' + fullUrl('/pricing'),
  '3) สมัครสมาชิก → ' + fullUrl('/register'),
  '4) ยืนยันอีเมลแล้วเข้าสู่ระบบ → ' + fullUrl('/login'),
  '5) หลัง login ซื้อแพ็กเกจและเชื่อมบอทในพื้นที่สมาชิก (ถามรายละเอียดได้หลัง login)',
  '6) ตั้งค่าแจ้งเตือน LINE → ' + fullUrl('/contact') + ' แล้วลงทะเบียนใน LINE Official'
];

function normalizeBotCode(code) {
  const raw = String(code || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw.includes('AK') && raw.includes('SNIPER')) return 'AK-SNIPER-VIP-VER4.0';
  if (raw.includes('QUANTUM')) return 'Quantum-Queen-MT5-3.65';
  if (raw.includes('QUEEN')) return 'QUEEN-SNIPER-AI-V1.0';
  return raw;
}

function getBotProfile(botCode) {
  const key = normalizeBotCode(botCode);
  return BOT_PROFILES[key] || null;
}

function listBotProfiles() {
  return Object.values(BOT_PROFILES);
}

function buildGuestBotKnowledgePrompt() {
  const blocks = listBotProfiles().map((b) => {
    return [
      `### ${b.name}`,
      `สัญลักษณ์: ${b.symbol} | Timeframe: ${b.timeframe} | ทุนขั้นต่ำโดยประมาณ: ${b.minCapitalUsd} USD`,
      `แนวคิด: ${b.strategy}`,
      `การทำงาน:`,
      ...b.howItWorks.map((step, i) => `  ${i + 1}. ${step}`),
      `ข้อดี: ${b.pros.join('; ')}`,
      `ข้อเสีย: ${b.cons.join('; ')}`,
      `เหมาะกับ: ${b.suitableFor.join('; ')}`,
      `ไม่เหมาะ: ${b.notSuitableFor.join('; ')}`
    ].join('\n');
  });
  return [
    '=== บอทเทรดในระบบ TRADING AVELQUA (3 ตัว) ===',
    'บอททั้ง 3 ตัวเทรดทองคำ XAUUSD บน VPS ผ่าน MT5 Timeframe M15 — ลูกค้าต้องสมัคร login ยืนยันตัวตน ซื้อแพ็กเกจ แล้วเชื่อม MT5 ที่ /app/mt5',
    '',
    ...blocks,
    '',
    '=== เปรียบเทียบบอท 3 ตัว (สรุป) ===',
    '| บอท | ควบคุม Lot | ทุนขั้นต่ำ | เหมาะกับ |',
    '| AK-SNIPER-VIP-VER4.0 | ปรับ Lot + Trade Level เอง | ~100 USD | คนที่อยากคุมความเสี่ยงเอง |',
    '| QUEEN-SNIPER-AI-V1.0 | Lot คำนวณจาก Equity อัตโนมัติ | ~100 USD | มือใหม่ ไม่อยากตั้ง Lot |',
    '| Quantum-Queen-MT5-3.65 | EA จัดการ Lot/พารามิเตอร์เอง | ~500 USD | มีทุนมากขึ้น อยากใช้ EA เต็มรูปแบบ |',
    '',
    '=== ขั้นตอนเริ่มต้น (เฉพาะหน้าสาธารณะ) ===',
    ...OPEN_BOT_STEPS_GUEST,
    '',
    '=== แพ็กเกจ vs Lot (ดูรายละเอียดที่ ' + fullUrl('/pricing') + ') ===',
    `BASIC: Lot ${PACKAGE_LOT.BASIC.lotMin}-${PACKAGE_LOT.BASIC.lotMax} (${PACKAGE_LOT.BASIC.label})`,
    `PRO: Lot ${PACKAGE_LOT.PRO.lotMin}-${PACKAGE_LOT.PRO.lotMax} (${PACKAGE_LOT.PRO.label})`,
    `ADVANCED: Lot ${PACKAGE_LOT.ADVANCED.lotMin}-${PACKAGE_LOT.ADVANCED.lotMax} (${PACKAGE_LOT.ADVANCED.label})`,
    '',
    '=== เมื่อถามเรื่องบอท ===',
    '- อธิบายการทำงานของแต่ละตัวละเอียด เปรียบเทียบ 3 ตัว บอกข้อดี/ข้อเสีย',
    '- ใช้ get_bot_info หรือ recommend_bot ถ้าต้องการแนะนำตามทุน/ประสบการณ์',
    '- ห้ามอธิบายการตั้งค่า MT5/PORT ในพื้นที่สมาชิก — ให้แนะนำ login ก่อน'
  ].join('\n');
}

function buildBotKnowledgePrompt() {
  const blocks = listBotProfiles().map((b) => {
    return [
      `### ${b.name}`,
      `สัญลักษณ์: ${b.symbol} | Timeframe: ${b.timeframe} | ทุนขั้นต่ำ: ${b.minCapitalUsd} USD`,
      `แนวคิด: ${b.strategy}`,
      `การทำงาน (ขั้นตอน):`,
      ...b.howItWorks.map((step, i) => `  ${i + 1}. ${step}`),
      `ข้อดี: ${b.pros.join('; ')}`,
      `ข้อเสีย: ${b.cons.join('; ')}`,
      `เหมาะกับ: ${b.suitableFor.join('; ')}`,
      `ไม่เหมาะ: ${b.notSuitableFor.join('; ')}`
    ].join('\n');
  });
  return [
    '=== บอทเทรดในระบบ (3 ตัว) — อธิบายละเอียดเมื่อลูกค้าถาม ===',
    'ทั้ง 3 ตัวเทรด XAUUSD (ทอง) บน VPS ผ่าน MT5 Timeframe M15',
    'เงื่อนไขก่อนรันบอท: ยืนยันตัวตนแล้ว + แพ็กเกจ active + MT5 connected ที่ ' + fullUrl('/app/mt5'),
    '',
    ...blocks,
    '',
    '=== เปรียบเทียบบอท 3 ตัว ===',
    '1) AK-SNIPER-VIP-VER4.0 — Sniper M15 ปรับ Lot และ Trade Level (ความเสี่ยง) เอง มี Trailing Stop ทุนต่ำ ~100 USD',
    '2) QUEEN-SNIPER-AI-V1.0 — Sniper M15 ใช้ Equity คำนวณ Lot อัตโนมัติ (100 USD ≈ 0.01 Lot) ใช้ง่าย ไม่ต้องตั้ง Trade Level',
    '3) Quantum-Queen-MT5-3.65 — EA ขั้นสูง จัดการ Lot/พารามิเตอร์เองเกือบทั้งหมด ทุนขั้นต่ำ ~500 USD',
    '',
    '=== ขั้นตอนเปิดบอท (ลูกค้า login แล้ว) ===',
    '1) ยืนยันตัวตน → ' + fullUrl('/app/identity'),
    '2) ซื้อ/ต่อแพ็กเกจ → ' + fullUrl('/app/packages'),
    '3) เชื่อม MT5 ให้ connected → ' + fullUrl('/app/mt5'),
    '4) เลือก PORT ว่าง → เลือกบอท → ตั้งค่า (ถ้าจำเป็น) → กด Run',
    '5) ดูผลที่ปฏิทิน PnL → ' + fullUrl('/app/calendar'),
    '',
    '=== แพ็กเกจ vs Lot ===',
    `BASIC: Lot ${PACKAGE_LOT.BASIC.lotMin}-${PACKAGE_LOT.BASIC.lotMax} (${PACKAGE_LOT.BASIC.label})`,
    `PRO: Lot ${PACKAGE_LOT.PRO.lotMin}-${PACKAGE_LOT.PRO.lotMax} (${PACKAGE_LOT.PRO.label})`,
    `ADVANCED: Lot ${PACKAGE_LOT.ADVANCED.lotMin}-${PACKAGE_LOT.ADVANCED.lotMax} (${PACKAGE_LOT.ADVANCED.label})`,
    '',
    '=== เมื่อลูกค้าถามว่าควรใช้บอทไหน ===',
    '- ใช้ get_bot_info พร้อมข้อมูลแพ็กเกจ/Equity ของลูกค้า',
    '- ใช้ recommend_bot ถ้าถามคำแนะนำทั่วไป',
    '- อธิบายการทำงาน + ข้อดี/ข้อเสีย + เปรียบเทียบ 3 ตัว ไม่สัญญากำไร'
  ].join('\n');
}

async function fetchActiveBotsFromDb() {
  const result = await query(
    `SELECT bot_code, bot_name, display_name, symbol, default_lot, max_lot, required_ports, sort_order
     FROM vps_system.bot_catalog
     WHERE is_active = TRUE
     ORDER BY sort_order ASC, id ASC`
  ).catch(() => ({ rows: [] }));
  return result.rows || [];
}

async function getBotCatalog({ botCode = '', userContext = null, guestMode = false } = {}) {
  const dbBots = await fetchActiveBotsFromDb();
  const profiles = listBotProfiles();
  const openSteps = guestMode ? OPEN_BOT_STEPS_GUEST : OPEN_BOT_STEPS_GUEST;

  const merged = profiles.map((profile) => {
    const db = dbBots.find(
      (r) => String(r.bot_code || '').toUpperCase() === profile.code.toUpperCase()
    );
    const item = {
      code: profile.code,
      name: profile.name,
      symbol: profile.symbol,
      timeframe: profile.timeframe,
      minCapitalUsd: profile.minCapitalUsd,
      strategy: profile.strategy,
      pros: profile.pros,
      cons: profile.cons,
      suitableFor: profile.suitableFor,
      notSuitableFor: profile.notSuitableFor,
      active: !!db || true,
      defaultLot: db?.default_lot,
      maxLot: db?.max_lot,
      requiredPorts: db?.required_ports || 1,
      botsPage: fullUrl('/bots'),
      pricingPage: fullUrl('/pricing'),
      registerPage: fullUrl('/register'),
      loginPage: fullUrl('/login')
    };

    if (!guestMode) {
      item.howItWorks = profile.howItWorks;
      item.mt5Page = fullUrl('/app/mt5');
    }

    if (userContext?.loggedIn && !guestMode) {
      const pkgGroup = String(userContext.package?.group || userContext.package?.name || '').toUpperCase();
      const lotPolicy = PACKAGE_LOT[pkgGroup.includes('PRO') ? 'PRO' : pkgGroup.includes('ADV') ? 'ADVANCED' : 'BASIC'];
      const minOk = !userContext.mt5Accounts?.length
        ? null
        : userContext.mt5Accounts.some((a) => Number(a.equity || a.balance || 0) >= profile.minCapitalUsd);
      item.personalFit = {
        packageGroup: lotPolicy.label,
        lotRange: `${lotPolicy.lotMin}-${lotPolicy.lotMax}`,
        packageActive: !!userContext.package && !userContext.package?.expired,
        identityOk: !!userContext.identityVerified,
        capitalHint:
          profile.minCapitalUsd <= 100
            ? 'ทุนขั้นต่ำต่ำ — เหมาะเริ่มต้น'
            : 'ต้องการทุน ~500 USD ขึ้นไป',
        equityMeetsMin: minOk
      };
    }

    return item;
  });

  if (botCode) {
    const one = merged.find((b) => normalizeBotCode(botCode) === b.code) || null;
    return {
      ok: !!one,
      bot: one,
      openSteps,
      guestMode,
      note: guestMode ? 'รายละเอียดการเชื่อมบอทจริงอยู่ในพื้นที่สมาชิก — กรุณา login ก่อน' : undefined
    };
  }

  return {
    ok: true,
    bots: merged,
    openSteps,
    guestMode,
    compareHint:
      'AK = ปรับ Lot/Trade Level เอง | QUEEN = Lot จาก Equity อัตโนมัติ | Quantum = EA จัดการเอง ทุนขั้นต่ำสูง',
    note: guestMode ? 'อธิบายได้เฉพาะหน้า /bots /pricing และขั้นตอนสมัคร/login' : undefined
  };
}

function recommendBot({ capitalUsd = 0, experience = 'beginner', wantsControl = null } = {}) {
  const cap = Number(capitalUsd) || 0;
  const exp = String(experience || 'beginner').toLowerCase();

  let recommended = 'QUEEN-SNIPER-AI-V1.0';
  let reason = 'ใช้งานง่าย Lot คำนวณจาก Equity ทุนขั้นต่ำ 100 USD';

  if (cap >= 500 && (exp === 'advanced' || exp === 'pro')) {
    recommended = 'Quantum-Queen-MT5-3.65';
    reason = 'ทุนเพียงพอและมีประสบการณ์ — EA จัดการอัตโนมัติ';
  } else if (wantsControl === true || exp === 'intermediate') {
    recommended = 'AK-SNIPER-VIP-VER4.0';
    reason = 'ต้องการควบคุม Lot และ Trade Level เอง';
  } else if (cap > 0 && cap < 500) {
    recommended = cap >= 100 ? 'QUEEN-SNIPER-AI-V1.0' : 'AK-SNIPER-VIP-VER4.0';
    reason = cap >= 100 ? 'ทุน 100+ เหมาะ QUEEN' : 'ทุนต่ำแนะนำ AK เริ่ม Lot เล็ก';
  }

  const profile = getBotProfile(recommended);
  return {
    ok: true,
    recommended: profile?.code || recommended,
    reason,
    profile,
    disclaimer: 'เป็นเพียงคำแนะนำเบื้องต้น ไม่ใช่คำแนะนำการลงทุน ผลลัพธ์ขึ้นกับตลาดและการตั้งค่า'
  };
}

module.exports = {
  BOT_PROFILES,
  PACKAGE_LOT,
  OPEN_BOT_STEPS_GUEST,
  getBotProfile,
  listBotProfiles,
  buildGuestBotKnowledgePrompt,
  buildBotKnowledgePrompt,
  getBotCatalog,
  recommendBot,
  normalizeBotCode
};
