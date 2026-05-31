'use strict';

const { query } = require('../config/database');
const { findByEmail } = require('../repositories/usersRepo');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

async function getSubscriber(lineUserId) {
  const r = await query(
    `
    SELECT id, user_id, line_user_id, email, verified, subscribed, pending_action
    FROM line_subscribers
    WHERE line_user_id = $1
    LIMIT 1
  `,
    [lineUserId]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function setPendingAction(lineUserId, action) {
  await query(
    `
    INSERT INTO line_subscribers (line_user_id, pending_action, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (line_user_id) DO UPDATE SET
      pending_action = EXCLUDED.pending_action,
      updated_at = NOW()
  `,
    [lineUserId, action || null]
  ).catch(() => {});
}

async function registerLineUser(lineUserId, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    return { ok: false, error: 'invalid_email' };
  }

  const user = await findByEmail(normalized);
  if (!user) {
    return { ok: false, error: 'email_not_found', email: normalized };
  }

  await query(
    `
    INSERT INTO line_subscribers (user_id, line_user_id, email, verified, subscribed, pending_action, updated_at)
    VALUES ($1, $2, $3, TRUE, TRUE, NULL, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      line_user_id = EXCLUDED.line_user_id,
      email = EXCLUDED.email,
      verified = TRUE,
      subscribed = TRUE,
      pending_action = NULL,
      updated_at = NOW()
  `,
    [user.id, lineUserId, normalized]
  ).catch(async () => {
    await query(
      `
      INSERT INTO line_subscribers (user_id, line_user_id, email, verified, subscribed, pending_action, updated_at)
      VALUES ($1, $2, $3, TRUE, TRUE, NULL, NOW())
      ON CONFLICT (line_user_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        email = EXCLUDED.email,
        verified = TRUE,
        subscribed = TRUE,
        pending_action = NULL,
        updated_at = NOW()
    `,
      [user.id, lineUserId, normalized]
    );
  });

  await query(`UPDATE users SET line_id = $2, updated_at = NOW() WHERE id = $1`, [
    user.id,
    lineUserId
  ]).catch(() => {});

  return { ok: true, userId: user.id, email: normalized };
}

function isEmailText(text) {
  const t = String(text || '').trim();
  if (!EMAIL_RE.test(t)) return null;
  return t.toLowerCase();
}

module.exports = {
  getSubscriber,
  setPendingAction,
  registerLineUser,
  isEmailText,
  EMAIL_RE
};
