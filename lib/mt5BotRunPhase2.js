'use strict';

const { query } = require('../config/database');
const { createConnectAttempt } = require('./mt5ConnectAttempt');
const { insertPendingAgentCommand } = require('./vpsAgentCommandQueue');
const { acquireVpsLoginSlot, releaseVpsLoginSlot } = require('./mt5LoginGate');
const { MT5_LOCKED_SERVER } = require('./mt5Server');
const { loadUserPortIsolationContext, attachPortIsolationFields } = require('./mt5PortIsolation');

function clean(v) {
  return String(v || '').trim();
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function normalizeStarts(body = {}) {
  if (Array.isArray(body.starts) && body.starts.length) {
    return body.starts.map((row) => ({
      accountId: num(row.accountId || row.account_id),
      botCode: clean(row.botCode || row.bot_code).toUpperCase()
    }));
  }
  const accountId = num(body.accountId || body.account_id);
  if (!accountId) return [];
  if (Array.isArray(body.botCodes) && body.botCodes.length) {
    return body.botCodes.map((code) => ({
      accountId,
      botCode: clean(code).toUpperCase()
    }));
  }
  const botCode = clean(body.botCode || body.bot_code).toUpperCase();
  if (botCode) return [{ accountId, botCode }];
  return [];
}

async function loadAccountForUser(accountId, userId) {
  const r = await query(
    `
    SELECT a.*,
           vp.port_no AS vps_port_no,
           NULLIF(TRIM(COALESCE(vp.folder_path, '')), '') AS vps_folder_path,
           n.node_code
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports vp ON vp.id = a.port_id
    LEFT JOIN vps_system.vps_nodes n ON n.id = a.vps_id
    WHERE a.id = $1 AND a.user_id = $2
    LIMIT 1
  `,
    [Number(accountId), Number(userId)]
  );
  return r.rows?.[0] || null;
}

async function loadBotCatalog(botCode) {
  const r = await query(
    `
    SELECT *
    FROM vps_system.bot_catalog
    WHERE UPPER(bot_code) = UPPER($1) AND is_active = TRUE
    LIMIT 1
  `,
    [clean(botCode)]
  );
  return r.rows?.[0] || null;
}

function folderPathForAccount(account) {
  const fromPort = clean(account.vps_folder_path || account.folder_path);
  if (fromPort) return fromPort;
  const portNo = num(account.assigned_port_no || account.vps_port_no);
  const nodeCode = clean(account.node_code) || 'VPS-WIN-01';
  if (!portNo) return '';
  return `C:\\MT5_PORTS\\${nodeCode}-PORT-${String(portNo).padStart(2, '0')}`;
}

async function queueBotRunCommands({ attemptId, vpsId, portId, runPayload, client = null }) {
  // Single run_mt5_bot only — agent opens MT5 once (login ini + EA). Avoid duplicate login_mt5 window.
  const runIns = await insertPendingAgentCommand({
    vpsId: Number(vpsId),
    nodeId: Number(vpsId),
    portId: portId != null ? Number(portId) : null,
    commandType: 'run_mt5_bot',
    payload: {
      ...runPayload,
      attemptId: String(attemptId || runPayload?.attemptId || ''),
      purposeType: 'bot_run',
      keepMt5Open: true,
      purpose: 'bot_run_execute',
      action: 'run_mt5_bot',
      commandType: 'run_mt5_bot'
    },
    client
  });

  return {
    loginCommandId: 0,
    runCommandId: Number(runIns?.id || 0)
  };
}

async function assertNoRecentBotRunAttempt(accountId, windowSec = 15) {
  const aid = num(accountId);
  if (!aid) return;

  const existingAttempt = await query(
    `
    SELECT attempt_id, status, created_at
    FROM vps_system.mt5_connect_attempts
    WHERE account_id = $1
      AND purpose_type = 'bot_run'
      AND status IN ('queued', 'starting', 'checking', 'connected')
      AND created_at > NOW() - (($2::text || ' seconds')::interval)
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [aid, String(Math.max(5, Number(windowSec) || 15))]
  ).catch(() => ({ rows: [] }));

  if (existingAttempt.rows?.[0]) {
    const recentAttempt = existingAttempt.rows[0];
    console.log('[BOT_RUN_DEDUP] Recent attempt found', {
      accountId: aid,
      attemptId: recentAttempt.attempt_id,
      status: recentAttempt.status,
      createdAt: recentAttempt.created_at
    });
    throw new Error(`บอทกำลังเปิดอยู่ (${recentAttempt.status}) — กรุณารอสักครู่`);
  }
}

async function startBotRunForAccount({ userId, accountId, botCode, runOptions = {} }) {
  const uid = num(userId);
  const aid = num(accountId);
  const code = clean(botCode).toUpperCase();
  if (!uid || !aid || !code) {
    throw new Error('accountId และ botCode จำเป็นต้องระบุ');
  }

  await assertNoRecentBotRunAttempt(aid);

  const account = await loadAccountForUser(aid, uid);
  if (!account) throw new Error('ไม่พบบัญชี MT5 ของคุณ');
  if (String(account.status || '').toLowerCase() !== 'connected') {
    throw new Error('PORT นี้ยังไม่ผ่าน Phase 1 (Login) — กรุณา Connect MT5 ให้สำเร็จก่อน');
  }
  if (!num(account.vps_id) || !num(account.assigned_port_no)) {
    throw new Error('PORT นี้ยังไม่มีข้อมูล VPS/PORT ที่พร้อมรัน');
  }
  if (!clean(account.mt5_password)) {
    throw new Error('ไม่พบรหัสผ่าน MT5 สำหรับ PORT นี้');
  }

  const bot = await loadBotCatalog(code);
  if (!bot) throw new Error(`ไม่พบ BOT: ${code}`);

  const vpsId = num(account.vps_id);
  const portId = num(account.port_id) || null;
  const assignedPortNo = num(account.assigned_port_no);
  const folderPath = folderPathForAccount(account);
  const mt5Login = clean(account.mt5_login);
  const serverName = clean(account.server_name || account.mt5_server) || MT5_LOCKED_SERVER;

  let loginGateKey = null;
  try {
    const gate = await acquireVpsLoginSlot(vpsId, assignedPortNo);
    loginGateKey = gate.lockKey;

    const attemptId = await createConnectAttempt({
      accountId: aid,
      userId: uid,
      vpsId,
      portId,
      portSlot: num(account.port_slot) || assignedPortNo,
      assignedPortNo,
      folderPath,
      mt5Login,
      serverName,
      purposeType: 'bot_run'
    });

    const common = attachPortIsolationFields(
      {
      attemptId,
      accountId: aid,
      userId: uid,
      mt5Login,
      mt5Password: clean(account.mt5_password),
      password: clean(account.mt5_password),
      serverName,
      port: assignedPortNo,
      portNo: assignedPortNo,
      portNumber: assignedPortNo,
      port_no: assignedPortNo,
      folderPort: assignedPortNo,
      vpsPortNumber: assignedPortNo,
      portSlot: num(account.port_slot) || assignedPortNo,
      portId,
      vpsId,
      nodeId: vpsId,
      vpsFolderPath: folderPath,
      folderPath,
      folder_path: folderPath,
      botCode: clean(bot.bot_code),
      botName: clean(bot.display_name || bot.bot_name || bot.bot_code),
      eaName: clean(bot.bot_code),
      purposeType: 'bot_run',
      keepMt5Open: true,
      symbol: clean(bot.symbol) || 'XAUUSD',
      period: clean(runOptions.period) || 'H1',
      chartPeriod: clean(runOptions.chartPeriod) || 'H1',
      expertsRelative: 'MQL5\\Experts\\Trading Bot',
      experts_relative: 'MQL5\\Experts\\Trading Bot',
      ...runOptions
      },
      await loadUserPortIsolationContext(uid, vpsId, assignedPortNo).catch(() => ({
        userPortNumbers: [],
        keepOpenPorts: [assignedPortNo]
      }))
    );

    const queued = await queueBotRunCommands({
      attemptId,
      vpsId,
      portId,
      runPayload: common
    });

    if (attemptId && queued.runCommandId) {
      await query(
        `
        UPDATE vps_system.mt5_connect_attempts
        SET command_id = $2, updated_at = NOW()
        WHERE attempt_id = $1
      `,
        [attemptId, queued.runCommandId]
      ).catch(() => {});
    }

    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status = 'connecting',
          last_login_message = 'กำลังเปิด MT5 และรัน BOT...',
          updated_at = NOW()
      WHERE id = $1
    `,
      [aid]
    ).catch(() => {});

    return {
      accountId: aid,
      botCode: clean(bot.bot_code),
      attemptId,
      loginCommandId: queued.loginCommandId,
      runCommandId: queued.runCommandId,
      assignedPortNo,
      purposeType: 'bot_run'
    };
  } finally {
    if (loginGateKey) await releaseVpsLoginSlot(loginGateKey).catch(() => {});
  }
}

async function startBotRunPhase2(userId, body = {}) {
  const starts = normalizeStarts(body);
  if (!starts.length) {
    throw new Error('กรุณาระบุ accountId + botCode หรือ starts[]');
  }

  const results = [];
  for (const row of starts) {
    results.push(
      await startBotRunForAccount({
        userId,
        accountId: row.accountId,
        botCode: row.botCode
      })
    );
  }
  return results;
}

module.exports = {
  assertNoRecentBotRunAttempt,
  normalizeStarts,
  queueBotRunCommands,
  startBotRunPhase2,
  startBotRunForAccount
};
