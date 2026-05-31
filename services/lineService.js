'use strict';

const axios = require('axios');

const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const BASE = 'https://api.line.me/v2/bot/message';

// PM2/sandbox อาจมี HTTP_PROXY ชี้ localhost — ต้อง bypass สำหรับ api.line.me
const lineHttp = axios.create({ proxy: false, timeout: 15000 });

function lineEnabled() {
  return !!String(CHANNEL_TOKEN || '').trim();
}

function authHeaders() {
  return { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' };
}

async function pushText(lineUserId, text) {
  if (!lineEnabled()) return null;
  return lineHttp.post(
    `${BASE}/push`,
    { to: lineUserId, messages: [{ type: 'text', text: String(text || '').slice(0, 5000) }] },
    { headers: authHeaders() }
  );
}

async function pushFlex(lineUserId, altText, contents) {
  if (!lineEnabled()) return null;
  return lineHttp.post(
    `${BASE}/push`,
    {
      to: lineUserId,
      messages: [{ type: 'flex', altText: String(altText || 'Avelqua MT5'), contents }]
    },
    { headers: authHeaders() }
  );
}

async function replyMessage(replyToken, messages) {
  if (!lineEnabled() || !replyToken) return null;
  const list = Array.isArray(messages) ? messages : [messages];
  return lineHttp.post(
    `${BASE}/reply`,
    { replyToken, messages: list },
    { headers: authHeaders() }
  );
}

module.exports = { pushText, pushFlex, replyMessage, lineEnabled };
