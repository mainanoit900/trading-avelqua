'use strict';

const { query } = require('../config/database');
const { positiveMoney, queueAccountSnapshot, buildSyncPayload } = require('./mt5EquitySync');

const POLL_MS = Number(process.env.MT5_EQUITY_POLL_MS || 20000);
const MAX_ACCOUNTS_PER_TICK = Number(process.env.MT5_EQUITY_POLL_BATCH || 24);
const MIN_GAP_SEC = Number(process.env.MT5_EQUITY_POLL_GAP_SEC || 18);

let pollTimer = null;
let tickRunning = false;

async function hasRecentEquitySync(vpsId, accountId) {
  const r = await query(
    `
    SELECT 1
    FROM vps_system.vps_agent_commands
    WHERE vps_id = $1
      AND command_type IN ('account_snapshot', 'sync_mt5_account', 'port_read_file')
      AND COALESCE(payload->>'purpose', '') IN ('equity_sync', 'equity_poller', 'equity_connect')
      AND COALESCE(payload->>'accountId', '') = $2
      AND created_at > NOW() - ($3::text || ' seconds')::interval
    LIMIT 1
  `,
    [vpsId, String(accountId), String(MIN_GAP_SEC)]
  ).catch(() => ({ rows: [] }));
  return !!r.rows?.[0];
}

async function pollEquityTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const rows = await query(
      `
      SELECT
        ma.id,
        ma.user_id,
        ma.vps_id,
        ma.assigned_port_no,
        ma.port_slot,
        ma.mt5_login,
        ma.last_equity,
        COALESCE(p.folder_path, '') AS folder_path
      FROM vps_system.mt5_accounts ma
      LEFT JOIN vps_system.vps_ports p ON p.id = ma.port_id
      INNER JOIN vps_system.vps_nodes vn ON vn.id = ma.vps_id
      WHERE LOWER(COALESCE(ma.status, '')) = 'connected'
        AND ma.vps_id IS NOT NULL
        AND LOWER(COALESCE(vn.status, '')) = 'online'
      ORDER BY ma.last_equity NULLS FIRST, ma.updated_at ASC NULLS FIRST
      LIMIT $1
    `,
      [MAX_ACCOUNTS_PER_TICK]
    );

    let queued = 0;
    for (const acc of rows.rows || []) {
      const vpsId = Number(acc.vps_id || 0);
      const accountId = Number(acc.id || 0);
      const userId = Number(acc.user_id || 0);
      const portNo = Number(acc.assigned_port_no || acc.port_slot || 0);
      if (!vpsId || !accountId || !portNo) continue;

      if (positiveMoney(acc.last_equity)) {
        const fresh = await query(
          `
          SELECT 1 FROM vps_system.mt5_accounts
          WHERE id=$1 AND updated_at > NOW() - INTERVAL '25 seconds'
          LIMIT 1
        `,
          [accountId]
        ).catch(() => ({ rows: [] }));
        if (fresh.rows?.[0]) continue;
      }

      if (await hasRecentEquitySync(vpsId, accountId)) continue;

      const ctx = {
        vpsId,
        portNo,
        portSlot: Number(acc.port_slot || portNo),
        folderPath: String(acc.folder_path || '').trim(),
        mt5Login: String(acc.mt5_login || '').trim()
      };
      const syncPayload = {
        ...buildSyncPayload(ctx, accountId, userId),
        purpose: 'equity_poller',
        mt5Login: ctx.mt5Login
      };
      await queueAccountSnapshot(vpsId, syncPayload).catch(() => {});
      queued += 1;
    }
    if (queued > 0 && process.env.MT5_EQUITY_POLL_DEBUG === '1') {
      console.log(`[mt5-equity-poller] queued ${queued} account_snapshot`);
    }
  } catch (e) {
    console.error('[mt5-equity-poller]', e.message);
  } finally {
    tickRunning = false;
  }
}

function startMt5EquityPoller() {
  if (pollTimer) return;
  const disabled = String(process.env.MT5_EQUITY_POLL_DISABLED || '').toLowerCase();
  if (disabled === '1' || disabled === 'true') return;

  pollTimer = setInterval(() => {
    pollEquityTick().catch(() => {});
  }, POLL_MS);
  setTimeout(() => pollEquityTick().catch(() => {}), 4000);
  console.log(`[mt5-equity-poller] started interval=${POLL_MS}ms`);
}

module.exports = { startMt5EquityPoller, pollEquityTick };
