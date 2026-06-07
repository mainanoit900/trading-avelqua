'use strict';

const BASE_URL = process.env.APP_BASE_URL || process.env.BASE_URL || 'https://trading.avelqua.com';

/** หน้าที่ AI อธิบายได้เมื่อผู้ใช้ยังไม่ login */
const PUBLIC_GUEST_PAGE_KEYS = [
  'home',
  'bots',
  'market',
  'pricing',
  'news',
  'contact',
  'login',
  'register',
  'forgot_password'
];

const PAGE_GUIDES = {
  home: {
    path: '/',
    title: 'หน้าแรก',
    menu: 'เมนูด้านบน → โลโก้ TRADING AVELQUA',
    usage:
      'แนะนำบริการ Bot Trading, แพ็กเกจ, ข่าวตลาด และทางเข้าสู่ระบบ ลูกค้าใหม่กด "สมัครสมาชิก" หรือ "เข้าสู่ระบบ" ที่มุมขวาบน'
  },
  login: {
    path: '/login',
    title: 'เข้าสู่ระบบ',
    menu: 'มุมขวาบนของเว็บ → เข้าสู่ระบบ',
    usage:
      'กรอกอีเมลและรหัสผ่าน หรือใช้ปุ่ม Google / LINE Login หากยังไม่ยืนยันอีเมล ระบบจะแจ้งให้ยืนยันก่อน ลืมรหัส → /forgot-password'
  },
  register: {
    path: '/register',
    title: 'สมัครสมาชิก',
    menu: 'มุมขวาบนของเว็บ → สมัครสมาชิก',
    usage:
      '1) กรอกชื่อ อีเมล รหัสผ่าน 2) กดสมัคร 3) เปิดอีเมลยืนยัน (ตรวจ Spam ด้วย) 4) กดลิงก์ยืนยัน 5) เข้าสู่ระบบที่ /login 6) ไป /app/identity เพื่อยืนยันตัวตนก่อนใช้งาน MT5/Scoin'
  },
  forgot_password: {
    path: '/forgot-password',
    title: 'ลืมรหัสผ่าน',
    menu: 'หน้า /login → ลิงก์ "ลืมรหัสผ่าน"',
    usage: 'กรอกอีเมลที่สมัคร → รับลิงก์ตั้งรหัสใหม่ทางอีเมล (อายุ 30 นาที)'
  },
  bots: {
    path: '/bots',
    title: 'Bots (หน้าสาธารณะ)',
    menu: 'เมนูด้านบน → Bots',
    usage: 'ดูรายละเอียดบอทและความสามารถก่อนสมัคร การเชื่อมต่อจริงทำที่ /app/mt5 หลังซื้อแพ็กเกจและยืนยันตัวตน'
  },
  market: {
    path: '/market',
    title: 'ตลาด',
    menu: 'เมนูด้านบน → Market',
    usage: 'ดูภาพรวมตลาดและข้อมูลประกอบการเทรด ไม่ใช่คำแนะนำการลงทุน'
  },
  pricing: {
    path: '/pricing',
    title: 'ราคาแพ็กเกจ',
    menu: 'เมนูด้านบน → Pricing',
    usage: 'เปรียบเทียบแพ็กเกจ BASIC / PRO / ADVANCED ซื้อจริงที่ /app/packages หลังเข้าสู่ระบบ'
  },
  news: {
    path: '/news',
    title: 'ข่าว',
    menu: 'เมนูด้านบน → News',
    usage: 'อ่านข่าวตลาดล่าสุดพร้อมสรุป AI (ถ้าเปิดใช้งาน)'
  },
  contact: {
    path: '/contact',
    title: 'ติดต่อเรา',
    menu: 'เมนูด้านบน → Contact',
    usage: 'ช่องทางอีเมล Facebook LINE TikTok และแผนที่ สำหรับปัญหาเร่งด่วนใช้แชท AI หรือ LINE Official'
  },
  app_dashboard: {
    path: '/app',
    title: 'แดชบอร์ดลูกค้า',
    menu: 'เมนูซ้าย → Overview (🏠)',
    usage:
      'ภาพรวมแพ็กเกจ สิทธิ์ MT5 Scoin และทางลัดไปซื้อแพ็กเกจ / เชื่อม MT5 / กระเป๋า Scoin หากยังไม่ยืนยันตัวตน จะมีแจ้งเตือนให้ไป /app/identity'
  },
  app_packages: {
    path: '/app/packages',
    title: 'ซื้อแพ็กเกจ',
    menu: 'เมนูซ้าย → ซื้อแพ็กเกจ (🛒)',
    usage:
      'เลือกแพ็กเกจ → ชำระเงิน (โอน/บัตร/Scoin ตามที่เปิด) → รออนุมัติ → ใช้สิทธิ์ MT5 ได้เมื่อแพ็กเกจ active และยืนยันตัวตนแล้ว ต้องยืนยันตัวตนก่อนเข้าหน้านี้'
  },
  app_mt5: {
    path: '/app/mt5',
    title: 'เชื่อมต่อ MT5 / Bot',
    menu: 'เมนูซ้าย → Bot Connection (💻)',
    usage:
      '1) ต้องมีแพ็กเกจ active + ยืนยันตัวตน 2) กรอก MT5 Login, Password, Server (Exness-MT5Real) 3) กดเชื่อมต่อ 4) รอสถานะ connected 5) เลือกบอทและ Lot แล้วกด Run หาก failed ตรวจ Login/Password/Server ให้ตรง broker'
  },
  app_broker_accounts: {
    path: '/app/broker-accounts',
    title: 'บัญชี Broker',
    menu: 'เมนูซ้าย → Broker Accounts (📊)',
    usage: 'จัดการบัญชีโบรกเกอร์ที่บันทึกไว้ ใช้ประกอบการเทรดและรายงาน'
  },
  app_calendar: {
    path: '/app/calendar',
    title: 'ปฏิทิน PnL',
    menu: 'เมนูซ้าย → ปฏิทิน PnL (📅)',
    usage: 'ดูกำไร/ขาดทุนรายวันจากบัญชี MT5 ที่เชื่อมต่อ'
  },
  app_calendar_ai: {
    path: '/app/calendar/ai',
    title: 'AI วิเคราะห์ 15/30 วัน',
    menu: 'เมนูซ้าย → AI วิเคราะห์ 15/30 วัน (🤖)',
    usage: 'ดูการวิเคราะห์แนวโน้ม PnL 15 และ 30 วันจากข้อมูลของคุณ ใช้ประกอบเท่านั้น ไม่ใช่คำแนะนำการลงทุน'
  },
  app_scoin_wallet: {
    path: '/app/scoin-wallet',
    title: 'กระเป๋า Scoin',
    menu: 'เมนูซ้าย → กระเป๋า Scoin (💳)',
    usage: 'ดูยอด Scoin โอนให้ผู้อื่นด้วย Wallet Code ซื้อ/ขาย Scoin ผ่านตลาด Scoin ต้องยืนยันตัวตนก่อน'
  },
  app_referrals: {
    path: '/app/referrals',
    title: 'สายงานของฉัน',
    menu: 'เมนูซ้าย → สายงานของฉัน (👥)',
    usage: 'ดูรหัสแนะนำ ลิงก์สมัคร และคอมมิชชั่นจากสมาชิกที่แนะนำ'
  },
  app_bank_accounts: {
    path: '/app/bank-accounts',
    title: 'ตั้งค่าบัญชีธนาคาร',
    menu: 'เมนูซ้าย → ตั้งค่าบัญชีธนาคาร (🏦)',
    usage: 'ลงทะเบียนบัญชีรับเงิน (ถอน/ขาย Scoin) ยืนยันด้วย OTP ทางอีเมล'
  },
  app_status: {
    path: '/app/status',
    title: 'สถานะบัญชี',
    menu: 'เมนูซ้าย → Account Status (🛡️)',
    usage: 'ตรวจสอบสถานะยืนยันตัวตน แพ็กเกจ วันหมดอายุ และ Scoin คงเหลือ'
  },
  app_identity: {
    path: '/app/identity',
    title: 'ยืนยันตัวตน',
    menu: 'เมนูซ้าย → รอยืนยันตัวตน / ยืนยันสำเร็จ (🛂)',
    usage:
      'กรอกข้อมูลส่วนตัวที่อยู่ เบอร์โทร → ขอรหัส OTP → กรอก OTP จากอีเมล หลังยืนยันแล้วจึงใช้ MT5, Scoin และเมนูที่มี 🔒 ได้'
  }
};

const MT5_TROUBLESHOOTING = [
  {
    issue: 'MT5 Login ไม่ได้ / authorization failed',
    causes: [
      'Login หรือ Password MT5 ไม่ถูกต้อง',
      'Server ไม่ตรง (ใช้ Exness-MT5Real สำหรับ Exness)',
      'บัญชี MT5 ถูกผูกกับผู้ใช้อื่นในระบบแล้ว',
      'แพ็กเกจหมดอายุหรือยังไม่ซื้อ',
      'ยังไม่ยืนยันตัวตน (/app/identity)'
    ],
    fixes: [
      'ตรวจ Login/Password ใน MT5 Terminal ให้เข้าได้ก่อน',
      'ตรวจ Server ให้ตรงกับ broker',
      'ไป /app/status ดูแพ็กเกจและสถานะ',
      'หากค้าง connecting นาน ให้ยกเลิก PORT แล้วเชื่อมใหม่ที่ /app/mt5'
    ]
  },
  {
    issue: 'เข้าบอทไม่ได้ / Run Bot ไม่ได้',
    causes: [
      'ยังไม่เชื่อม MT5 สำเร็จ (status ไม่ใช่ connected)',
      'แพ็กเกจหมดอายุ',
      'Lot size เกินสิทธิ์แพ็กเกจ',
      'PORT กำลังใช้งานโดยบอทอื่น',
      'VPS/PORT ไม่ว่างชั่วคราว'
    ],
    fixes: [
      'เชื่อม MT5 ให้ connected ก่อนที่ /app/mt5',
      'ตรวจแพ็กเกจที่ /app/packages หรือ /app/status',
      'ปรับ Lot ให้อยู่ในช่วงที่แพ็กเกจอนุญาต',
      'หยุดบอทเดิมก่อนรันบอทใหม่'
    ]
  },
  {
    issue: 'เมนูกดไม่ได้ / ถูก redirect ไป identity',
    causes: ['ยังไม่ยืนยันตัวตนที่ /app/identity'],
    fixes: ['ไป /app/identity กรอกข้อมูลและยืนยัน OTP']
  }
];

const LINE_GUIDE = {
  summary: 'แจ้งเตือนผ่าน LINE Official Account ของ TRADING AVELQUA',
  steps: [
    '1) สมัครและยืนยันอีเมลที่เว็บ trading.avelqua.com',
    '2) เพิ่มเพื่อน LINE Official จากหน้า /contact',
    '3) ในแชท LINE พิมพ์ "ลงทะเบียน" แล้วส่งอีเมลที่ใช้สมัคร',
    '4) พิมพ์ "แจ้งสรุปผล" เพื่อเปิดรับสรุป PnL อัตโนมัติ 07:00 น. จ-พฤ และเสาร์',
    '5) คำสั่งอื่น: "เช็คพอร์ต" "เช็คแพ็กเกจปัจจุบัน" "แจ้งปัญหาใช้งาน" "ช่วยเหลือ"'
  ],
  contactPage: `${BASE_URL}/contact`
};

const MARKET_GUIDE = {
  disclaimer:
    'การวิเคราะห์ตลาดเป็นเพียงข้อมูลประกอบ ไม่ใช่คำแนะนำการลงทุน ผลในอดีตไม่รับประกันผลในอนาคต',
  pages: [`${BASE_URL}/market`, `${BASE_URL}/news`, `${BASE_URL}/app/calendar/ai`]
};

function fullUrl(path) {
  const p = String(path || '/').startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${p}`;
}

function getPageGuide(pageKey) {
  return PAGE_GUIDES[pageKey] || null;
}

function getPageGuideByPath(pathname) {
  const path = String(pathname || '/').split('?')[0];
  for (const [key, guide] of Object.entries(PAGE_GUIDES)) {
    if (guide.path === path) return { key, ...guide, url: fullUrl(guide.path) };
    if (path.startsWith('/app/') && guide.path.startsWith('/app/') && path.startsWith(guide.path)) {
      return { key, ...guide, url: fullUrl(guide.path) };
    }
  }
  if (path.startsWith('/app')) {
    return { key: 'app_dashboard', ...PAGE_GUIDES.app_dashboard, url: fullUrl('/app') };
  }
  return null;
}

function isGuestAllowedPageKey(pageKey) {
  return PUBLIC_GUEST_PAGE_KEYS.includes(String(pageKey || '').trim());
}

function isGuestAllowedPath(pathname) {
  const path = String(pathname || '/').split('?')[0];
  if (path === '/') return true;
  const allowedPaths = PUBLIC_GUEST_PAGE_KEYS.map((k) => PAGE_GUIDES[k]?.path).filter(Boolean);
  return allowedPaths.includes(path);
}

const GUEST_PAGE_USAGE_OVERRIDES = {
  register:
    '1) กรอกชื่อ อีเมล รหัสผ่าน 2) กดสมัคร 3) เปิดอีเมลยืนยัน (ตรวจ Spam) 4) กดลิงก์ยืนยัน 5) เข้าสู่ระบบที่ /login — หลัง login จึงซื้อแพ็กเกจและใช้บอทในพื้นที่สมาชิก',
  bots:
    'ดูรายละเอียดบอทเทรด จุดเด่น และขั้นตอนเริ่มต้น — การเชื่อมบอทจริงทำหลังสมัครและ login แล้ว',
  pricing:
    'เปรียบเทียบแพ็กเกจ BASIC / PRO / ADVANCED ดู Lot และจำนวนพอร์ต — กดซื้อได้หลังสมัครและ login',
  market:
    'ดูภาพรวมตลาดและข้อมูลประกอบการเทรด ไม่ใช่คำแนะนำการลงทุน',
  news: 'อ่านข่าวตลาดล่าสุดพร้อมสรุป (ถ้าเปิดใช้งาน)',
  contact:
    'ช่องทางอีเมล Facebook LINE TikTok — เพิ่มเพื่อน LINE Official จากหน้านี้เพื่อรับแจ้งเตือน'
};

function buildGuestKnowledgePrompt() {
  const pages = PUBLIC_GUEST_PAGE_KEYS.map((key) => {
    const g = PAGE_GUIDES[key];
    if (!g) return '';
    const usage = GUEST_PAGE_USAGE_OVERRIDES[key] || g.usage;
    return `- [${key}] ${g.title}: ${fullUrl(g.path)} | เมนู: ${g.menu} | วิธีใช้: ${usage}`;
  }).join('\n');

  return [
    '=== ขอบเขตผู้เยี่ยมชม (ยังไม่ login) — อธิบายได้เฉพาะหน้าเหล่านี้ ===',
    pages,
    '',
    '=== แจ้งเตือน LINE ===',
    LINE_GUIDE.summary,
    ...LINE_GUIDE.steps,
    `ลิงก์เพิ่มเพื่อน LINE: ${LINE_GUIDE.contactPage}`,
    '',
    '=== ตลาด / ข่าว (หน้าสาธารณะ) ===',
    MARKET_GUIDE.disclaimer,
    `หน้าตลาด: ${fullUrl('/market')} | หน้าข่าว: ${fullUrl('/news')}`,
    '',
    '=== ข้อห้ามสำหรับผู้เยี่ยมชม ===',
    '- ห้ามอธิบายรายละเอียบหน้า /app/* (พื้นที่สมาชิก)',
    '- ห้ามแก้ปัญหา MT5/บัญชีเฉพาะราย — ให้แนะนำ login ก่อน',
    '- ถ้าถามเรื่องพื้นที่สมาชิก ตอบสั้นๆ ว่าต้อง login ที่ ' + fullUrl('/login')
  ].join('\n');
}

function buildKnowledgePrompt() {
  const pages = Object.entries(PAGE_GUIDES)
    .map(([key, g]) => `- [${key}] ${g.title}: ${fullUrl(g.path)} | เมนู: ${g.menu} | วิธีใช้: ${g.usage}`)
    .join('\n');

  const mt5 = MT5_TROUBLESHOOTING.map(
    (t) => `ปัญหา: ${t.issue}\nสาเหตุ: ${t.causes.join('; ')}\nแนวทาง: ${t.fixes.join('; ')}`
  ).join('\n\n');

  return [
    '=== คู่มือหน้าเว็บ ===',
    pages,
    '',
    '=== แจ้งเตือน LINE ===',
    LINE_GUIDE.summary,
    ...LINE_GUIDE.steps,
    `ลิงก์ติดต่อ LINE: ${LINE_GUIDE.contactPage}`,
    '',
    '=== แก้ปัญหา MT5 / Bot ===',
    mt5,
    '',
    '=== ตลาด / วิเคราะห์ ===',
    MARKET_GUIDE.disclaimer,
    `หน้าที่เกี่ยวข้อง: ${MARKET_GUIDE.pages.join(', ')}`
  ].join('\n');
}

module.exports = {
  BASE_URL,
  PUBLIC_GUEST_PAGE_KEYS,
  PAGE_GUIDES,
  MT5_TROUBLESHOOTING,
  LINE_GUIDE,
  MARKET_GUIDE,
  fullUrl,
  getPageGuide,
  getPageGuideByPath,
  isGuestAllowedPageKey,
  isGuestAllowedPath,
  buildGuestKnowledgePrompt,
  buildKnowledgePrompt
};
