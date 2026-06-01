'use strict';

const { query } = require('../config/database');

async function ensureLineNotifyTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS line_subscribers (
      id           BIGSERIAL PRIMARY KEY,
      user_id      BIGINT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      line_user_id VARCHAR(60) UNIQUE NOT NULL,
      email        VARCHAR(200),
      verified     BOOLEAN NOT NULL DEFAULT FALSE,
      subscribed   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_line_subscribers_line_user_id
      ON line_subscribers(line_user_id);
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS daily_pnl_log (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id    BIGINT,
      mt5_login     TEXT,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      balance       NUMERIC(14,2),
      equity        NUMERIC(14,2),
      pnl_day       NUMERIC(14,2),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, account_id, snapshot_date)
    );
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_daily_pnl_log_user_date
      ON daily_pnl_log(user_id, snapshot_date DESC);
  `);

  await query(`
    ALTER TABLE line_subscribers
    ADD COLUMN IF NOT EXISTS pending_action VARCHAR(40)
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS line_expiry_alert_log (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id BIGINT NOT NULL REFERENCES user_subscriptions(id) ON DELETE CASCADE,
      line_user_id    VARCHAR(60) NOT NULL,
      alert_type      VARCHAR(30) NOT NULL,
      expiry_at       TIMESTAMPTZ NOT NULL,
      sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_line_expiry_alert_once
      ON line_expiry_alert_log(subscription_id, alert_type, expiry_at);
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_line_expiry_alert_user_sent
      ON line_expiry_alert_log(user_id, sent_at DESC);
  `);
}

module.exports = { ensureLineNotifyTables };
