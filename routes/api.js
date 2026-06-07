const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { runAiChat, buildSystemPrompt: buildEnhancedSystemPrompt } = require('../services/aiChatEngine');

function getContextType(req) {
  if (req.user?.role === 'admin') return 'admin';
  if (req.user) return 'user';
  return 'public';
}

function buildSessionKey(req) {
  const contextType = getContextType(req);
  const userId = req.user?.id || req.session?.user?.id || 'guest';
  const baseSession = req.sessionID || 'no-session';
  return `${contextType}:${userId}:${baseSession}`;
}

async function ensureChatSession(sessionKey, req) {
  const contextType = getContextType(req);
  const userId = req.user?.id || req.session?.user?.id || null;

  await query(
    `INSERT INTO ai_chat_sessions (session_key, user_id, context_type, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (session_key)
     DO UPDATE SET updated_at = NOW(), context_type = EXCLUDED.context_type`,
    [sessionKey, userId, contextType]
  ).catch(() => {});
}

async function getChatHistory(sessionKey, limit = 10) {
  const result = await query(
    `SELECT role, content
     FROM ai_chat_messages
     WHERE session_key = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionKey, limit]
  ).catch(() => ({ rows: [] }));

  return result.rows.reverse().map((row) => ({
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content
  }));
}

async function saveChatMessage(sessionKey, role, content) {
  await query(
    `INSERT INTO ai_chat_messages (session_key, role, content, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [sessionKey, role, content]
  ).catch(() => {});
}

function buildSystemPrompt(settings, req, body = {}) {
  return buildEnhancedSystemPrompt(settings, req, body);
}

router.post('/ai-chat', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ ok: false, reply: 'กรุณาพิมพ์ข้อความก่อน' });
    }

    const result = await query(`SELECT * FROM ai_settings ORDER BY id ASC LIMIT 1`);
    const settings = result.rows[0] || {};

    if (!settings.is_enabled) {
      return res.json({ ok: true, reply: 'ระบบ AI Chat ยังไม่ได้เปิดใช้งานค่ะ' });
    }

    if (!settings.openai_api_key) {
      return res.json({ ok: true, reply: 'ยังไม่ได้ตั้งค่า OPENAI_API_KEY ค่ะ' });
    }

    const sessionKey = buildSessionKey(req);

    if (settings.save_chat_history) {
      await ensureChatSession(sessionKey, req);
    }

    const history = settings.save_chat_history
      ? await getChatHistory(sessionKey, 10)
      : [];

    const reply = await runAiChat({
      settings,
      req,
      message,
      history,
      body: req.body || {}
    });

    if (settings.save_chat_history) {
      await saveChatMessage(sessionKey, 'user', message);
      await saveChatMessage(sessionKey, 'assistant', reply);
    }

    return res.json({ ok: true, reply });
  } catch (error) {
    console.error('AI CHAT API ERROR:', error);
    return res.status(500).json({
      ok: false,
      reply: 'ขออภัยค่ะ ระบบ AI ไม่พร้อมใช้งานในขณะนี้'
    });
  }
});

router.post('/ai-chat/stream', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ ok: false, error: 'กรุณาพิมพ์ข้อความก่อน' });
    }

    const result = await query(`SELECT * FROM ai_settings ORDER BY id ASC LIMIT 1`);
    const settings = result.rows[0] || {};

    if (!settings.is_enabled) {
      return res.status(200).json({ ok: false, error: 'ระบบ AI Chat ยังไม่ได้เปิดใช้งานค่ะ' });
    }

    if (!settings.openai_api_key) {
      return res.status(200).json({ ok: false, error: 'ยังไม่ได้ตั้งค่า OPENAI_API_KEY ค่ะ' });
    }

    const sessionKey = buildSessionKey(req);

    if (settings.save_chat_history) {
      await ensureChatSession(sessionKey, req);
    }

    const history = settings.save_chat_history
      ? await getChatHistory(sessionKey, 10)
      : [];

    if (settings.save_chat_history) {
      await saveChatMessage(sessionKey, 'user', message);
    }

    const fullReply = await runAiChat({
      settings,
      req,
      message,
      history,
      body: req.body || {}
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const chunkSize = 24;
    for (let i = 0; i < fullReply.length; i += chunkSize) {
      const token = fullReply.slice(i, i + chunkSize);
      res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
    }

    if (settings.save_chat_history && fullReply.trim()) {
      await saveChatMessage(sessionKey, 'assistant', fullReply);
    }

    res.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    return res.end();
  } catch (error) {
    console.error('AI CHAT STREAM ERROR:', error);
    return res.status(500).json({
      ok: false,
      error: 'ขออภัยค่ะ ระบบ AI ไม่พร้อมใช้งานในขณะนี้'
    });
  }
});

module.exports = router;