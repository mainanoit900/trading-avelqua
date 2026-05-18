'use strict';

const { query } = require('../config/database');
const { adminPortNoFromSystem } = require('./adminVpsBridge');

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function folderPathForPortNo(portNo, folderPath = '') {
  const fp = String(folderPath || '').trim();
  if (fp) return fp;
  const n = adminPortNoFromSystem(portNo);
  if (!n) return '';
  return `C:\\MT5_PORTS\\VPS-WIN-01-PORT-${String(n).padStart(2, '0')}`;
}

function vpsPortNameForNo(portNo) {
  const n = adminPortNoFromSystem(portNo);
  if (!n) return '';
  return `VPS-WIN-01-PORT-${String(n).padStart(2, '0')}`;
}

/**
 * ดึง VPS / โฟลเดอร์ PORT จากบัญชีที่เชื่อมต่อแล้ว (ไม่จองพอร์ตใหม่)
 */
async function loadAccountPortContext(accountId, userId, db = null) {
  const run = db?.query
    ? (sql, params) => db.query(sql, params)
    : (sql, params) => query(sql, params);

  const res = await run(
    `
    SELECT
      ma.id,
      ma.user_id,
      ma.mt5_login,
      ma.mt5_password,
      ma.server_name,
      ma.port_slot,
      ma.vps_id,
      ma.port_id,
      ma.assigned_port_no,
      ma.windows_port_no,
      ma.last_balance,
      ma.last_equity,
      ma.status,
      NULLIF(TRIM(COALESCE(vp.folder_path, '')), '') AS folder_path,
      vp.port_no AS vps_port_no,
      vn.id AS node_id,
      vn.node_name,
      vn.node_code,
      vn.agent_token
    FROM vps_system.mt5_accounts ma
    LEFT JOIN vps_system.vps_ports vp ON vp.id = ma.port_id
    LEFT JOIN vps_system.vps_nodes vn ON vn.id = ma.vps_id
    WHERE ma.id = $1
      AND ma.user_id = $2
    LIMIT 1
  `,
    [accountId, userId]
  );

  const account = res.rows?.[0];
  if (!account) return null;

  const portNo =
    num(account.assigned_port_no) ||
    num(account.windows_port_no) ||
    num(account.vps_port_no) ||
    num(account.port_slot);

  const folderPath =
    folderPathForPortNo(portNo, account.folder_path) ||
    (portNo ? folderPathForPortNo(portNo, '') : '');
  const vpsPortName = vpsPortNameForNo(portNo);
  const nodeId = num(account.node_id) || num(account.vps_id);

  return {
    accountId: num(account.id),
    userId: num(account.user_id),
    account,
    portNo,
    portSlot: num(account.port_slot) || portNo,
    vpsId: num(account.vps_id),
    nodeId,
    portId: num(account.port_id) || null,
    folderPath,
    vpsPortName,
    vpsFolderPath: folderPath,
    mt5Login: String(account.mt5_login || '').trim(),
    serverName: String(account.server_name || 'MohicansMarkets-Live').trim(),
    nodeName: account.node_name || account.node_code || '',
    nodeCode: account.node_code || '',
    agentToken: account.agent_token || ''
  };
}

function buildRunMt5BotPayload({
  accountCtx,
  bot,
  lot,
  capital,
  trade,
  preset,
  eaSet = {},
  instanceId = null,
  commandType = 'run_mt5_bot'
}) {
  const portNo = accountCtx.portNo;
  const folder = accountCtx.folderPath;

  return {
    action: commandType,
    commandType,
    instanceId,
    userId: accountCtx.userId || accountCtx.account.user_id,
    accountId: accountCtx.accountId || accountCtx.account.id,
    broker: 'MH Markets',
    serverName: accountCtx.serverName || 'MohicansMarkets-Live',
    mt5Login: accountCtx.mt5Login || String(accountCtx.account.mt5_login || '').trim(),
    mt5Password: String(accountCtx.account?.mt5_password || '').trim(),
    password: String(accountCtx.account?.mt5_password || '').trim(),
    botCode: bot.bot_code,
    botName: bot.display_name || bot.bot_name,
    eaName: bot.bot_code,
    symbol: 'XAUUSD',
    lot,
    lotPlus: eaSet.lotPlus != null ? eaSet.lotPlus : num(preset?.lot_plus, lot),
    capital,
    capitalUsed: capital,
    tradeLevel: trade.trade_level,
    tStart: trade.t_start,
    tStop: trade.t_stop,
    pipStep: eaSet.pipStep != null ? eaSet.pipStep : num(preset?.pip_step, 345),
    presetId: preset?.id || null,
    presetSlug: preset?.presetSlug || null,
    presetRow: preset && typeof preset === 'object' ? preset : null,
    eaSetFileName: eaSet.eaSetFileName || '',
    eaSetContent: eaSet.eaSetContent || '',
    eaSetPaths: eaSet.eaSetPaths || [],
    eaAttachHint: eaSet.eaAttachHint || '',
    port: portNo,
    port_no: portNo,
    portNo,
    portNumber: portNo,
    portSlot: accountCtx.portSlot,
    portId: accountCtx.portId,
    vpsId: accountCtx.vpsId,
    nodeId: accountCtx.nodeId || accountCtx.vpsId,
    nodeCode: accountCtx.nodeCode || '',
    folderPath: folder,
    folder_path: folder,
    vpsFolderPath: folder,
    vpsPortName: accountCtx.vpsPortName,
    expertsRelative: 'MQL5\\Experts\\Trading Bot',
    experts_relative: 'MQL5\\Experts\\Trading Bot',
    keepMt5Open: true,
    stopTradingOnly: false
  };
}

module.exports = {
  folderPathForPortNo,
  vpsPortNameForNo,
  loadAccountPortContext,
  buildRunMt5BotPayload
};
