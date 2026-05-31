'use strict';

const crypto = require('crypto');
const express = require('express');
const { query } = require('../config/database');
const { findByEmail } = require('../repositories/usersRepo');
const { replyMessage, lineEnabled } = require('../services/lineService');
const { handleCommand } = require('../lib/lineCommandHandler');
const { ensureLineNotifyTables } = require('../lib/lineNotifySchema');

const router = express.Router();
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';

function verifySignature(body, signature) {
  if (!CHANNEL_SECRET || !signature) return false;
  const hash = crypto.createHmac('SHA256', CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

router.get('/webhook', (req, res) => {
  res.json({ ok: true, service: 'avelqua-line-webhook', enabled: lineEnabled() });
});

router.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    try {
      await ensureLineNotifyTables();
      const sig = req.headers['x-line-signature'];
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
      if (!verifySignature(rawBody, sig)) {
        return res.sendStatus(403);
      }
      res.sendStatus(200);

      const body = JSON.parse(rawBody.toString('utf8'));
      for (const event of body.events || []) {
        const lineUserId = event.source?.userId;
        if (!lineUserId || event.type !== 'message' || event.message?.type !== 'text') continue;

        const text = String(event.message.text || '').trim();
        const registerMatch = text.match(/^(?:register|ลงทะเบียน)\s+(\S+@\S+\.\S+)$/i);
        if (registerMatch) {
          const email = registerMatch[1].toLowerCase();
          const user = await findByEmail(email);
          if (!user) {
            await replyMessage(event.replyToken, {
              type: 'text',
              text: `❌ ไม่พบ Email: ${email}\nกรุณาใช้ email ที่สมัครเว็บ Avelqua`
            }).catch(() => {});
            continue;
          }
          await query(
            `
            INSERT INTO line_subscribers (user_id, line_user_id, email, verified, subscribed, updated_at)
            VALUES ($1, $2, $3, TRUE, TRUE, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              line_user_id = EXCLUDED.line_user_id,
              email = EXCLUDED.email,
              verified = TRUE,
              subscribed = TRUE,
              updated_at = NOW()
          `,
            [user.id, lineUserId, email]
          ).catch(async () => {
            await query(
              `
              INSERT INTO line_subscribers (user_id, line_user_id, email, verified, subscribed, updated_at)
              VALUES ($1, $2, $3, TRUE, TRUE, NOW())
              ON CONFLICT (line_user_id) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                email = EXCLUDED.email,
                verified = TRUE,
                subscribed = TRUE,
                updated_at = NOW()
            `,
              [user.id, lineUserId, email]
            ).catch(() => {});
          });
          await query(
            `UPDATE users SET line_id = $2, updated_at = NOW() WHERE id = $1`,
            [user.id, lineUserId]
          ).catch(() => {});
          await replyMessage(event.replyToken, {
            type: 'text',
            text:
              `✅ ลงทะเบียนสำเร็จ!\nEmail: ${email}\n` +
              `จะได้รับสรุปกำไร/ขาดทุนทุกวัน 07:00 น. (จันทร์–ศุกร์)\n\n` +
              `พิมพ์ "help" เพื่อดูคำสั่ง`
          }).catch(() => {});
          continue;
        }

        setImmediate(() => {
          handleCommand(lineUserId, text).catch((err) => {
            console.error('[line-webhook] command error:', err.message);
          });
        });
      }
    } catch (e) {
      console.error('[line-webhook] error:', e);
      if (!res.headersSent) res.sendStatus(500);
    }
  }
);

module.exports = router;
