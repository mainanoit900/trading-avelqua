'use strict';

const { query } = require('../config/database');
const { purgeChatImagesBeforeTodayBangkok } = require('./aiChatImageService');

const TZ = 'Asia/Bangkok';
let lastDailyPurgeKey = '';

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

function getBangkokDayKey(date = new Date()) {
  const { year, month, day } = getBangkokParts(date);
  return `${year}-${month}-${day}`;
}

function getBangkokTodayStartIso() {
  const { year, month, day } = getBangkokParts();
  return `${year}-${month}-${day}T00:00:00+07:00`;
}

function getLoggedInUserId(req) {
  return req.user?.id || req.session?.user?.id || null;
}

function buildSessionKey(req) {
  const userId = getLoggedInUserId(req);
  if (userId) {
    const sid = req.sessionID || req.session?.id || 'no-session';
    return `user:${userId}:${sid}`;
  }
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

async function purgeChatHistoryBeforeTodayBangkok() {
  const dayStart = getBangkokTodayStartIso();

  await query(
    `DELETE FROM ai_chat_messages
     WHERE session_key LIKE 'user:%'
       AND created_at < $1::timestamptz`,
    [dayStart]
  ).catch(() => {});

  await query(
    `DELETE FROM ai_chat_sessions s
     WHERE s.session_key LIKE 'user:%'
       AND NOT EXISTS (
         SELECT 1 FROM ai_chat_messages m WHERE m.session_key = s.session_key
       )`
  ).catch(() => {});

  await purgeChatImagesBeforeTodayBangkok(dayStart).catch(() => {});
}

async function ensureDailyPurgeIfNeeded() {
  const todayKey = getBangkokDayKey();
  if (lastDailyPurgeKey === todayKey) return false;

  await purgeChatHistoryBeforeTodayBangkok();
  lastDailyPurgeKey = todayKey;
  return true;
}

function startAiChatHistoryScheduler() {
  ensureDailyPurgeIfNeeded().catch((e) => {
    console.error('[ai-chat-history] daily purge error:', e.message);
  });

  setInterval(() => {
    ensureDailyPurgeIfNeeded().catch((e) => {
      console.error('[ai-chat-history] daily purge error:', e.message);
    });
  }, 60 * 1000);
}

module.exports = {
  buildSessionKey,
  shouldSaveChatHistory,
  ensureChatSession,
  getChatHistory,
  saveChatMessage,
  ensureDailyPurgeIfNeeded,
  purgeChatHistoryBeforeTodayBangkok,
  startAiChatHistoryScheduler
};
