'use strict';

const crypto = require('crypto');
const express = require('express');
const { handleLineInput, postbackToText } = require('../lib/lineCommandHandler');
const { lineEnabled } = require('../services/lineService');
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
        if (!lineUserId) continue;

        if (event.type === 'message' && event.message?.type === 'text') {
          const text = String(event.message.text || '').trim();
          setImmediate(() => {
            handleLineInput(lineUserId, text, event.replyToken).catch((err) => {
              console.error('[line-webhook] text error:', err.message);
            });
          });
          continue;
        }

        if (event.type === 'postback') {
          const text = postbackToText(event.postback?.data);
          setImmediate(() => {
            handleLineInput(lineUserId, text, event.replyToken).catch((err) => {
              console.error('[line-webhook] postback error:', err.message);
            });
          });
        }
      }
    } catch (e) {
      console.error('[line-webhook] error:', e);
      if (!res.headersSent) res.sendStatus(500);
    }
  }
);

module.exports = router;
