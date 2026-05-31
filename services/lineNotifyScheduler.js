'use strict';

const cron = require('node-cron');
const { query } = require('../config/database');
const { pushText, pushFlex, lineEnabled } = require('./lineService');
const { saveDailySnapshots } = require('../lib/linePnlReport');
const { fetchActivePorts } = require('../lib/linePortfolio');
const { buildDailyReportFlex } = require('../lib/lineFlexUi');
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
      const flex = await buildDailyReportFlex(sub.user_id);
      if (!flex) continue;
      await pushFlex(sub.line_user_id, flex.altText, flex.contents);
      const accounts = await fetchActivePorts(sub.user_id);
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
