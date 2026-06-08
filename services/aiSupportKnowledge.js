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
    usage:
      'ข้อมูลบริษัท คิวอาร์ เมดิคัล จำกัด (QR MEDICAL CO., LTD.) ที่อยู่ แผนที่ Google Maps อีเมล Facebook LINE TikTok — สแกน QR LINE เพื่อเพิ่มเพื่อน Official Account'
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
    menu: 'เมนูซ้าย → ยืนยันตัวตน (🛂)',
    usage:
      '1) เลือกประเภทเอกสาร: บัตรประชาชน หรือ พาสปอร์ต 2) เลือกรูป/ถ่ายภาพบัตรให้ชัด 3) กดปุ่ม "ตรวจสอบ" ระบบอ่านข้อมูลจากเอกสาร (OpenAI + OCR สำรอง) 4) ตรวจสอบข้อมูลที่ระบบกรอก (ชื่อ เลขบัตร/พาสปอร์ต วันเกิด วันหมดอายุ ที่อยู่) 5) กรอกรหัสไปรษณีย์ 5 หลักเอง (บัตรประชาชนไม่มีรหัสบนบัตร) 6) กรอกเบอร์โทรและอีเมลรับ OTP 7) กดขอรหัส OTP → กรอก OTP จากอีเมล 8) ยืนยันสำเร็จแล้วใช้ MT5 / Scoin / เมนูที่ล็อกได้'
  }
};

const IDENTITY_VERIFICATION_GUIDE = {
  url: `${BASE_URL}/app/identity`,
  requiredFor: [
    'เชื่อม MT5 และรันบอท',
    'ซื้อแพ็กเกจ / ชำระเงิน',
    'ใช้กระเป๋า Scoin',
    'เมนูที่มีไอคอน 🔒 ในพอร์ทัลลูกค้า'
  ],
  documentTypes: {
    thai_id: 'บัตรประชาชนไทย — ระบบตรวจ checksum เลข 13 หลัก และกันบัตรซ้ำในระบบ',
    passport: 'พาสปอร์ต — ตรวจรูปแบบเลขหนังสือเดินทางและวันหมดอายุ'
  },
  steps: [
    '1) ไปที่ ' + `${BASE_URL}/app/identity`,
    '2) เลือกประเภทเอกสาร: บัตรประชาชน หรือ พาสปอร์ต',
    '3) กด "เลือกรูป / ถ่ายภาพ" — ถ่ายให้เห็นเลขและชื่อชัด ไม่เอียง แสงพอ',
    '4) กดปุ่ม "ตรวจสอบ" — ระบบอ่านข้อมูลจากรูปอัตโนมัติ',
    '5) ตรวจข้อมูลที่กรอกให้ (ชื่อ เลขบัตร/พาสปอร์ต วันเกิด วันหมดอายุ ที่อยู่)',
    '6) กรอกรหัสไปรษณีย์ 5 หลักเอง (บัตรประชาชนไม่มีรหัสบนบัตร — ระบบอาจเติมให้ถ้าอ่านที่อยู่ได้)',
    '7) กรอกเบอร์โทรและอีเมลรับ OTP',
    '8) กดขอรหัส OTP → เปิดอีเมล → กรอก OTP → ยืนยันสำเร็จ',
    '9) หลังยืนยันแล้ว รูปเอกสารจะถูกบันทึก และสามารถใช้ MT5 / Scoin ได้'
  ],
  tips: [
    'ถ่ายบัตรตรงๆ ไม่ใช่ screenshot หน้าจอ — อ่านได้แม่นขึ้น',
    'เลขบัตรต้องครบ 13 หลักและผ่าน checksum',
    'เอกสารหมดอายุแล้วใช้ไม่ได้',
    'เลขบัตร/พาสปอร์ตที่เคยยืนยันแล้วในระบบจะใช้ซ้ำไม่ได้',
    'OTP หมดอายุใน 10 นาที — ขอใหม่ได้ที่หน้านี้หรือให้ AI ช่วย resend_identity_otp'
  ],
  troubleshooting: [
    {
      issue: 'กดตรวจสอบแล้วอ่านข้อมูลไม่ได้',
      fixes: [
        'ถ่ายใหม่ให้เห็นเลข 13 หลักและชื่อชัด',
        'ลองเปลี่ยนมุม/แสง หรือใช้รูปความละเอียดสูง',
        'ตรวจว่าเลือกประเภทเอกสารถูก (บัตร vs พาสปอร์ต)'
      ]
    },
    {
      issue: 'ขอ OTP ไม่ได้ / กดขอรหัสไม่ได้',
      fixes: [
        'ต้องกด "ตรวจสอบ" เอกสารสำเร็จก่อน',
        'กรอกรหัสไปรษณีย์ 5 หลัก (บัตรประชาชน)',
        'ตรวจอีเมลรับ OTP ให้ถูก'
      ]
    },
    {
      issue: 'OTP หมดอายุ',
      fixes: ['กดขอ OTP ใหม่ หรือให้ AI ใช้ perform_user_fix action=resend_identity_otp']
    }
  ]
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
    fixes: [
      'ไป ' + fullUrl('/app/identity') + ' → เลือกบัตร/พาสปอร์ต → ถ่ายรูป → กด "ตรวจสอบ" → กรอกรหัสไปรษณีย์ → ขอ OTP → ยืนยัน'
    ]
  },
  {
    issue: 'ยืนยันตัวตน / สแกนบัตรไม่ผ่าน',
    causes: [
      'รูปไม่ชัด อ่านเลขบัตร/ชื่อไม่ได้',
      'เลขบัตรไม่ถูกต้อง (checksum ไม่ผ่าน)',
      'บัตรหมดอายุ',
      'เลขบัตร/พาสปอร์ตถูกใช้ยืนยันโดยบัญชีอื่นแล้ว',
      'ยังไม่กด "ตรวจสอบ" เอกสารก่อนขอ OTP',
      'รหัสไปรษณีย์ไม่ครบ 5 หลัก (บัตรประชาชน)'
    ],
    fixes: IDENTITY_VERIFICATION_GUIDE.troubleshooting.flatMap((t) => t.fixes)
  }
];

const LINE_GUIDE = {
  summary: 'แจ้งเตือนผ่าน LINE Official Account ของ TRADING AVELQUA',
  steps: [
    '1) สมัครและยืนยันอีเมลที่เว็บ trading.avelqua.com',
    '2) เพิ่มเพื่อน LINE Official จากหน้า /contact หรือสแกน QR Code LINE',
    '3) ในแชท LINE พิมพ์ "ลงทะเบียน" แล้วส่งอีเมลที่ใช้สมัคร',
    '4) พิมพ์ "แจ้งสรุปผล" เพื่อเปิดรับสรุป PnL อัตโนมัติ 07:00 น. จ-พฤ และเสาร์',
    '5) คำสั่งอื่น: "เช็คพอร์ต" "เช็คแพ็กเกจปัจจุบัน" "แจ้งปัญหาใช้งาน" "ช่วยเหลือ"'
  ],
  contactPage: `${BASE_URL}/contact`,
  qrImagePath: '/public/images/QR-CORD-LINE.jpg',
  qrImageUrl: `${BASE_URL}/public/images/QR-CORD-LINE.jpg`
};

const COMPANY_INFO = {
  nameTh: 'บริษัท คิวอาร์ เมดิคัล จำกัด',
  nameEn: 'QR MEDICAL CO., LTD.',
  brand: 'TRADING AVELQUA',
  address:
    '244/4 ซอย วิภาวดี รังสิต 43 ถนนวิภาวดี แขวงสนามบิน เขตดอนเมือง กรุงเทพมหานคร 10210',
  mapUrl: 'https://maps.app.goo.gl/ESYQD4CDz5WCYu8w8',
  contactPage: `${BASE_URL}/contact`,
  lineQrUrl: `${BASE_URL}/public/images/QR-CORD-LINE.jpg`
};

function getCompanyInfo(includeLineQr = false) {
  const base = {
    ok: true,
    nameTh: COMPANY_INFO.nameTh,
    nameEn: COMPANY_INFO.nameEn,
    brand: COMPANY_INFO.brand,
    address: COMPANY_INFO.address,
    mapUrl: COMPANY_INFO.mapUrl,
    contactPage: COMPANY_INFO.contactPage,
    summary: `${COMPANY_INFO.nameTh} (${COMPANY_INFO.nameEn}) — ผู้ให้บริการแพลตฟอร์ม ${COMPANY_INFO.brand}`
  };
  if (includeLineQr) {
    base.lineQrUrl = COMPANY_INFO.lineQrUrl;
    base.lineQrMarkdown = `![LINE QR Code — สแกนเพิ่มเพื่อน](${COMPANY_INFO.lineQrUrl})`;
    base.lineHint = 'ส่ง QR ในแชทด้วย markdown รูปข้างต้น';
  }
  return base;
}

function buildCompanyKnowledgePrompt() {
  return [
    '=== ข้อมูลบริษัท ===',
    `ชื่อ: ${COMPANY_INFO.nameTh} (${COMPANY_INFO.nameEn})`,
    `แพลตฟอร์ม: ${COMPANY_INFO.brand}`,
    `ที่อยู่: ${COMPANY_INFO.address}`,
    `แผนที่ Google Maps: ${COMPANY_INFO.mapUrl}`,
    `หน้าติดต่อ: ${COMPANY_INFO.contactPage}`,
    `LINE QR สแกนเพิ่มเพื่อน: ${COMPANY_INFO.lineQrUrl}`,
    '- ถ้าถามเรื่องบริษัท/ที่อยู่/ติดต่อ → ใช้ get_company_info',
    '- ถ้าถามติดต่อ LINE / ขอ QR LINE → ใช้ get_company_info include_line_qr=true แล้วใส่ lineQrMarkdown ในคำตอบ'
  ].join('\n');
}

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
    `QR LINE สแกนเพิ่มเพื่อน: ${LINE_GUIDE.qrImageUrl}`,
    '',
    buildCompanyKnowledgePrompt(),
    '',
    buildIdentityKnowledgePrompt({ guest: true }),
    MARKET_GUIDE.disclaimer,
    `หน้าตลาด: ${fullUrl('/market')} | หน้าข่าว: ${fullUrl('/news')}`,
    '',
    '=== ข้อห้ามสำหรับผู้เยี่ยมชม ===',
    '- ห้ามอธิบายรายละเอียบหน้า /app/* (พื้นที่สมาชิก)',
    '- ห้ามแก้ปัญหา MT5/บัญชีเฉพาะราย — ให้แนะนำ login ก่อน',
    '- ถ้าถามเรื่องพื้นที่สมาชิก ตอบสั้นๆ ว่าต้อง login ที่ ' + fullUrl('/login')
  ].join('\n');
}

function buildIdentityKnowledgePrompt({ guest = false } = {}) {
  const identityUrl = `${BASE_URL}/app/identity`;
  const lines = [
    '=== ยืนยันตัวตน (KYC) ===',
    `หน้ายืนยันตัวตน: ${identityUrl}`,
    'จำเป็นสำหรับ: ' + IDENTITY_VERIFICATION_GUIDE.requiredFor.join('; '),
    '',
    '=== ประเภทเอกสาร ===',
    `- บัตรประชาชน: ${IDENTITY_VERIFICATION_GUIDE.documentTypes.thai_id}`,
    `- พาสปอร์ต: ${IDENTITY_VERIFICATION_GUIDE.documentTypes.passport}`,
    '',
    '=== ขั้นตอนยืนยันตัวตน ===',
    ...IDENTITY_VERIFICATION_GUIDE.steps,
    '',
    '=== เคล็ดลับ ===',
    ...IDENTITY_VERIFICATION_GUIDE.tips.map((t) => `- ${t}`),
    '',
    '=== แก้ปัญหายืนยันตัวตน ===',
    ...IDENTITY_VERIFICATION_GUIDE.troubleshooting.map(
      (t) => `ปัญหา: ${t.issue}\nแนวทาง: ${t.fixes.join('; ')}`
    )
  ];

  if (guest) {
    lines.push(
      '',
      '=== สำหรับผู้เยี่ยมชม ===',
      `- หลังสมัครและ login แล้ว ต้องยืนยันตัวตนที่ ${identityUrl} ก่อนใช้บอท/Scoin`,
      '- อธิบายขั้นตอนภาพรวมได้ — รายละเอียดการกรอกฟอร์มอยู่ในพื้นที่สมาชิกหลัง login'
    );
  } else {
    lines.push(
      '',
      '=== เมื่อลูกค้าถามเรื่องยืนยันตัวตน ===',
      '- อธิบายขั้นตอนครบตามด้านบน เน้นปุ่ม "ตรวจสอบ" (ไม่ใช่สแกน)',
      '- ถ้า OTP หมดอายุ → perform_user_fix action=resend_identity_otp',
      '- ใช้ get_account_diagnostics ตรวจสถานะ identityVerified ก่อนบอกว่ายังไม่ยืนยัน'
    );
  }

  return lines.join('\n');
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
    `QR LINE: ${LINE_GUIDE.qrImageUrl}`,
    '',
    buildCompanyKnowledgePrompt(),
    '',
    buildIdentityKnowledgePrompt(),
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
  COMPANY_INFO,
  getCompanyInfo,
  buildCompanyKnowledgePrompt,
  fullUrl,
  getPageGuide,
  getPageGuideByPath,
  isGuestAllowedPageKey,
  isGuestAllowedPath,
  buildGuestKnowledgePrompt,
  buildKnowledgePrompt,
  buildIdentityKnowledgePrompt,
  IDENTITY_VERIFICATION_GUIDE
};
