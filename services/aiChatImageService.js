'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { query } = require('../config/database');

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'ai-chat');
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function ensureAiChatImageTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS ai_chat_uploads (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_key TEXT NOT NULL DEFAULT '',
      stored_name TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
      file_size BIGINT NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await query(`
    CREATE INDEX IF NOT EXISTS idx_ai_chat_uploads_expires_at
    ON ai_chat_uploads(expires_at)
  `).catch(() => {});
}

function extForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

async function saveChatImage({ userId, sessionKey, file }) {
  if (!userId) {
    return { ok: false, message: 'ต้องเข้าสู่ระบบก่อนจึงจะแนบรูปได้' };
  }
  if (!file?.buffer && !file?.path) {
    return { ok: false, message: 'ไม่พบไฟล์รูป' };
  }

  const mime = String(file.mimetype || '').toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, message: 'รองรับเฉพาะ JPG PNG WEBP GIF' };
  }

  const size = Number(file.size || 0);
  if (size <= 0 || size > MAX_BYTES) {
    return { ok: false, message: 'ขนาดรูปต้องไม่เกิน 5 MB' };
  }

  ensureUploadDir();
  await purgeExpiredChatImages().catch(() => {});

  const storedName = `${Date.now()}-${randomUUID()}${extForMime(mime)}`;
  const absPath = path.join(UPLOAD_DIR, storedName);
  const buffer = file.buffer || fs.readFileSync(file.path);

  fs.writeFileSync(absPath, buffer);

  const expiresAt = new Date(Date.now() + TTL_MS);
  const inserted = await query(
    `INSERT INTO ai_chat_uploads (user_id, session_key, stored_name, original_name, mime_type, file_size, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, expires_at, created_at`,
    [userId, String(sessionKey || ''), storedName, String(file.originalname || 'image'), mime, size, expiresAt]
  );

  const row = inserted.rows[0];
  return {
    ok: true,
    id: row.id,
    url: `/api/ai-chat/image/${row.id}`,
    expiresAt: row.expires_at,
    ttlHours: 24,
    note: 'รูปแนบจะถูกลบหลัง 12:00 น. พร้อมประวัติแชท'
  };
}

async function getChatImageRow(id, userId) {
  const result = await query(
    `SELECT id, user_id, stored_name, mime_type, expires_at
     FROM ai_chat_uploads
     WHERE id = $1
       AND user_id = $2
       AND expires_at > NOW()
     LIMIT 1`,
    [Number(id), Number(userId)]
  );
  return result.rows[0] || null;
}

async function getImageDataUrlsForUser(imageIds, userId) {
  const ids = (Array.isArray(imageIds) ? imageIds : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(0, 3);

  if (!ids.length || !userId) return [];

  const result = await query(
    `SELECT id, stored_name, mime_type
     FROM ai_chat_uploads
     WHERE id = ANY($1::bigint[])
       AND user_id = $2
       AND expires_at > NOW()`,
    [ids, Number(userId)]
  );

  const urls = [];
  for (const row of result.rows || []) {
    const absPath = path.join(UPLOAD_DIR, row.stored_name);
    if (!fs.existsSync(absPath)) continue;
    const b64 = fs.readFileSync(absPath).toString('base64');
    urls.push(`data:${row.mime_type};base64,${b64}`);
  }
  return urls;
}

async function purgeAllChatImages() {
  const all = await query(
    `SELECT id, stored_name FROM ai_chat_uploads LIMIT 2000`
  ).catch(() => ({ rows: [] }));

  for (const row of all.rows || []) {
    const absPath = path.join(UPLOAD_DIR, String(row.stored_name || ''));
    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch (_) {}
  }

  await query(`DELETE FROM ai_chat_uploads`).catch(() => {});
  return (all.rows || []).length;
}

async function purgeExpiredChatImages() {
  const expired = await query(
    `SELECT id, stored_name
     FROM ai_chat_uploads
     WHERE expires_at <= NOW()
     LIMIT 500`
  ).catch(() => ({ rows: [] }));

  let deleted = 0;
  for (const row of expired.rows || []) {
    const absPath = path.join(UPLOAD_DIR, String(row.stored_name || ''));
    try {
      if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch (_) {}
    deleted += 1;
  }

  if (deleted) {
    await query(`DELETE FROM ai_chat_uploads WHERE expires_at <= NOW()`).catch(() => {});
  }

  return deleted;
}

function startAiChatImageCleanupScheduler() {
  purgeExpiredChatImages().catch(() => {});
  setInterval(() => {
    purgeExpiredChatImages().catch((e) => console.error('[ai-chat-image] purge error:', e.message));
  }, 60 * 60 * 1000);
}

module.exports = {
  UPLOAD_DIR,
  MAX_BYTES,
  ensureAiChatImageTable,
  saveChatImage,
  getChatImageRow,
  getImageDataUrlsForUser,
  purgeExpiredChatImages,
  purgeAllChatImages,
  startAiChatImageCleanupScheduler
};
