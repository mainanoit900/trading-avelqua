const { query } = require('../config/database');

function clamp(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function generateIntelReport({ symbol = 'XAUUSD', technical = '', news = '' }) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  let report = {
    symbol,
    direction: 'WAIT',
    buy_percent: 50,
    sell_percent: 50,
    technical_summary: technical || 'ยังไม่มีข้อมูลเทคนิคัลจาก API ภายนอก',
    news_summary: news || 'ยังไม่มีข้อมูลข่าวจาก API ภายนอก',
    risk_summary: 'ใช้เป็นข้อมูลประกอบการตัดสินใจเท่านั้น ไม่ใช่คำแนะนำการลงทุน'
  };

  if (apiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENAI_INTEL_MODEL || 'gpt-4.1-mini',
          input: `วิเคราะห์ ${symbol} จากข้อมูลนี้ แล้วตอบ JSON เท่านั้น: {direction,buy_percent,sell_percent,technical_summary,news_summary,risk_summary}\nTECHNICAL:${technical}\nNEWS:${news}`
        })
      });
      const data = await response.json();
      const text = data.output_text || data.output?.[0]?.content?.[0]?.text || '';
      const parsed = JSON.parse(text);
      report = {
        ...report,
        ...parsed,
        buy_percent: clamp(parsed.buy_percent),
        sell_percent: clamp(parsed.sell_percent)
      };
    } catch (error) {
      report.risk_summary = `AI fallback: ${error.message}`;
    }
  }

  const saved = await query(`
    INSERT INTO vps_system.intel_reports
    (symbol, direction, buy_percent, sell_percent, technical_summary, news_summary, risk_summary, raw_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
  `, [
    report.symbol,
    report.direction || 'WAIT',
    clamp(report.buy_percent),
    clamp(report.sell_percent),
    report.technical_summary || '',
    report.news_summary || '',
    report.risk_summary || '',
    report
  ]);

  return saved.rows[0];
}

module.exports = { generateIntelReport };
