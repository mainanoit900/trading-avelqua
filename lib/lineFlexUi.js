'use strict';

const { fmtMoney, num, getYesterdayEquity } = require('./linePnlReport');
const { fetchActivePorts } = require('./linePortfolio');

const C_GREEN = '#1DB446';
const C_RED = '#E03131';
const C_NAVY = '#1a2744';
const C_MUTED = '#888888';
const C_CARD = '#f4f6f9';
const C_GOLD = '#F5A623';

function pnlColor(v) {
  return num(v) >= 0 ? C_GREEN : C_RED;
}

function flexHeader(title, subtitle, { bg = C_NAVY } = {}) {
  const contents = [
    { type: 'text', text: title, color: '#ffffff', weight: 'bold', size: 'lg', wrap: true }
  ];
  if (subtitle) {
    contents.push({ type: 'text', text: subtitle, color: '#b0bdd0', size: 'xs', margin: 'sm', wrap: true });
  }
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bg,
    paddingAll: '18px',
    contents
  };
}

function stepCard(num, title, lines) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: C_CARD,
    cornerRadius: '10px',
    paddingAll: '14px',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '28px',
            height: '28px',
            backgroundColor: C_NAVY,
            cornerRadius: '14px',
            justifyContent: 'center',
            alignItems: 'center',
            contents: [{ type: 'text', text: String(num), color: '#ffffff', size: 'sm', weight: 'bold', align: 'center' }]
          },
          {
            type: 'text',
            text: title,
            weight: 'bold',
            size: 'sm',
            color: C_NAVY,
            margin: 'md',
            flex: 1,
            wrap: true
          }
        ]
      },
      ...lines.map((line) => ({
        type: 'text',
        text: line,
        size: 'xs',
        color: '#555555',
        wrap: true,
        margin: 'sm'
      }))
    ]
  };
}

function infoRow(label, value, { color = '#333333', bold = false } = {}) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: C_MUTED, flex: 2 },
      {
        type: 'text',
        text: value,
        size: 'sm',
        color,
        align: 'end',
        weight: bold ? 'bold' : 'regular',
        flex: 3,
        wrap: true
      }
    ]
  };
}

function makeBubble({ headerTitle, headerSub, bodyContents, footerContents, headerBg }) {
  const bubble = {
    type: 'bubble',
    size: 'mega',
    header: flexHeader(headerTitle, headerSub, { bg: headerBg || C_NAVY }),
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: bodyContents
    }
  };
  if (footerContents?.length) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      contents: footerContents
    };
  }
  return bubble;
}

function buildManualFlex() {
  const contents = makeBubble({
    headerTitle: '📌 วิธีใช้งาน Avelqua Trading',
    headerSub: 'คู่มือเริ่มต้นใช้งาน LINE Notify',
    bodyContents: [
      stepCard(1, 'สมัครสมาชิกและยืนยันตัวตน', [
        '→ สมัครที่ trading.avelqua.com',
        '→ ยืนยัน Email ที่ใช้สมัคร'
      ]),
      stepCard(2, 'เปิดรับการแจ้งเตือนผลเทรด', [
        '→ กดปุ่ม "แจ้งสรุปผล" ในเมนู',
        '→ แจ้ง Email ที่ลงทะเบียนไว้',
        '→ ระบบจะผูกบัญชีกับ LINE ของคุณ',
        '✅ รับสรุปอัตโนมัติ 07:00 น. (จ–ศ)',
        '   ครอบคลุมทุก Port ที่เปิดใช้งาน'
      ]),
      stepCard(3, 'เช็คพอร์ตและกำไร/ขาดทุน', [
        '→ กดปุ่ม "เช็คพอร์ต" ในเมนู',
        '→ ดูทุก Port พร้อม P&L ณ ขณะนั้น',
        '→ ตรวจสถานะ MT5 และบอทแต่ละ Port'
      ])
    ],
    footerContents: [
      { type: 'separator' },
      {
        type: 'text',
        text: '💬 พิมพ์ "ช่วยเหลือ" เพื่อดูเมนูนี้อีกครั้ง',
        size: 'xs',
        color: C_MUTED,
        align: 'center',
        margin: 'md',
        wrap: true
      }
    ]
  });
  return { altText: 'วิธีใช้งาน Avelqua Trading', contents };
}

function buildEmailAskFlex(variant = 'report') {
  const isRegister = variant === 'register';
  const contents = makeBubble({
    headerTitle: isRegister ? '📝 ลงทะเบียน' : '📊 แจ้งสรุปผล',
    headerSub: isRegister ? 'ผูก LINE กับบัญชี Avelqua' : 'เปิดรับสรุปผลเทรดรายวัน',
    headerBg: isRegister ? '#2d5a3d' : '#1e4d7b',
    bodyContents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: C_CARD,
        cornerRadius: '10px',
        paddingAll: '16px',
        margin: 'md',
        contents: [
          {
            type: 'text',
            text: 'กรุณาระบุ Email ที่ลงทะเบียนไว้',
            weight: 'bold',
            size: 'sm',
            color: C_NAVY,
            wrap: true
          },
          {
            type: 'text',
            text: 'ใช้ Email เดียวกับที่สมัครเว็บ trading.avelqua.com',
            size: 'xs',
            color: C_MUTED,
            wrap: true,
            margin: 'md'
          },
          { type: 'separator', margin: 'lg' },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#ffffff',
            cornerRadius: '8px',
            paddingAll: '12px',
            contents: [
              { type: 'text', text: 'ตัวอย่าง', size: 'xxs', color: C_MUTED },
              { type: 'text', text: 'yourname@gmail.com', size: 'md', color: C_NAVY, weight: 'bold', margin: 'xs' }
            ]
          }
        ]
      },
      {
        type: 'text',
        text: isRegister
          ? 'พิมพ์ Email ของคุณในแชทนี้ได้เลย'
          : 'พิมพ์ Email แล้วระบบจะส่งสรุปทุกวัน 07:00 น.',
        size: 'xs',
        color: C_MUTED,
        align: 'center',
        wrap: true,
        margin: 'md'
      }
    ]
  });
  return {
    altText: isRegister ? 'ลงทะเบียน — กรุณาระบุ Email' : 'แจ้งสรุปผล — กรุณาระบุ Email',
    contents
  };
}

function buildRegisterSuccessFlex(email) {
  const contents = makeBubble({
    headerTitle: '✅ ลงทะเบียนสำเร็จ',
    headerSub: 'เชื่อมต่อ LINE กับ Avelqua แล้ว',
    headerBg: '#2d5a3d',
    bodyContents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: C_CARD,
        cornerRadius: '10px',
        paddingAll: '16px',
        margin: 'md',
        contents: [
          infoRow('Email', email, { bold: true, color: C_NAVY }),
          { type: 'separator', margin: 'lg' },
          {
            type: 'text',
            text: '🌅 สรุปกำไร/ขาดทุนอัตโนมัติ',
            weight: 'bold',
            size: 'sm',
            color: C_NAVY
          },
          {
            type: 'text',
            text: 'ทุกวัน 07:00 น. (จันทร์–ศุกร์)\nครอบคลุมทุก Port ที่เปิดใช้งาน',
            size: 'xs',
            color: '#555555',
            wrap: true,
            margin: 'sm'
          }
        ]
      }
    ],
    footerContents: [
      { type: 'separator' },
      {
        type: 'text',
        text: 'กด "เช็คพอร์ต" เพื่อดูผลล่าสุดได้ทันที',
        size: 'xs',
        color: C_MUTED,
        align: 'center',
        margin: 'md',
        wrap: true
      }
    ]
  });
  return { altText: `ลงทะเบียนสำเร็จ ${email}`, contents };
}

function buildAlreadyRegisteredFlex(email) {
  const contents = makeBubble({
    headerTitle: '✅ ลงทะเบียนแล้ว',
    headerSub: 'บัญชี LINE เชื่อมต่ออยู่',
    headerBg: '#2d5a3d',
    bodyContents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: C_CARD,
        cornerRadius: '10px',
        paddingAll: '16px',
        margin: 'md',
        contents: [
          infoRow('Email', email || '-', { bold: true, color: C_NAVY }),
          {
            type: 'text',
            text: 'กด "เช็คพอร์ต" เพื่อดูผลล่าสุด\nกด "แจ้งสรุปผล" เพื่อดูตัวอย่างรายงาน',
            size: 'xs',
            color: '#555555',
            wrap: true,
            margin: 'lg'
          }
        ]
      }
    ]
  });
  return { altText: `ลงทะเบียนแล้ว ${email || ''}`, contents };
}

async function buildDailyReportFlex(userId) {
  const accounts = await fetchActivePorts(userId);
  if (!accounts.length) return null;

  const dateStr = new Date().toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let totalBalance = 0;
  let totalEquity = 0;
  let totalPnlDay = 0;
  const portRows = [];

  for (const a of accounts) {
    const bal = num(a.last_balance);
    const eq = num(a.last_equity);
    const yesterdayEq = await getYesterdayEquity(userId, a.id);
    const pnlDay = yesterdayEq != null ? eq - yesterdayEq : eq - bal;
    totalBalance += bal;
    totalEquity += eq;
    totalPnlDay += pnlDay;
    const port = a.assigned_port_no || a.port_slot || '-';
    portRows.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'sm',
      contents: [
        {
          type: 'text',
          text: `PORT ${port}`,
          size: 'xs',
          color: C_MUTED,
          flex: 2
        },
        {
          type: 'text',
          text: fmtMoney(pnlDay),
          size: 'sm',
          color: pnlColor(pnlDay),
          weight: 'bold',
          align: 'end',
          flex: 2
        }
      ]
    });
    portRows.push({
      type: 'text',
      text: `Login ${a.mt5_login || '-'}`,
      size: 'xxs',
      color: C_MUTED,
      margin: 'xs'
    });
  }

  const contents = makeBubble({
    headerTitle: '🌅 สรุปกำไร/ขาดทุน',
    headerSub: dateStr,
    headerBg: '#1e4d7b',
    bodyContents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: C_CARD,
        cornerRadius: '10px',
        paddingAll: '14px',
        margin: 'md',
        contents: portRows
      },
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#ffffff',
        cornerRadius: '10px',
        paddingAll: '14px',
        margin: 'md',
        contents: [
          infoRow('Balance รวม', fmtMoney(totalBalance).replace('+', '')),
          infoRow('Equity รวม', fmtMoney(totalEquity).replace('+', '')),
          infoRow('P&L วันนี้', fmtMoney(totalPnlDay), {
            bold: true,
            color: pnlColor(totalPnlDay)
          })
        ]
      }
    ],
    footerContents: [
      { type: 'separator' },
      {
        type: 'text',
        text: 'กด "เช็คพอร์ต" เพื่อดูรายละเอียด',
        size: 'xs',
        color: C_MUTED,
        align: 'center',
        margin: 'md'
      }
    ]
  });

  return {
    altText: `สรุป P&L วันนี้ ${fmtMoney(totalPnlDay)}`,
    contents
  };
}

async function buildReportActiveFlex(email, userId) {
  const daily = await buildDailyReportFlex(userId);
  const bodyContents = [
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#e8f5e9',
      cornerRadius: '10px',
      paddingAll: '14px',
      margin: 'md',
      contents: [
        {
          type: 'text',
          text: '✅ เปิดรับแจ้งสรุปผลแล้ว',
          weight: 'bold',
          size: 'sm',
          color: '#2d5a3d'
        },
        infoRow('Email', email || '-', { color: C_NAVY }),
        {
          type: 'text',
          text: '🌅 ส่งอัตโนมัติ 07:00 น. (จ–ศ)',
          size: 'xs',
          color: '#555555',
          margin: 'md',
          wrap: true
        }
      ]
    }
  ];

  if (daily) {
    bodyContents.push({
      type: 'text',
      text: '📋 ตัวอย่างสรุปล่าสุด',
      weight: 'bold',
      size: 'sm',
      color: C_NAVY,
      margin: 'lg'
    });
    bodyContents.push(...daily.contents.body.contents);
    if (daily.contents.footer) {
      bodyContents.push({ type: 'separator', margin: 'lg' });
      bodyContents.push(...daily.contents.footer.contents);
    }
  }

  const contents = makeBubble({
    headerTitle: '📊 แจ้งสรุปผล',
    headerSub: 'สถานะการแจ้งเตือน',
    headerBg: '#1e4d7b',
    bodyContents
  });

  return {
    altText: daily ? daily.altText : 'เปิดรับแจ้งสรุปผลแล้ว',
    contents
  };
}

function buildErrorFlex(title, message) {
  const contents = makeBubble({
    headerTitle: title,
    headerSub: '',
    headerBg: '#8b3a3a',
    bodyContents: [
      {
        type: 'text',
        text: message,
        size: 'sm',
        color: '#555555',
        wrap: true,
        margin: 'md'
      }
    ]
  });
  return { altText: title, contents };
}

function buildSimpleNoticeFlex(title, subtitle, message, { headerBg = C_NAVY } = {}) {
  const contents = makeBubble({
    headerTitle: title,
    headerSub: subtitle,
    headerBg,
    bodyContents: [
      {
        type: 'text',
        text: message,
        size: 'sm',
        color: '#555555',
        wrap: true,
        margin: 'md'
      }
    ]
  });
  return { altText: title, contents };
}

module.exports = {
  buildManualFlex,
  buildEmailAskFlex,
  buildRegisterSuccessFlex,
  buildAlreadyRegisteredFlex,
  buildDailyReportFlex,
  buildReportActiveFlex,
  buildErrorFlex,
  buildSimpleNoticeFlex
};

// re-export for linePnlReport getYesterdayEquity - already imported above
