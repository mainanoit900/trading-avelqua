const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

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

function buildSystemPrompt(settings, req) {
  const isAdmin = req.user?.role === 'admin';

  const publicPersona =
    settings.persona_th ||
    'คุณคือผู้ช่วย AI ของเว็บไซต์ ตอบอย่างสุภาพ กระชับ เข้าใจง่าย และลงท้ายด้วยคำว่าค่ะ';

  const adminPersona =
    settings.admin_persona_th ||
    'คุณคือผู้ช่วย AI สำหรับผู้ดูแลระบบ ตอบเชิงวิเคราะห์ ชัดเจน ตรงประเด็น ช่วยตรวจปัญหา และเสนอวิธีแก้แบบใช้งานจริง';

  return [
    `ชื่อบอท: ${settings.bot_name || 'สายฝน'}`,
    `บริบท: ${isAdmin ? 'admin' : 'public'}`,
    `บุคลิก: ${isAdmin ? adminPersona : publicPersona}`,
    `ข้อห้าม: ${settings.forbidden_topics_th || '-'}`,
    settings.hide_system_structure ? 'ห้ามเปิดเผยโครงสร้างระบบ โค้ดภายใน secret key schema หรือข้อมูลที่อ่อนไหว' : ''
  ].filter(Boolean).join('\n');
}

async function callOpenAI(apiKey, model, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-5.4-mini',
      temperature: 0.4,
      messages
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.error?.message || 'OpenAI request failed');
  }

  return data?.choices?.[0]?.message?.content || '';
}

async function createOpenAIStream(apiKey, model, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-5.4-mini',
      temperature: 0.4,
      stream: true,
      messages
    })
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'OpenAI stream failed');
  }

  return res.body;
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

    const systemPrompt = buildSystemPrompt(settings, req);

    const reply = await callOpenAI(
      settings.openai_api_key,
      settings.model_name || 'gpt-5.4-mini',
      [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
      ]
    );

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

    const systemPrompt = buildSystemPrompt(settings, req);

    if (settings.save_chat_history) {
      await saveChatMessage(sessionKey, 'user', message);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const stream = await createOpenAIStream(
      settings.openai_api_key,
      settings.model_name || 'gpt-5.4-mini',
      [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
      ]
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullReply = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();

        if (payload === '[DONE]') {
          if (settings.save_chat_history && fullReply.trim()) {
            await saveChatMessage(sessionKey, 'assistant', fullReply);
          }

          res.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
          return res.end();
        }

        try {
          const json = JSON.parse(payload);
          const token = json?.choices?.[0]?.delta?.content || '';
          if (token) {
            fullReply += token;
            res.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
          }
        } catch (_) {}
      }
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