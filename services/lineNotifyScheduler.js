'use strict';

const cron = require('node-cron');
const { query } = require('../config/database');
const { pushText, lineEnabled } = require('./lineService');
const {
  fetchUserAccounts,
  buildDailyReportMessage,
  saveDailySnapshots
} = require('../lib/linePnlReport');
const { ensureLineNotifyTables } = require('../lib/lineNotifySchema');

async function sendDailyReport() {
  if (!lineEnabled()) return;

  await ensureLineNotifyTables();

  const subs = await query(
    `
    SELECT line_user_id, user_id
    FROM line_subscribers
    WHERE verified = TRUE AND subscribed = TRUE
  `
  ).catch(() => ({ rows: [] }));

  for (const sub of subs.rows || []) {
    try {
      const msg = await buildDailyReportMessage(sub.user_id);
      if (!msg) continue;
      await pushText(sub.line_user_id, msg);
      const accounts = await fetchUserAccounts(sub.user_id);
      await saveDailySnapshots(sub.user_id, accounts);
    } catch (e) {
      console.error('[LineScheduler] error user', sub.user_id, e.message);
    }
  }
}

function startLineScheduler() {
  if (!lineEnabled()) {
    console.log('[LineScheduler] skipped — LINE_CHANNEL_ACCESS_TOKEN not set');
    return;
  }
  const expr = String(process.env.LINE_DAILY_CRON || '0 7 * * 1-5');
  cron.schedule(
    expr,
    () => {
      sendDailyReport().catch((e) => console.error('[LineScheduler]', e.message));
    },
    { timezone: process.env.TZ || 'Asia/Bangkok' }
  );
  console.log(`[LineScheduler] started — cron "${expr}" (${process.env.TZ || 'Asia/Bangkok'})`);
}

module.exports = { startLineScheduler, sendDailyReport };
