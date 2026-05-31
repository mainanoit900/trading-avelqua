'use strict';

const { query } = require('../config/database');
const { fmtMoney, num } = require('./linePnlReport');

const ACTIVE_BOT_SQL = `'running','pending','restarting','connecting','starting'`;
const C_GREEN = '#1DB446';
const C_RED = '#E03131';
const C_NAVY = '#1a2744';
const C_MUTED = '#888888';
const C_CARD = '#f4f6f9';

async function fetchActivePorts(userId) {
  const r = await query(
    `
    SELECT id, mt5_login, account_name, last_balance, last_equity,
           status, server_name, port_slot, assigned_port_no
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
      AND (port_slot IS NOT NULL OR assigned_port_no IS NOT NULL OR NULLIF(TRIM(COALESCE(mt5_login, '')), '') IS NOT NULL)
    ORDER BY port_slot ASC NULLS LAST, assigned_port_no ASC NULLS LAST, id ASC
  `,
    [userId]
  ).catch(() => ({ rows: [] }));
  return r.rows || [];
}

async function fetchBotsByAccount(userId) {
  const r = await query(
    `
    SELECT DISTINCT ON (bi.mt5_account_id)
           bi.mt5_account_id,
           bi.status,
           COALESCE(bc.display_name, bc.bot_name, bc.bot_code, bi.run_payload->>'botCode', 'BOT') AS bot_name
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
    WHERE bi.user_id = $1
      AND bi.stopped_at IS NULL
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN (${ACTIVE_BOT_SQL})
    ORDER BY bi.mt5_account_id, bi.started_at DESC NULLS LAST, bi.id DESC
  `,
    [userId]
  ).catch(() => ({ rows: [] }));
  const map = new Map();
  for (const row of r.rows || []) {
    map.set(Number(row.mt5_account_id), row);
  }
  return map;
}

function formatNowTh() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function pnlColor(v) {
  return num(v) >= 0 ? C_GREEN : C_RED;
}

function mt5StatusParts(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'running' || st === 'connected') return { label: 'MT5 เปิดอยู่', color: C_GREEN };
  if (st === 'connecting' || st === 'starting') return { label: 'MT5 กำลังเชื่อมต่อ', color: '#F5A623' };
  return { label: `MT5 ${status || 'พร้อม'}`, color: C_MUTED };
}

function botStatusParts(bot) {
  if (!bot) return { label: 'บอทหยุด', color: C_MUTED };
  const st = String(bot.status || '').toLowerCase();
  if (st === 'running') return { label: `${bot.bot_name} · ใช้งานอยู่`, color: C_GREEN };
  return { label: `${bot.bot_name} · ${bot.status}`, color: '#F5A623' };
}

function rowLabelValue(label, value, { valueColor = '#333333', bold = false } = {}) {
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
        color: valueColor,
        align: 'end',
        weight: bold ? 'bold' : 'regular',
        flex: 3
      }
    ]
  };
}

function buildPortCard(a, bot) {
  const bal = num(a.last_balance);
  const eq = num(a.last_equity);
  const pnl = eq - bal;
  const port = a.assigned_port_no || a.port_slot || '-';
  const mt5 = mt5StatusParts(a.status);
  const botSt = botStatusParts(bot);

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
            type: 'text',
            text: `PORT ${port}`,
            weight: 'bold',
            size: 'md',
            color: C_NAVY,
            flex: 0
          },
          {
            type: 'text',
            text: `Login ${a.mt5_login || '-'}`,
            size: 'sm',
            color: C_MUTED,
            align: 'end',
            flex: 1
          }
        ]
      },
      { type: 'separator', margin: 'md' },
      rowLabelValue('P&L', fmtMoney(pnl), { valueColor: pnlColor(pnl), bold: true }),
      rowLabelValue('Equity', fmtMoney(eq).replace('+', '')),
      rowLabelValue('Balance', fmtMoney(bal).replace('+', '')),
      { type: 'separator', margin: 'md' },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#ffffff',
            cornerRadius: '6px',
            paddingAll: '8px',
            flex: 1,
            contents: [
              { type: 'text', text: '● MT5', size: 'xxs', color: mt5.color, weight: 'bold' },
              { type: 'text', text: mt5.label, size: 'xxs', color: '#555555', wrap: true, margin: 'xs' }
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#ffffff',
            cornerRadius: '6px',
            paddingAll: '8px',
            flex: 1,
            contents: [
              { type: 'text', text: '● BOT', size: 'xxs', color: botSt.color, weight: 'bold' },
              { type: 'text', text: botSt.label, size: 'xxs', color: '#555555', wrap: true, margin: 'xs' }
            ]
          }
        ]
      }
    ]
  };
}

async function buildPortfolioFlex(userId) {
  const accounts = await fetchActivePorts(userId);
  if (!accounts.length) return null;

  const bots = await fetchBotsByAccount(userId);
  const nowStr = formatNowTh();

  let totalPnl = 0;
  const portCards = accounts.map((a) => {
    const pnl = num(a.last_equity) - num(a.last_balance);
    totalPnl += pnl;
    return buildPortCard(a, bots.get(Number(a.id)));
  });

  const contents = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: C_NAVY,
      paddingAll: '18px',
      contents: [
        { type: 'text', text: '💼 เช็คพอร์ต', color: '#ffffff', weight: 'bold', size: 'lg' },
        { type: 'text', text: nowStr, color: '#b0bdd0', size: 'xs', margin: 'sm' }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: portCards
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      contents: [
        { type: 'separator' },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          contents: [
            { type: 'text', text: 'รวม P&L', weight: 'bold', size: 'md', color: C_NAVY, flex: 1 },
            {
              type: 'text',
              text: fmtMoney(totalPnl),
              weight: 'bold',
              size: 'md',
              color: pnlColor(totalPnl),
              align: 'end',
              flex: 1
            }
          ]
        },
        {
          type: 'text',
          text: `${accounts.length} พอร์ตที่เปิดใช้งาน`,
          size: 'xxs',
          color: C_MUTED,
          align: 'center',
          margin: 'sm'
        }
      ]
    }
  };

  return {
    altText: `เช็คพอร์ต รวม P&L ${fmtMoney(totalPnl)} (${accounts.length} port)`,
    contents
  };
}

/** fallback text สำหรับ push ธรรมดา */
async function buildPortfolioReport(userId) {
  const flex = await buildPortfolioFlex(userId);
  if (!flex) {
    return '❌ ยังไม่มีพอร์ตที่เปิดใช้งาน\nกรุณา Login MT5 ที่เว็บ Avelqua ก่อน';
  }
  return flex.altText;
}

module.exports = {
  fetchActivePorts,
  buildPortfolioReport,
  buildPortfolioFlex
};
