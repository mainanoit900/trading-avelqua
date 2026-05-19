#!/usr/bin/env node
'use strict';

/**
 * ดึง equity บัญชีที่เชื่อมต่อแล้วทันที (admin/ops)
 * node scripts/sync-equity-now.js [accountId]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { query } = require('../config/database');
const { loadAccountPortContext } = require('../lib/mt5AccountPort');
const { fetchEquityFromVps, positiveMoney } = require('../lib/mt5EquitySync');

async function main() {
  const accountId = Number(process.argv[2] || 723);
  const row = await query(
    `SELECT id, user_id, mt5_login FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
    [accountId]
  );
  const acc = row.rows?.[0];
  if (!acc) {
    console.error('Account not found:', accountId);
    process.exit(1);
  }

  const ctx = await loadAccountPortContext(accountId, acc.user_id);
  if (!ctx) {
    console.error('No port context');
    process.exit(1);
  }

  console.log('Syncing', acc.mt5_login, 'port', ctx.portNo, ctx.folderPath);
  const out = await fetchEquityFromVps(ctx, accountId, acc.user_id, {
    waitMs: 15000,
    light: true,
    purpose: 'equity_manual_sync'
  });

  const fresh = await query(
    `SELECT last_balance, last_equity FROM vps_system.mt5_accounts WHERE id=$1`,
    [accountId]
  );
  const a = fresh.rows?.[0] || {};
  console.log('Result:', out);
  console.log('DB:', {
    balance: positiveMoney(a.last_balance),
    equity: positiveMoney(a.last_equity)
  });
  process.exit(out?.ok || positiveMoney(a.last_equity) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
