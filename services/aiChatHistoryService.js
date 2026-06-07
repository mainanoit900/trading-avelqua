'use strict';

const { query } = require('../config/database');
const { purgeAllChatImages } = require('./aiChatImageService');

const TZ = 'Asia/Bangkok';
let lastNoonPurgeKey = '';

function getBangkokParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

function isAfterNoonBangkok(date = new Date()) {
  return Number(getBangkokParts(date).hour || 0) >= 12;
}

function getLoggedInUserId(req) {
  return req.user?.id || req.session?.user?.id || null;
}

function buildSessionKey(req) {
  const userId = getLoggedInUserId(req);
  if (userId) return `user:${userId}`;
  const baseSession = req.sessionID || 'no-session';
  return `guest:${baseSession}`;
}

function shouldSaveChatHistory(req) {
  return !!getLoggedInUserId(req);
}

async function ensureChatSession(sessionKey, req) {
  const userId = getLoggedInUserId(req);
  const contextType = userId ? 'user' : 'public';

  await query(
    `INSERT INTO ai_chat_sessions (session_key, user_id, context_type, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (session_key)
     DO UPDATE SET updated_at = NOW(), context_type = EXCLUDED.context_type, user_id = EXCLUDED.user_id`,
    [sessionKey, userId, contextType]
  ).catch(() => {});
}

async function getChatHistory(sessionKey, limit = 20) {
  const result = await query(
    `SELECT role, content, created_at
     FROM ai_chat_messages
     WHERE session_key = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionKey, limit]
  ).catch(() => ({ rows: [] }));

  return result.rows.reverse().map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: row.created_at
  }));
}

async function saveChatMessage(sessionKey, role, content) {
  await query(
    `INSERT INTO ai_chat_messages (session_key, role, content, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [sessionKey, role, content]
  ).catch(() => {});
}

async function purgeLoggedInChatHistory() {
  await query(
    `DELETE FROM ai_chat_messages
     WHERE session_key LIKE 'user:%'`
  ).catch(() => {});

  await query(
    `DELETE FROM ai_chat_sessions
     WHERE session_key LIKE 'user:%'`
  ).catch(() => {});

  await purgeAllChatImages().catch(() => {});
}

async function ensureNoonPurgeIfNeeded() {
  if (!isAfterNoonBangkok()) return false;

  const { year, month, day } = getBangkokParts();
  const key = `${year}-${month}-${day}`;
  if (lastNoonPurgeKey === key) return false;

  await purgeLoggedInChatHistory();
  lastNoonPurgeKey = key;
  return true;
}

function startAiChatHistoryScheduler() {
  ensureNoonPurgeIfNeeded().catch((e) => {
    console.error('[ai-chat-history] noon purge error:', e.message);
  });

  setInterval(() => {
    ensureNoonPurgeIfNeeded().catch((e) => {
      console.error('[ai-chat-history] noon purge error:', e.message);
    });
  }, 60 * 1000);
}

module.exports = {
  buildSessionKey,
  shouldSaveChatHistory,
  ensureChatSession,
  getChatHistory,
  saveChatMessage,
  ensureNoonPurgeIfNeeded,
  purgeLoggedInChatHistory,
  isAfterNoonBangkok,
  startAiChatHistoryScheduler
};
