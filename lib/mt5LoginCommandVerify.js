'use strict';

const { query } = require('../config/database');
const {
  parseMt5JournalOutcome,
  messageIndicatesLoginFailed,
  windowTitleConfirmsLogin,
  resolveLoginFailUserMessage,
  MT5_SUCCESS_MSG,
  MT5_EARLY_SUCCESS_MSG,
  MT5_FAIL_USER_MSG,
  MT5_LOGIN_TIMEOUT_MSG
} = require('./mt5JournalVerify');
const {
  hasJournalGateMarker,
  messageForUpgradeState,
  getAgentUpgradeState,
  expireStuckMaintenanceCommands
} = require('./agentDeploy');
const { buildMt5LoginPayload, folderPathForPackageSlot } = require('./adminVpsPortPicker');
const {
  resolveSystemVpsId,
  setAdminAllocationStatus,
  upsertPortHealthRunning,
  clearPortHealthRunning,
  adminPortNoFromSystem,
  reconcilePortIdleWhenAgentFree,
  releaseUserPortCompletely,
  queueForceStopMt5
} = require('./adminVpsBridge');
const { positiveMoney } = require('./mt5EquitySync');

async function findLoginCommandInProgress(accountId, vpsId) {
  if (!accountId || !vpsId) return null;
  const r = await query(
    `
    SELECT id, status
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='login_mt5'
      AND (payload->>'accountId')::text = $2::text
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function findRecentLoginCommand(accountId, vpsId) {
  if (!accountId || !vpsId) return null;
  const r = await query(
    `
    SELECT id, status, result, finished_at, payload, error
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND (payload->>'accountId')::text = $2::text
      AND created_at > NOW() - INTERVAL '3 hours'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

function parseJournalRelaxed(content, login, sinceMs) {
  if (!content || !login) return null;
  const since = Number(sinceMs || 0);
  if (since > 0) {
    return parseMt5JournalOutcome(content, login, undefined, since);
  }
  return parseMt5JournalOutcome(content, login, undefined, 0);
}

async function journalVerdictRelaxed(content, login, accountId, vpsId, portNo) {
  if (!content || !login) return null;
  const sinceMs = await journalSinceMsForVerify(accountId, vpsId, portNo);
  return parseJournalRelaxed(content, login, sinceMs);
}

async function findJournalFromLoginMt5Command(accountId, vpsId, login) {
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (!cmd) return null;
  const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
  const evidence = extractJournalEvidence(
    res.journalEvidence,
    res.journal_evidence,
    res.message,
    cmd.error
  );
  if (!evidence) return null;
  const portNo = Number(
    cmd.payload?.portNo || cmd.payload?.port_no || cmd.payload?.port || 0
  );
  const sinceMs = await journalSinceMsForVerify(accountId, vpsId, portNo);
  const verdict = parseMt5JournalOutcome(evidence, login, undefined, sinceMs);
  if (verdict === 'success') return { evidence, cmd };
  return null;
}

async function findJournalForPort(vpsId, portNo, login, accountId) {
  const loginStr = String(login || '').trim();
  const ports = [...new Set([String(portNo), String(Number(portNo) + 100)])].filter(Boolean);
  const r = await query(
    `
    SELECT result, payload
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file', 'login_mt5', 'connect_mt5')
      AND finished_at > NOW() - INTERVAL '45 minutes'
      AND (
        (payload->>'port_no')::text = ANY($2::text[])
        OR (payload->>'port')::text = ANY($2::text[])
        OR (payload->>'portNumber')::text = ANY($2::text[])
      )
    ORDER BY id DESC
    LIMIT 8
  `,
    [vpsId, ports]
  ).catch(() => ({ rows: [] }));
  const sinceMs = accountId
    ? await journalSinceMsForVerify(accountId, vpsId, portNo)
    : 0;
  for (const row of r.rows || []) {
    const content = String(
      row.result?.journalEvidence || row.result?.journal_evidence || row.result?.content || ''
    ).trim();
    if (content && parseMt5JournalOutcome(content, loginStr, undefined, sinceMs) === 'success') {
      return { content, payload: row.payload || {} };
    }
  }
  return null;
}

async function isPortProcessActive(vpsId, portNo, portId) {
  if (portId) {
    const r = await query(
      `
      SELECT process_id
      FROM vps_system.vps_ports
      WHERE id=$1 AND process_id IS NOT NULL
      LIMIT 1
    `,
      [portId]
    ).catch(() => ({ rows: [] }));
    if (r.rows?.[0]?.process_id) return true;
  }
  if (!vpsId || !portNo) return false;
  const r = await query(
    `
    SELECT process_id
    FROM vps_system.vps_ports
    WHERE vps_id=$1 AND port_no=$2 AND process_id IS NOT NULL
    LIMIT 1
    `,
    [vpsId, portNo]
  ).catch(() => ({ rows: [] }));
  return !!r.rows?.[0]?.process_id;
}

function extractJournalEvidence(...sources) {
  for (const src of sources) {
    const text = String(src || '').trim();
    if (!text) continue;
    if (
      text.length >= 15 &&
      /authorized on|authorization on|invalid account|invalid password/i.test(text)
    ) {
      return text.slice(0, 8000);
    }
  }
  return '';
}

async function isPortMt5Running(vpsId, portNo) {
  if (!vpsId || !portNo) return false;
  const r = await query(
    `
    SELECT 1
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      AND running IS TRUE
      AND updated_at > NOW() - INTERVAL '15 minutes'
    LIMIT 1
  `,
    [vpsId, portNo]
  ).catch(() => ({ rows: [] }));
  return !!r.rows?.[0];
}

/** ยอมรับ journal ก่อนกด connect เล็กน้อยเมื่อ MT5 รันอยู่บน port แล้ว */
async function journalSinceMsForVerify(accountId, vpsId, portNo) {
  return accountConnectSinceMs(accountId);
}

/** ยืนยัน login รอบนี้จากคำสั่ง login_mt5 + journal เท่านั้น */
async function isAccountLoginJournalVerified(account) {
  const accountId = Number(account?.id || 0);
  if (!accountId) return { ok: false, reason: 'NO_ACCOUNT' };
  return verifyLoginFromCommand({
    accountId,
    vpsId: account.vps_id,
    mt5Login: account.mt5_login,
    portNo: account.assigned_port_no || account.port_slot
  }).catch(() => ({ ok: false, reason: 'VERIFY_ERROR' }));
}

async function probeRecentLoginCommandFailed(account) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  if (!accountId) return { failed: false };
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (!cmd) return { failed: false };
  const st = String(cmd.status || '').toLowerCase();
  if (!['failed', 'error', 'cancelled'].includes(st)) return { failed: false };
  const sinceMs = await accountConnectSinceMs(accountId);
  const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
  const login = String(account.mt5_login || cmd.payload?.mt5Login || '').trim();
  const evidence = extractJournalEvidence(
    res.journalEvidence,
    res.journal_evidence,
    res.message,
    cmd.error
  );
  const resolved = resolveLoginFailUserMessage({
    login,
    sinceMs,
    evidence,
    rawMessage: res.message,
    cmdError: cmd.error
  });
  return {
    failed: true,
    message: resolved.message,
    authFail: resolved.authFail === true,
    journalVerdict: resolved.journalVerdict,
    cmd
  };
}

async function findLiveJournalSuccess(accountId, vpsId, login) {
  const loginStr = String(login || '').trim();
  if (!loginStr) return null;
  const params = [String(accountId)];
  let nodeFilter = '';
  if (vpsId) {
    nodeFilter = ' AND (vps_id=$2 OR node_id=$2)';
    params.push(vpsId);
  }
  const r = await query(
    `
    SELECT result, payload
    FROM vps_system.vps_agent_commands
    WHERE (payload->>'accountId')::text = $1::text
      AND command_type IN ('read_file', 'port_read_file')
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '30 minutes'
      ${nodeFilter}
    ORDER BY id DESC
    LIMIT 1
  `,
    params
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return null;
  const content = String(
    row.result?.journalEvidence || row.result?.journal_evidence || row.result?.content || ''
  ).trim();
  if (content && parseMt5JournalOutcome(content, loginStr, undefined, 0) === 'success') {
    return { content, payload: row.payload || {} };
  }
  return null;
}

async function finishPendingLoginCommands(accountId, vpsId) {
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='success',
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW(),
        error=NULL
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND (payload->>'accountId')::text = $2::text
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
  `,
    [vpsId, String(accountId)]
  ).catch(() => {});
}

/** หา journal ล้มเหลวจากคำสั่งล่าสุด — แยกรหัสผิดเร็ว */
async function findJournalFailFast(accountId, vpsId, login, portNo) {
  const loginStr = String(login || '').trim();
  if (!loginStr || !accountId) return null;
  const sinceMs = await accountConnectSinceMs(accountId);

  const stashed = await getStashedJournalEvidence(accountId);
  if (stashed && parseMt5JournalOutcome(stashed, loginStr, undefined, sinceMs) === 'failed') {
    return { source: 'stashed_journal', evidence: stashed };
  }

  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (cmd) {
    const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
    const blob = [
      res.journalEvidence,
      res.journal_evidence,
      res.message,
      cmd.error,
      cmd.result_message
    ]
      .filter(Boolean)
      .join('\n');
    if (blob && parseMt5JournalOutcome(blob, loginStr, undefined, sinceMs) === 'failed') {
      return { source: 'login_cmd', evidence: blob };
    }
    const st = String(cmd.status || '').toLowerCase();
    if (st === 'failed') {
      const errMsg = String(cmd.error || res.message || '').trim();
      if (
        errMsg.includes('ผู้ใช้งานผิด') ||
        messageIndicatesLoginFailed(errMsg, loginStr, sinceMs) ||
        messageIndicatesLoginFailed(blob, loginStr, sinceMs)
      ) {
        return { source: 'login_cmd_error', evidence: errMsg || blob };
      }
    }
  }

  const params = [String(accountId)];
  let nodeFilter = '';
  if (vpsId) {
    nodeFilter = ' AND (vps_id=$2 OR node_id=$2)';
    params.push(vpsId);
  }
  const reads = await query(
    `
    SELECT result, payload, error
    FROM vps_system.vps_agent_commands
    WHERE (payload->>'accountId')::text = $1::text
      AND command_type IN ('read_file', 'port_read_file')
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND finished_at > NOW() - INTERVAL '25 minutes'
      ${nodeFilter}
    ORDER BY id DESC
    LIMIT 5
  `,
    params
  ).catch(() => ({ rows: [] }));

  for (const row of reads.rows || []) {
    const content = String(
      row.result?.content || row.result?.journalEvidence || row.result?.journal_evidence || ''
    ).trim();
    if (content && parseMt5JournalOutcome(content, loginStr, undefined, sinceMs) === 'failed') {
      return { source: 'journal_read', evidence: content, payload: row.payload || {} };
    }
  }

  if (portNo && vpsId) {
    const ports = [...new Set([String(portNo), String(Number(portNo) + 100)])].filter(Boolean);
    const portCmds = await query(
      `
      SELECT result, payload, error, result_message
      FROM vps_system.vps_agent_commands
      WHERE (vps_id=$1 OR node_id=$1)
        AND command_type IN ('login_mt5', 'connect_mt5', 'read_file', 'port_read_file')
        AND finished_at > NOW() - INTERVAL '25 minutes'
        AND (
          (payload->>'port_no')::text = ANY($2::text[])
          OR (payload->>'port')::text = ANY($2::text[])
          OR (payload->>'portNumber')::text = ANY($2::text[])
        )
      ORDER BY id DESC
      LIMIT 6
    `,
      [vpsId, ports]
    ).catch(() => ({ rows: [] }));
    for (const row of portCmds.rows || []) {
      const blob = [
        row.result?.journalEvidence,
        row.result?.journal_evidence,
        row.result?.content,
        row.error,
        row.result_message
      ]
        .filter(Boolean)
        .join('\n');
      if (blob && parseMt5JournalOutcome(blob, loginStr, undefined, sinceMs) === 'failed') {
        return { source: 'port_cmd', evidence: blob };
      }
    }
  }

  return null;
}

async function shouldDeferLoginJournalFail(account) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  if (!accountId) return false;
  const startedAt = account.connect_started_at
    ? new Date(account.connect_started_at).getTime()
    : account.updated_at
      ? new Date(account.updated_at).getTime()
      : 0;
  const elapsedSec = startedAt
    ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    : 999;
  const deferSec = Number(process.env.MT5_LOGIN_FAIL_DEFER_SEC || 40);
  if (elapsedSec < deferSec) {
    return hasLoginCommandInProgress(accountId, vpsId);
  }
  return false;
}

async function tryFastJournalFail(account) {
  if (!account?.id) return { resolved: false };
  if (await shouldDeferLoginJournalFail(account)) {
    return { resolved: false };
  }
  const fail = await findJournalFailFast(
    account.id,
    account.vps_id,
    account.mt5_login,
    account.assigned_port_no || account.port_slot
  );
  if (!fail) return { resolved: false };

  await failAccountFromJournal(
    Number(account.id),
    Number(account.port_id || 0),
    MT5_FAIL_USER_MSG,
    {
      vpsId: account.vps_id,
      portNo: account.assigned_port_no || account.port_slot,
      folderPath: account.folder_path,
      reason: 'login_cmd_journal_failed',
      killMt5: true,
      clearPackagePort: true
    }
  );
  return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
}

/**
 * ยืนยัน connected ทันทีเมื่อ MT5 บน VPS พร้อมแล้ว (ไม่รอ poll 5s / journal queue)
 */
async function tryFastConnectConfirm(account) {
  if (!account?.id) return { resolved: false };

  const accountId = Number(account.id);
  const vpsId = Number(account.vps_id || 0);
  const portId = Number(account.port_id || 0);
  const portNo = Number(account.assigned_port_no || account.port_slot || 0);
  const login = String(account.mt5_login || '').trim();
  const status = String(account.status || '').toLowerCase();

  if (!['connecting', 'starting', 'checking'].includes(status) || !login || !vpsId) {
    return { resolved: false };
  }

  const failFast = await tryFastJournalFail(account);
  if (failFast.resolved) return failFast;

  const promoteConnected = async (source, msg = MT5_SUCCESS_MSG) => {
    await promoteAccountConnected({
      accountId,
      portId,
      mt5Login: login,
      message: msg
    });
    await finishPendingLoginCommands(accountId, vpsId);
    return { resolved: true, status: 'connected', source };
  };

  const cmdVerify = await verifyLoginFromCommand({
    accountId,
    vpsId,
    mt5Login: login,
    portNo
  }).catch(() => ({ ok: false }));
  if (cmdVerify.ok) {
    return promoteConnected(cmdVerify.source || 'login_cmd_verified', MT5_SUCCESS_MSG);
  }
  if (cmdVerify.reason === 'JOURNAL_FAILED') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
      vpsId,
      portNo,
      folderPath: account.folder_path,
      reason: 'journal_rejected_fast',
      killMt5: true,
      clearPackagePort: true
    });
    return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
  }

  const sinceMs = await journalSinceMsForVerify(accountId, vpsId, portNo);
  const stashed = await getStashedJournalEvidence(accountId);
  if (stashed) {
    const jv = parseMt5JournalOutcome(stashed, login, undefined, sinceMs);
    if (jv === 'success') {
      return promoteConnected('stashed_journal', MT5_SUCCESS_MSG);
    }
    if (jv === 'failed') {
      await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
        vpsId,
        portNo,
        folderPath: account.folder_path,
        reason: 'journal_rejected_fast',
        killMt5: true,
        clearPackagePort: true
      });
      return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
    }
  }

  const loginJournal = await findJournalFromLoginMt5Command(accountId, vpsId, login);
  if (loginJournal) {
    const jvCmd = parseMt5JournalOutcome(loginJournal.content || '', login, undefined, sinceMs);
    if (jvCmd === 'success') {
      return promoteConnected('login_cmd_journal', MT5_SUCCESS_MSG);
    }
    if (jvCmd === 'failed') {
      await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
        vpsId,
        portNo,
        folderPath: account.folder_path,
        reason: 'login_cmd_journal_failed',
        killMt5: true,
        clearPackagePort: true
      });
      return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
    }
  }

  const winTitle = String(account.mt5_window_title || '').trim();
  if (winTitle && windowTitleConfirmsLogin(winTitle, login)) {
    const portRun = await verifyPortRunningLogin({
      vpsId,
      portNo,
      mt5Login: login
    }).catch(() => ({ ok: false }));
    if (portRun.ok) {
      return promoteConnected('window_title_fast', MT5_SUCCESS_MSG);
    }
  }

  const liveJournal = await findLiveJournalSuccess(accountId, vpsId, login);
  if (liveJournal) {
    const applied = await applyJournalReadCommandResult(
      { id: vpsId },
      liveJournal.payload,
      { journalEvidence: liveJournal.content, content: liveJournal.content }
    ).catch(() => false);
    if (applied) return promoteConnected('journal_read_fast');
  }

  if (portNo) {
    const portJournal = await findJournalForPort(vpsId, portNo, login, accountId);
    if (portJournal) {
      const applied = await applyJournalReadCommandResult(
        { id: vpsId },
        portJournal.payload,
        { journalEvidence: portJournal.content, content: portJournal.content }
      ).catch(() => false);
      if (applied) return promoteConnected('journal_port_fast');
    }
  }

  return { resolved: false };
}

/** balance/equity จาก account-metrics ล่าสุด — อย่ารีเซ็ต connected เมื่อ terminal64 หยุดชั่วคราว */
function hasRecentAccountMetrics(account) {
  const eq = Number(account?.last_equity || 0);
  const bal = Number(account?.last_balance || 0);
  if (eq <= 0 && bal <= 0) return false;
  const ts = account?.updated_at ? new Date(account.updated_at).getTime() : 0;
  return ts > 0 && Date.now() - ts < 20 * 60 * 1000;
}

/** port_health ผูก login กับ port อยู่ — แม้ running=false ชั่วคราว (restart agent) */
async function portHealthLoginBindingRecent(vpsId, portNo, mt5Login) {
  if (!vpsId || !portNo || !mt5Login) return false;
  const login = String(mt5Login).trim();
  const r = await query(
    `
    SELECT mt5_login, payload
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      AND updated_at > NOW() - INTERVAL '15 minutes'
    LIMIT 1
  `,
    [vpsId, portNo]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return false;
  let reported = String(row.mt5_login || '').trim();
  if (!reported && row.payload) {
    const pl = typeof row.payload === 'object' ? row.payload : {};
    reported = String(pl.mt5_login || pl.mt5Login || '').trim();
  }
  return reported === login;
}

/**
 * กู้บัญชีที่ถูกรีเซ็ตเป็น ready/failed ทั้งที่ login_mt5 สำเร็จและมี metrics ล่าสุด
 */
async function tryRecoverReadyAccount(account) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  const portId = Number(account?.port_id || 0);
  const portNo = Number(account?.assigned_port_no || account?.port_slot || 0);
  const login = String(account?.mt5_login || '').trim();
  const st = String(account?.status || '').toLowerCase();
  if (!accountId || !login || !['ready', 'failed'].includes(st)) {
    return { recovered: false, account };
  }

  const cmdVerify = await verifyLoginFromCommand({
    accountId,
    vpsId,
    mt5Login: login,
    portNo
  }).catch(() => ({ ok: false }));
  if (!cmdVerify.ok) {
    return { recovered: false, account };
  }

  await promoteAccountConnected({
    accountId,
    portId,
    mt5Login: login,
    message: MT5_SUCCESS_MSG
  }).catch(() => {});
  if (vpsId) await finishPendingLoginCommands(accountId, vpsId).catch(() => {});

  return {
    recovered: true,
    account: {
      ...account,
      status: 'connected',
      last_error: null,
      last_login_message: MT5_SUCCESS_MSG
    }
  };
}

/**
 * ถ้า DB เป็น connected แต่ MT5 บน VPS ไม่รัน / login ไม่ตรง → รีเซ็ตให้ login ใหม่ได้
 * @param {{ allowDemote?: boolean }} opts — allowDemote:false สำหรับ poll UI (อย่าเขียน ready ทับ connected)
 */
async function reconcileConnectedAccountLive(account, opts = {}) {
  const allowDemote = opts.allowDemote !== false;
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  const portId = Number(account?.port_id || 0);
  const portNo = Number(account?.assigned_port_no || account?.port_slot || 0);
  const login = String(account?.mt5_login || '').trim();
  const st = String(account?.status || '').toLowerCase();

  if (!accountId || st !== 'connected' || !login) {
    return { changed: false, account };
  }

  const recentLoginOk = await hasRecentAgentLoginSuccess(accountId, vpsId, login);
  if (recentLoginOk) {
    return { changed: false, account };
  }

  if (await hasLoginCommandInProgress(accountId, vpsId)) {
    return { changed: false, account };
  }

  if (hasRecentAccountMetrics(account)) {
    return { changed: false, account };
  }

  if (await portHealthLoginBindingRecent(vpsId, portNo, login)) {
    return { changed: false, account };
  }

  const running = portNo ? await isPortMt5Running(vpsId, portNo) : false;
  if (!running) {
    const metricsOk = await verifyPortMetricsLogin(vpsId, portNo, login);
    if (metricsOk.ok) {
      return { changed: false, account };
    }
    if (!allowDemote) {
      return { changed: false, account, mt5MaybeOffline: true };
    }
    const msg = 'MT5 บน VPS ไม่ทำงาน — กรุณากรอก Login/Password แล้วกดเชื่อมต่อใหม่';
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='ready', last_error=$2, last_login_message=$2, updated_at=NOW()
      WHERE id=$1
    `,
      [accountId, msg]
    ).catch(() => {});
    if (portId) {
      await query(
        `UPDATE vps_system.vps_ports SET status='available', mt5_login=NULL, current_mt5_login=NULL, last_error=$2, updated_at=NOW() WHERE id=$1`,
        [portId, msg]
      ).catch(() => {});
    }
    if (vpsId && portNo) {
      await clearPortHealthRunning(vpsId, portNo).catch(() => {});
    }
    return {
      changed: true,
      status: 'ready',
      message: msg,
      account: { ...account, status: 'ready', last_error: msg, last_login_message: msg }
    };
  }

  const verify = await verifyPortRunningLogin(vpsId, portNo, login);
  if (!verify.ok && verify.reason === 'LOGIN_MISMATCH') {
    const reported = String(verify.reported || '').trim();
    const msg = reported
      ? `บัญชีบน VPS (${reported}) ไม่ตรงกับ Login ${login} — กรุณาเชื่อมต่อใหม่`
      : `บัญชีบน VPS ไม่ตรงกับ Login ${login} — กรุณาเชื่อมต่อใหม่`;
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='failed', last_error=$2, last_login_message=$2, updated_at=NOW()
      WHERE id=$1
    `,
      [accountId, msg]
    ).catch(() => {});
    return {
      changed: true,
      status: 'failed',
      message: msg,
      account: { ...account, status: 'failed', last_error: msg, last_login_message: msg }
    };
  }

  return { changed: false, account };
}

/** กู้จาก VPS เฉพาะเมื่อ Journal/คำสั่ง login ยืนยันสำเร็จ — ไม่ใช้ balance อย่างเดียว */
async function tryRecoverLoginFromPortHealth(account) {
  const accountId = Number(account?.id || 0);
  const vpsId = Number(account?.vps_id || 0);
  const portId = Number(account?.port_id || 0);
  const portNo = Number(account?.assigned_port_no || account?.port_slot || 0);
  const login = String(account?.mt5_login || '').trim();
  const st = String(account?.status || '').toLowerCase();
  if (!accountId || !login || !['connecting', 'starting', 'checking'].includes(st)) {
    return { resolved: false };
  }

  const cmdVerify = await verifyLoginFromCommand({
    accountId,
    vpsId,
    mt5Login: login,
    portNo
  }).catch(() => ({ ok: false }));
  if (cmdVerify.ok) {
    await promoteAccountConnected({
      accountId,
      portId,
      mt5Login: login,
      message: MT5_SUCCESS_MSG
    });
    await finishPendingLoginCommands(accountId, vpsId);
    return {
      resolved: true,
      status: 'connected',
      message: MT5_SUCCESS_MSG,
      source: cmdVerify.source || 'login_cmd_verified'
    };
  }
  if (cmdVerify.reason === 'JOURNAL_FAILED') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
      vpsId,
      portNo,
      folderPath: account.folder_path,
      reason: 'journal_rejected_recover',
      killMt5: true,
      clearPackagePort: true
    });
    return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
  }

  return { resolved: false };
}

/** login สำเร็จบน VPS แต่ process scan อาจไม่เห็น terminal64 — ใช้ balance/equity ล่าสุดจาก port_health */
async function verifyPortMetricsLogin(vpsId, portNo, mt5Login, opts = {}) {
  const requireLoginMatch = opts.requireLoginMatch === true;
  if (!vpsId || !portNo || !mt5Login) return { ok: false, reason: 'MISSING_PARAMS' };
  const r = await query(
    `
    SELECT balance, equity, mt5_login, payload, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      AND updated_at > NOW() - INTERVAL '15 minutes'
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [vpsId, portNo]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  const bal = Number(row?.balance || 0);
  const eq = Number(row?.equity || 0);
  if (!row || (bal <= 0 && eq <= 0)) return { ok: false, reason: 'NO_METRICS' };
  const login = String(mt5Login).trim();
  let reported = String(row.mt5_login || '').trim();
  if (!reported && row.payload) {
    const pl = typeof row.payload === 'object' ? row.payload : {};
    reported = String(pl.mt5_login || pl.mt5Login || '').trim();
  }
  if (reported && reported !== login) {
    return { ok: false, reason: 'LOGIN_MISMATCH', reported };
  }
  if (requireLoginMatch && !reported) {
    return { ok: false, reason: 'NO_LOGIN_ON_PORT' };
  }
  return { ok: true, source: 'port_health_metrics' };
}

async function hasRecentAgentLoginSuccess(accountId, vpsId, mt5Login) {
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (!cmd) return false;
  const st = String(cmd.status || '').toLowerCase();
  if (!['success', 'done'].includes(st)) return false;
  const finished = cmd.finished_at ? new Date(cmd.finished_at).getTime() : 0;
  if (finished && Date.now() - finished > 15 * 60 * 1000) return false;
  const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
  const cmdLogin = String(res.login || cmd.payload?.mt5Login || '').trim();
  if (mt5Login && cmdLogin && cmdLogin !== String(mt5Login).trim()) return false;

  const sinceMs = await accountConnectSinceMs(accountId);
  const evidence = extractJournalEvidence(
    res.journalEvidence,
    res.journal_evidence,
    res.message,
    cmd.error
  );
  if (evidence && mt5Login) {
    const jv = parseMt5JournalOutcome(evidence, mt5Login, undefined, sinceMs);
    if (jv === 'failed') return false;
    if (jv === 'success') return true;
  }

  return false;
}

async function verifyPortRunningLogin(vpsId, portNo, mt5Login) {
  if (!vpsId || !portNo || !mt5Login) return { ok: false, reason: 'MISSING_PARAMS' };

  const metricsFast = await verifyPortMetricsLogin(vpsId, portNo, mt5Login, {
    requireLoginMatch: true
  }).catch(() => ({
    ok: false
  }));
  if (metricsFast.ok) {
    return { ok: true, source: metricsFast.source || 'port_health_metrics_fast' };
  }

  const r = await query(
    `
    SELECT running, mt5_login, payload, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      AND updated_at > NOW() - INTERVAL '3 minutes'
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [vpsId, portNo]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row || !row.running) return { ok: false, reason: 'PORT_NOT_RUNNING' };

  const login = String(mt5Login).trim();
  let reported = String(row.mt5_login || '').trim();
  if (!reported && row.payload) {
    const pl = typeof row.payload === 'object' ? row.payload : {};
    reported = String(pl.mt5_login || pl.mt5Login || '').trim();
  }
  if (reported && reported === login) {
    return { ok: true, source: 'port_health_login' };
  }

  return { ok: false, reason: 'LOGIN_MISMATCH', reported };
}

/**
 * ยืนยัน login จากผลคำสั่ง login_mt5 (ต้องมี journalEvidence)
 */
async function verifyLoginFromCommand({ accountId, vpsId, mt5Login, portNo }) {
  const login = String(mt5Login || '').trim();
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (!cmd) return { ok: false, reason: 'NO_COMMAND' };

  const st = String(cmd.status || '').toLowerCase();
  if (['failed', 'error'].includes(st)) {
    const sinceMs = await accountConnectSinceMs(accountId);
    const evidence = extractJournalEvidence(cmd.result?.journalEvidence, cmd.result?.journal_evidence, cmd.error, cmd.result?.message);
    if (evidence && login && parseMt5JournalOutcome(evidence, login, undefined, sinceMs) === 'failed') {
      return { ok: false, reason: 'JOURNAL_FAILED', journalEvidence: evidence };
    }
    return { ok: false, reason: 'COMMAND_NOT_SUCCESS', status: st };
  }
  const result = cmd.result || {};
  const cmdLogin = String(result.login || cmd.payload?.mt5Login || '').trim();
  if (login && cmdLogin && cmdLogin !== login) {
    return { ok: false, reason: 'LOGIN_MISMATCH' };
  }

  const evidence = extractJournalEvidence(
    result.journalEvidence,
    result.journal_evidence,
    result.message,
    cmd.error
  );
  if (evidence && login) {
    const cmdPortNo = Number(
      cmd.payload?.portNo || cmd.payload?.port_no || cmd.payload?.port || portNo || 0
    );
    const sinceMs = await journalSinceMsForVerify(accountId, vpsId, cmdPortNo);
    const v = parseJournalRelaxed(evidence, login, sinceMs);
    if (v === 'success') {
      return { ok: true, source: 'command_journal', journalEvidence: evidence };
    }
    if (v === 'failed') {
      return { ok: false, reason: 'JOURNAL_FAILED', journalEvidence: evidence };
    }
  }

  if (!['success', 'done'].includes(st)) {
    return { ok: false, reason: 'COMMAND_NOT_SUCCESS', status: st };
  }

  if (
    result.loginVerified === true ||
    result.login_verified === true ||
    result.journalVerified === true ||
    result.journal_verified === true ||
    String(result.status || '').toLowerCase() === 'connected'
  ) {
    if (!evidence || !login) {
      return { ok: false, reason: 'JOURNAL_REQUIRED' };
    }
    const cmdPortNo2 = Number(
      cmd.payload?.portNo || cmd.payload?.port_no || cmd.payload?.port || portNo || 0
    );
    const sinceMs2 = await journalSinceMsForVerify(accountId, vpsId, cmdPortNo2);
    const v2 = parseJournalRelaxed(evidence, login, sinceMs2);
    if (v2 === 'success') {
      return { ok: true, source: 'command_login_verified', journalEvidence: evidence };
    }
    if (v2 === 'failed') {
      return { ok: false, reason: 'JOURNAL_FAILED', journalEvidence: evidence };
    }
    return { ok: false, reason: 'JOURNAL_REQUIRED' };
  }

  return { ok: false, reason: 'JOURNAL_REQUIRED' };
}

function journalLogPathsForFolder(folderPath) {
  const base = String(folderPath || '').trim().replace(/[\\/]+$/, '');
  if (!base) return [];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const altBase = base.replace(/MT5_PORTS/gi, 'MT5_PORTs');
  const bases = [...new Set([base, altBase].filter(Boolean))];
  const paths = [];
  for (const b of bases) {
    paths.push(`${b}\\logs\\${today}.log`);
    paths.push(`${b}\\Logs\\${today}.log`);
  }
  return [...new Set(paths)];
}

function isLegacyWindowVerifiedMessage(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('window verified') ||
    m.includes('login success') ||
    m.includes('เห็นบัญชี') ||
    m.includes('หน้าต่าง mt5')
  );
}

async function cancelStuckJournalReads(vpsId, accountId) {
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: journal read timeout',
        finished_at=NOW(),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND (
        LOWER(COALESCE(status, '')) IN ('processing', 'picked', 'running')
        AND created_at < NOW() - INTERVAL '45 seconds'
      )
  `,
    [vpsId, String(accountId)]
  ).catch(() => {});
}

const JOURNAL_QUEUE_MIN_INTERVAL_SEC = Number(
  process.env.MT5_JOURNAL_QUEUE_MIN_INTERVAL_SEC || 10
);

/** เก็บ journal จาก connect-result ของ agent — poll ฝั่งเว็บยืนยันได้ทันที */
async function stashConnectJournalEvidence(accountId, journalBlob) {
  const j = String(journalBlob || '').trim();
  if (!j || !accountId) return;
  await query(
    `ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_journal_evidence TEXT`
  ).catch(() => {});
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET last_journal_evidence = $2, updated_at = NOW()
    WHERE id = $1
  `,
    [accountId, j.slice(0, 12000)]
  ).catch(() => {});
}

async function getStashedJournalEvidence(accountId) {
  const r = await query(
    `SELECT last_journal_evidence FROM vps_system.mt5_accounts WHERE id = $1 LIMIT 1`,
    [accountId]
  ).catch(() => ({ rows: [] }));
  return String(r.rows?.[0]?.last_journal_evidence || '').trim();
}

async function mergeConnectJournalToLoginCommand(accountId, vpsId, journalBlob) {
  const j = String(journalBlob || '').trim();
  if (!j || !accountId) return false;
  const params = [String(accountId), j.slice(0, 8000)];
  let nodeFilter = '';
  if (vpsId) {
    nodeFilter = ' AND (vps_id = $3 OR node_id = $3)';
    params.push(vpsId);
  }
  const r = await query(
    `
    UPDATE vps_system.vps_agent_commands c
    SET result = COALESCE(c.result, '{}'::jsonb) || jsonb_build_object('journalEvidence', $2::text),
        updated_at = NOW()
    FROM (
      SELECT id
      FROM vps_system.vps_agent_commands
      WHERE command_type IN ('login_mt5', 'connect_mt5')
        AND (payload->>'accountId')::text = $1::text
        AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
        ${nodeFilter}
      ORDER BY id DESC
      LIMIT 1
    ) pick
    WHERE c.id = pick.id
    RETURNING c.id
  `,
    params
  ).catch(() => ({ rows: [] }));
  return !!(r.rows && r.rows.length);
}

async function processInboundConnectJournal(accountId, vpsId, journalBlob) {
  const j = String(journalBlob || '').trim();
  if (!j || !accountId) return;
  await stashConnectJournalEvidence(accountId, j);
  await mergeConnectJournalToLoginCommand(accountId, vpsId, j);
}

const HARD_FAIL_REASONS = new Set([
  'login_cmd_failed',
  'login_cmd_journal_failed',
  'journal_not_verified',
  'journal_rejected_connected',
  'journal_rejected_fast',
  'journal_rejected_recover',
  'agent_reported_failed'
]);

async function hasLoginCommandInProgress(accountId, vpsId) {
  if (!accountId && !vpsId) return false;
  const params = [];
  const parts = [];
  if (accountId) {
    params.push(String(accountId));
    parts.push(`(payload->>'accountId')::text = $${params.length}::text`);
  }
  if (vpsId) {
    params.push(vpsId);
    parts.push(`(vps_id=$${params.length} OR node_id=$${params.length})`);
  }
  const r = await query(
    `
    SELECT 1
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND (${parts.join(' AND ')})
    LIMIT 1
  `,
    params
  ).catch(() => ({ rows: [] }));
  return !!(r.rows || []).length;
}

/** ปล่อย login_mt5 ที่ค้าง processing — กัน journal flood บล็อกคิวทั้ง VPS */
/** ยกเลิกคำสั่ง pending ที่ Agent ไม่มารับ (กันคิวค้างบล็อก login รอบใหม่) */
async function expireStalePendingAgentCommands(vpsId, maxSec = 180) {
  const nid = Number(vpsId || 0);
  if (!nid) return { cancelled: 0 };
  const r = await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error=COALESCE(error, 'cancelled: agent offline / not picked up'),
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND LOWER(COALESCE(status, '')) = 'pending'
      AND created_at < NOW() - ($2::text || ' seconds')::interval
    RETURNING id
  `,
    [nid, String(maxSec)]
  ).catch(() => ({ rows: [] }));
  return { cancelled: r.rows?.length || 0 };
}

async function cancelPendingLoginForAccount(accountId, vpsId) {
  if (!accountId) return;
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error=COALESCE(error, 'cancelled: connect timeout'),
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW()
    WHERE command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND (payload->>'accountId')::text = $1::text
      AND ($2::bigint IS NULL OR vps_id=$2 OR node_id=$2)
  `,
    [String(accountId), vpsId ? Number(vpsId) : null]
  ).catch(() => {});
}

async function expireStuckLoginCommands(vpsId, maxSec = 90) {
  const nid = Number(vpsId || 0);
  if (!nid) return { expired: 0, accountIds: [] };
  const r = await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='failed',
        error=COALESCE(error, 'auto-expired: login command stuck'),
        finished_at=NOW(),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(COALESCE(status, '')) IN ('processing', 'picked', 'running')
      AND finished_at IS NULL
      AND COALESCE(started_at, picked_at, locked_at, created_at)
          < NOW() - ($2::text || ' seconds')::interval
    RETURNING (payload->>'accountId')::text AS account_id
  `,
    [nid, String(maxSec)]
  ).catch(() => ({ rows: [] }));
  const accountIds = [...new Set((r.rows || []).map((row) => Number(row.account_id)).filter(Boolean))];
  return { expired: r.rows?.length || 0, accountIds };
}

async function cancelJournalVerifyForVps(vpsId) {
  const nid = Number(vpsId || 0);
  if (!nid) return;
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error=COALESCE(error, 'cancelled: login priority'),
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
  `,
    [nid]
  ).catch(() => {});
}

/** ยกเลิก journal verify ค้างของ port อื่น (กันคิว 20 port บล็อก login) */
async function cancelJournalVerifyWrongPort(vpsId, accountId, portNo) {
  if (!vpsId || !accountId || !portNo) return;
  const ports = systemPortNosForFail(portNo).map(String);
  if (!ports.length) return;
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: not target port',
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND NOT (
        COALESCE(
          NULLIF(TRIM(payload->>'port_no'), ''),
          NULLIF(TRIM(payload->>'port'), ''),
          NULLIF(TRIM(payload->>'portNumber'), ''),
          ''
        ) = ANY($3::text[])
      )
  `,
    [vpsId, String(accountId), ports]
  ).catch(() => {});
}

/** ยกเลิก journal verify เก่าเมื่อเริ่ม connect รอบใหม่ (กันอ่าน failed รอบก่อน) */
async function cancelJournalVerifyForAccount(vpsId, accountId) {
  if (!accountId) return;
  const params = [String(accountId)];
  let whereVps = '';
  if (vpsId) {
    whereVps = ' AND (vps_id=$2 OR node_id=$2)';
    params.push(vpsId);
  }
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: new login attempt',
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW()
    WHERE command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $1::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'failed', 'error')
      ${whereVps}
  `,
    params
  ).catch(() => {});
}

async function accountConnectSinceMs(accountId) {
  const r = await query(
    `
    SELECT connect_started_at, updated_at
    FROM vps_system.mt5_accounts
    WHERE id=$1 LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return 0;
  const t = row.connect_started_at || row.updated_at;
  return t ? new Date(t).getTime() : 0;
}

async function syncJournalFromLatestCommand(accountId, vpsId, login, folderPath, portNo) {
  let nodeId = vpsId;
  if (!nodeId) {
    const restored = await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => null);
    nodeId = restored?.vpsId || null;
  }
  const applied = await tryApplyPendingJournalRead(accountId, nodeId).catch(() => false);
  if (applied) return { applied: true, action: 'applied' };

  const journalSql = nodeId
    ? `
    SELECT result, payload, finished_at
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '20 minutes'
    ORDER BY id DESC
    LIMIT 1
  `
    : `
    SELECT result, payload, finished_at
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $1::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '20 minutes'
    ORDER BY id DESC
    LIMIT 1
  `;
  const journalParams = nodeId ? [nodeId, String(accountId)] : [String(accountId)];
  const r = await query(journalSql, journalParams).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) {
    const fp = folderPath;
    const loginBusy = await hasLoginCommandInProgress(accountId, nodeId);
    if (fp && login && nodeId) {
      await queueJournalReadVerify({
        accountId,
        vpsId: nodeId,
        folderPath: fp,
        mt5Login: login,
        portNo,
        allowDuringLogin: loginBusy
      }).catch(() => {});
    }
    return { applied: false, action: loginBusy ? 'login_in_progress_queued' : 'queued' };
  }

  const content = String(
    row.result?.journalEvidence || row.result?.journal_evidence || row.result?.content || ''
  ).trim();
  const sinceMs = await journalSinceMsForVerify(accountId, nodeId, portNo);
  let verdict = content && login ? parseJournalRelaxed(content, login, sinceMs) : null;
  if (verdict === 'success' || verdict === 'failed') {
    const ok = await applyJournalReadCommandResult({ id: nodeId }, row.payload || {}, row.result || {});
    return { applied: ok, action: verdict };
  }

  const finMs = row.finished_at ? new Date(row.finished_at).getTime() : 0;
  const loginBusy = await hasLoginCommandInProgress(accountId, nodeId);
  if (
    folderPath &&
    login &&
    finMs &&
    Date.now() - finMs > 30000 &&
    nodeId &&
    !loginBusy
  ) {
    await queueJournalReadVerify({ accountId, vpsId: nodeId, folderPath, mt5Login: login, portNo }).catch(() => {});
    return { applied: false, action: 'requeued' };
  }
  return { applied: false, action: loginBusy ? 'login_in_progress' : 'waiting' };
}

async function tryApplyPendingJournalRead(accountId, vpsId) {
  let nodeId = vpsId;
  if (!nodeId) {
    const restored = await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => null);
    nodeId = restored?.vpsId || null;
  }

  const sql = nodeId
    ? `
    SELECT result, payload, command_type, vps_id, node_id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '30 minutes'
    ORDER BY id DESC
    LIMIT 1
  `
    : `
    SELECT result, payload, command_type, vps_id, node_id
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $1::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '30 minutes'
    ORDER BY id DESC
    LIMIT 1
  `;
  const params = nodeId ? [nodeId, String(accountId)] : [String(accountId)];
  const r = await query(sql, params).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return false;
  const applyNodeId = nodeId || row.vps_id || row.node_id;
  return applyJournalReadCommandResult({ id: applyNodeId }, row.payload || {}, row.result || {});
}

async function queueJournalReadVerify({
  accountId,
  vpsId,
  folderPath,
  mt5Login,
  portNo,
  allowDuringLogin = false
}) {
  if (!accountId || !vpsId || !mt5Login) return false;

  if (!allowDuringLogin && (await hasLoginCommandInProgress(accountId, vpsId))) {
    return false;
  }

  await cancelStuckJournalReads(vpsId, accountId);
  if (portNo) {
    await cancelJournalVerifyWrongPort(vpsId, accountId, portNo).catch(() => {});
  }

  const recent = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND created_at > NOW() - ($3::text || ' seconds')::interval
    LIMIT 1
  `,
    [vpsId, String(accountId), String(JOURNAL_QUEUE_MIN_INTERVAL_SEC)]
  ).catch(() => ({ rows: [] }));
  if (recent.rows?.[0]) return false;

  const pending = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND created_at > NOW() - INTERVAL '5 minutes'
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  if (pending.rows?.[0]) return false;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const port = Number(portNo || 0);
  const login = String(mt5Login).trim();

  if (port && folderPath) {
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1, $1, 'port_read_file', $2::jsonb, 'pending', NOW(), NOW())
    `,
      [
        vpsId,
        JSON.stringify({
          port,
          portNumber: port,
          port_no: port,
          vpsFolderPath: folderPath,
          folder_path: folderPath,
          file_path: `logs\\${today}.log`,
          accountId,
          purpose: 'verify_mt5_journal',
          mt5Login: login
        })
      ]
    ).catch(() => {});
    return true;
  }

  const logPaths = journalLogPathsForFolder(folderPath);
  if (!logPaths.length) return false;

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'read_file', $2::jsonb, 'pending', NOW(), NOW())
  `,
    [
      vpsId,
      JSON.stringify({
        file_path: logPaths[0],
        file_paths: logPaths,
        accountId,
        purpose: 'verify_mt5_journal',
        mt5Login: login
      })
    ]
  ).catch(() => {});

  return true;
}

async function handleLegacyWindowVerifiedConnect({
  accountId,
  vpsId,
  portId,
  portNo,
  mt5Login,
  message,
  folderPath
}) {
  if (!isLegacyWindowVerifiedMessage(message)) return false;

  const login = String(mt5Login || '').trim();
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  const cmdOk = cmd && ['success', 'done'].includes(String(cmd.status || '').toLowerCase());
  if (!cmdOk) return false;

  if (folderPath) {
    await queueJournalReadVerify({ accountId, vpsId, folderPath, mt5Login: login }).catch(() => {});
  }

  const applied = await tryApplyPendingJournalRead(accountId, vpsId).catch(() => false);
  if (applied) return true;

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='checking', last_error=NULL,
        last_login_message='กำลังยืนยัน Login จาก MT5 Journal...', updated_at=NOW()
    WHERE id=$1
  `, [accountId]).catch(() => {});

  return 'pending';
}

async function accountLooksLoggedIn(accountId) {
  if (!accountId) return false;
  const r = await query(
    `
    SELECT status, last_equity, last_balance, updated_at
    FROM vps_system.mt5_accounts
    WHERE id=$1
    LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return false;
  const st = String(row.status || '').toLowerCase();
  const eq = Number(row.last_equity || 0);
  const bal = Number(row.last_balance || 0);
  return st === 'connected' && (eq > 50 || bal > 50);
}

/** ปิด MT5 เฉพาะเมื่อ login ล้มเหลวชัดเจน — ไม่ kill เมื่อบัญชี connected อยู่แล้ว */
async function shouldKillMt5OnFail(accountId, opts = {}, journalVerdict = null) {
  if (opts.killMt5 === false) return false;
  if (opts.killMt5 === true) return true;
  if (journalVerdict === 'failed') return true;

  const reason = String(opts.reason || '');
  // timeout ระหว่าง verify พบ false-positive บ่อย: ห้าม kill MT5 อัตโนมัติ
  if (reason === 'journal_verify_timeout') return false;

  const softReasons = new Set([
    'agent_reported_failed',
    'connect_result_other',
    'journal_not_verified',
    'journal_inconclusive',
    'journal_verify_timeout'
  ]);
  if (softReasons.has(reason) && (await accountLooksLoggedIn(accountId))) {
    return false;
  }
  return true;
}

async function queueStopMt5ForAccount(accountId, opts = {}) {
  const journalVerdict = opts.journalVerdict || null;
  if (!(await shouldKillMt5OnFail(accountId, opts, journalVerdict))) {
    console.warn('[mt5] skip stop_mt5 — account still looks connected', accountId, opts.reason);
    return false;
  }

  let vpsId = Number(opts.vpsId || 0);
  let portId = Number(opts.portId || 0);
  let portNo = Number(opts.portNo || opts.port_no || 0);
  let folderPath = String(opts.folderPath || opts.folder_path || '').trim();

  if (accountId && (!vpsId || !folderPath)) {
    const acc = await query(
      `
      SELECT a.vps_id, a.port_id, a.assigned_port_no, a.port_slot, p.folder_path
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE a.id=$1
      LIMIT 1
    `,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const row = acc.rows?.[0];
    if (row) {
      vpsId = vpsId || Number(row.vps_id || 0);
      portId = portId || Number(row.port_id || 0);
      portNo = portNo || Number(row.assigned_port_no || row.port_slot || 0);
      folderPath = folderPath || String(row.folder_path || '').trim();
    }
  }

  if (!vpsId) return false;

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: journal login failed',
        finished_at=NOW(),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='login_mt5'
      AND (payload->>'accountId')::text = $2::text
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
  `,
    [vpsId, String(accountId)]
  ).catch(() => {});

  const pl = {
    port: portNo || undefined,
    port_no: portNo || undefined,
    portNumber: portNo || undefined,
    folder_path: folderPath,
    folderPath,
    vpsFolderPath: folderPath,
    accountId,
    reason: opts.reason || 'journal_auth_failed'
  };

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW(), NOW())
  `,
    [vpsId, portId || null, JSON.stringify(pl)]
  ).catch(() => {});

  return true;
}

/** Login ผิด/ล้มเหลว — ปิด MT5 ทันที, ไม่ค้าง PORT แพ็กเกจ, เคลียร์ admin เป็น ว่าง */
async function failAccountFromJournal(accountId, portId, message, opts = {}) {
  const msg = message || MT5_FAIL_USER_MSG;
  const reason = String(opts.reason || '');
  if (HARD_FAIL_REASONS.has(reason)) {
    opts.killMt5 = opts.killMt5 !== false;
    opts.forceFailed = true;
  }
  if (reason === 'connect_poll_timeout') {
    opts.killMt5 = false;
    if (opts.agentOffline === true) {
      opts.preserveBinding = true;
    }
  }

  const accRes = await query(
    `
    SELECT a.vps_id, a.port_id, a.port_slot, a.assigned_port_no, a.windows_port_no,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1
    LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const acc = accRes.rows?.[0] || {};

  const vpsId = Number(opts.vpsId || acc.vps_id || 0);
  const effectivePortId = Number(portId || acc.port_id || 0);
  const portNo = Number(opts.portNo || acc.assigned_port_no || acc.windows_port_no || 0);
  const folderPath = String(opts.folderPath || acc.folder_path || '').trim();
  const adminPortNo = adminPortNoFromSystem(portNo);

  await cancelJournalVerifyForAccount(vpsId, accountId).catch(() => {});
  await expireStuckLoginCommands(vpsId, 1).catch(() => ({ expired: 0 }));
  if (opts.preserveBinding) {
    await cancelPendingLoginForAccount(accountId, vpsId).catch(() => {});
  }

  const killMt5 = await shouldKillMt5OnFail(accountId, opts, opts.journalVerdict || null);
  const forceFailed = opts.forceFailed === true;
  const clearPackagePort = opts.clearPackagePort === true;
  const pkgSlot = Number(acc.port_slot || 0);
  if (opts.preserveBinding) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='failed',
          last_error=$2,
          last_login_message=$2,
          port_slot=${clearPackagePort ? 'NULL' : 'port_slot'},
          updated_at=NOW()
      WHERE id=$1
    `,
      [accountId, msg]
    ).catch(() => {});
    if (effectivePortId) {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='available', locked_by_user_id=NULL, locked_until=NULL,
            last_error=$2, updated_at=NOW()
        WHERE id=$1
      `,
        [effectivePortId, msg]
      ).catch(() => {});
    }
    if (adminPortNo && vpsId) {
      const { setAdminAllocationStatus } = require('./adminVpsBridge');
      query(
        `
        SELECT n.id AS admin_node_id
        FROM vps_nodes n
        JOIN vps_system.vps_nodes sn
          ON UPPER(TRIM(COALESCE(sn.node_code, ''))) = UPPER(TRIM(COALESCE(n.node_name, '')))
        WHERE sn.id = $1
        LIMIT 1
      `,
        [vpsId]
      )
        .then((r) => {
          const aid = Number(r.rows?.[0]?.admin_node_id || 0);
          if (aid) return setAdminAllocationStatus(aid, adminPortNo, 'free');
        })
        .catch(() => {});
    }
    return;
  }
  if (killMt5) {
    await queueStopMt5ForAccount(accountId, {
      portId: effectivePortId,
      vpsId,
      portNo,
      folderPath,
      reason: opts.reason || 'login_failed',
      killMt5: true,
      journalVerdict: opts.journalVerdict || null
    }).catch(() => {});
    const stopSlot = adminPortNoFromSystem(portNo) || pkgSlot;
    if (vpsId && stopSlot) {
      await queueForceStopMt5(
        vpsId,
        stopSlot,
        folderPath,
        opts.reason || 'login_auth_failed'
      ).catch(() => {});
    }
  }

  const isLoginTimeout = reason === 'login_journal_timeout';
  const nextStatus = isLoginTimeout
    ? 'ready'
    : killMt5 || forceFailed
      ? 'failed'
      : 'checking';
  if (killMt5 || forceFailed) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status=$3,
          port_slot=${clearPackagePort ? 'NULL' : 'port_slot'},
          assigned_port_no=${clearPackagePort ? 'NULL' : 'assigned_port_no'},
          windows_port_no=${clearPackagePort ? 'NULL' : 'windows_port_no'},
          port_id=${clearPackagePort ? 'NULL' : 'port_id'},
          last_error=$2,
          last_login_message=$2,
          updated_at=NOW()
      WHERE id=$1
    `,
      [accountId, msg, nextStatus]
    ).catch(() => {});
    if (clearPackagePort && pkgSlot) {
      const uidRes = await query(
        `SELECT user_id FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const uid = Number(uidRes.rows?.[0]?.user_id || 0);
      if (uid) {
        await query(
          `
          UPDATE vps_system.mt5_accounts
          SET port_slot=NULL,
              assigned_port_no=NULL,
              windows_port_no=NULL,
              port_id=NULL,
              status='failed',
              last_error=$3,
              last_login_message=$3,
              updated_at=NOW()
          WHERE user_id=$1
            AND port_slot=$2
            AND LOWER(TRIM(COALESCE(status, ''))) IN (
              'connecting', 'checking', 'starting', 'failed', 'ready', 'cancelled'
            )
        `,
          [uid, pkgSlot, msg]
        ).catch(() => {});
        const { clearOtherAccountsOnPortSlot } = require('./mt5PortAccount');
        await clearOtherAccountsOnPortSlot(query, uid, pkgSlot, null).catch(() => {});
      }
    }
    if (clearPackagePort && vpsId) {
      const { adminNodeId } = await resolveSystemVpsId(vpsId);
      await releaseUserPortCompletely({
        systemVpsId: vpsId,
        adminNodeId,
        portNo: adminPortNo || pkgSlot,
        folderPath,
        portId: effectivePortId || null
      }).catch(() => {});
    }
  } else {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status=$3, last_error=$2, last_login_message=$2, updated_at=NOW()
      WHERE id=$1
    `,
      [accountId, msg, nextStatus]
    ).catch(() => {});
    return;
  }

  if (effectivePortId) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL,
          process_id=NULL, last_pid=NULL,
          mt5_login=NULL, current_mt5_login=NULL, last_error=$2, updated_at=NOW()
      WHERE id=$1
    `,
      [effectivePortId, msg]
    ).catch(() => {});
  } else if (vpsId && portNo) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL,
          process_id=NULL, last_pid=NULL,
          mt5_login=NULL, current_mt5_login=NULL, last_error=$2, updated_at=NOW()
      WHERE vps_id=$1 AND port_no = ANY($2::int[])
    `,
      [vpsId, systemPortNosForFail(portNo)]
    ).catch(() => {});
  }

  if (vpsId && portNo) {
    await clearPortHealthRunning(vpsId, portNo).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(vpsId);
    if (adminNodeId && adminPortNo) {
      await reconcilePortIdleWhenAgentFree(adminNodeId, adminPortNo, folderPath).catch(() => {});
      await setAdminAllocationStatus(adminNodeId, adminPortNo, 'free').catch(() => {});
    }
  }
}

function systemPortNosForFail(portNo) {
  const n = Number(portNo || 0);
  if (!n) return [];
  if (n >= 100) return [n];
  return [...new Set([n, 100 + n].filter((x) => x > 0))];
}

async function applyJournalReadCommandResult(node, payload, result) {
  const accountId = Number(payload?.accountId ?? 0);
  const login = String(payload?.mt5Login || '').trim();
  const content = String(
    result?.content || result?.journalEvidence || result?.journal_evidence || result?.text || ''
  ).trim();
  if (!accountId || !login || !content) return false;

  const acc = await query(
    `
    SELECT a.port_id, a.vps_id, a.assigned_port_no, a.port_slot, a.status, p.folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1 LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const accRow = acc.rows?.[0] || {};
  const portId = Number(accRow.port_id || 0);
  const portNo = accRow.assigned_port_no || accRow.port_slot || payload?.portNo;
  const sinceMs = await journalSinceMsForVerify(
    accountId,
    accRow.vps_id || node?.id,
    portNo
  );
  const verdict = parseJournalRelaxed(content, login, sinceMs);
  const accStatus = String(accRow.status || '').toLowerCase();
  if (!['connecting', 'starting', 'checking'].includes(accStatus) && verdict === 'failed') {
    return false;
  }

  if (verdict === 'failed') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
      vpsId: accRow.vps_id || node?.id,
      portNo: accRow.assigned_port_no || accRow.port_slot || payload?.portNo,
      folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || accRow.folder_path,
      reason: 'login_cmd_journal_failed',
      killMt5: true,
      clearPackagePort: true
    });
    return true;
  }
  if (verdict !== 'success') return false;

  await promoteAccountConnected({
    accountId,
    portId,
    mt5Login: login,
    message: MT5_SUCCESS_MSG
  });
  return true;
}

async function restoreAccountVpsBindingFromLatestLogin(accountId) {
  const r = await query(
    `
    SELECT payload
    FROM vps_system.vps_agent_commands
    WHERE command_type = 'login_mt5'
      AND (payload->>'accountId')::text = $1::text
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
    ORDER BY id DESC
    LIMIT 1
  `,
    [String(accountId)]
  ).catch(() => ({ rows: [] }));
  const p = r.rows?.[0]?.payload || {};
  const vpsId = Number(p.vpsId || p.nodeId || 0) || null;
  const portId = Number(p.portId || 0) || null;
  const portNo = Number(p.portNo || p.port_no || p.portNumber || p.port || 0) || null;
  if (!vpsId && !portId) return null;
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET
      vps_id = COALESCE(vps_id, $2),
      port_id = COALESCE(port_id, $3),
      assigned_port_no = COALESCE(assigned_port_no, $4),
      windows_port_no = COALESCE(windows_port_no, $4),
      port_slot = COALESCE(port_slot, $4),
      updated_at = NOW()
    WHERE id = $1
  `,
    [accountId, vpsId, portId, portNo]
  ).catch(() => {});
  return { vpsId, portId, portNo };
}

async function promoteAccountConnected({ accountId, portId, mt5Login, message, balance, equity }) {
  const msg = message || MT5_SUCCESS_MSG;
  const bal = positiveMoney(balance);
  const eq = positiveMoney(equity);
  await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => {});

  const accRes = await query(
    `
    SELECT a.vps_id, a.assigned_port_no, a.port_slot, a.port_id,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1 LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));

  const accRow = accRes.rows?.[0] || {};
  const effectivePortId = portId || Number(accRow.port_id || 0) || null;

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='connected', last_error=NULL, last_login_message=$2,
        last_balance=COALESCE($3::numeric, last_balance),
        last_equity=COALESCE($4::numeric, last_equity),
        updated_at=NOW()
    WHERE id=$1
  `, [accountId, msg, bal, eq]).catch(() => {});

  if (effectivePortId) {
    await query(`
      UPDATE vps_system.vps_ports
      SET status='running', mt5_login=$2, current_mt5_login=$2,
          locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
      WHERE id=$1
    `, [effectivePortId, mt5Login]).catch(() => {});
  }

  const acc = accRow;
  if (acc?.vps_id) {
    const portNo = Number(acc.assigned_port_no || acc.port_slot || 0);
    const folderPath = String(acc.folder_path || '').trim() || null;
    await upsertPortHealthRunning(acc.vps_id, portNo, folderPath, mt5Login).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(acc.vps_id);
    if (adminNodeId && portNo) {
      await setAdminAllocationStatus(adminNodeId, portNo, 'used').catch(() => {});
    }
  }
}

async function applyLoginMt5CommandFailed(node, payload, opts = {}) {
  const accountId = Number(payload?.accountId ?? payload?.account_id ?? 0);
  if (!accountId) return false;

  const login = String(payload?.mt5Login || payload?.mt5_login || opts.result?.login || '').trim();
  const result = opts.result && typeof opts.result === 'object' ? opts.result : {};
  const message = String(opts.message || result.message || '').trim();
  const evidence = extractJournalEvidence(
    result.journalEvidence,
    result.journal_evidence,
    result.message,
    message
  );

  const sinceMs = await accountConnectSinceMs(accountId);
  const resolved = resolveLoginFailUserMessage({
    login,
    sinceMs,
    evidence,
    rawMessage: message
  });
  const failMsg = resolved.message || MT5_LOGIN_TIMEOUT_MSG;
  const authFail = resolved.authFail === true;

  await failAccountFromJournal(accountId, Number(payload?.portId || payload?.port_id || 0), failMsg, {
    vpsId: node?.id,
    portNo: payload?.portNumber || payload?.port_no || payload?.port,
    folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath,
    reason: authFail ? 'agent_reported_failed' : 'login_journal_timeout',
    journalVerdict: resolved.journalVerdict || null,
    killMt5: true,
    clearPackagePort: authFail
  });
  return true;
}

async function applyLoginMt5FromCommandResult(node, payload, result) {
  const accountId = Number(payload?.accountId ?? payload?.account_id ?? 0);
  if (!accountId || !node?.id) return false;

  const mt5Login = String(result?.login || payload?.mt5Login || payload?.mt5_login || '').trim();
  const portNo = Number(payload?.portNo || payload?.port_no || payload?.portNumber || payload?.port || 0);
  const portId = Number(payload?.portId || payload?.port_id || 0);
  const resStatus = String(result?.status || '').toLowerCase();
  const agentVerified =
    result?.loginVerified === true ||
    result?.login_verified === true ||
    (resStatus === 'connected' && result?.journalVerified !== false);

  if (agentVerified && mt5Login) {
    await promoteAccountConnected({
      accountId,
      portId,
      mt5Login,
      message: MT5_SUCCESS_MSG,
      balance: positiveMoney(result?.balance),
      equity: positiveMoney(result?.equity)
    });
    await finishPendingLoginCommands(accountId, node.id);
    await cancelJournalVerifyForAccount(node.id, accountId).catch(() => {});
    return true;
  }

  const evidence = extractJournalEvidence(
    result?.journalEvidence,
    result?.journal_evidence,
    result?.message
  );
  let verified = false;
  if (evidence && mt5Login) {
    const sinceMs = await accountConnectSinceMs(accountId);
    const verdict = parseJournalRelaxed(evidence, mt5Login, sinceMs);
    if (verdict === 'failed') {
      const accRow = await query(
        `
        SELECT a.vps_id, a.assigned_port_no, a.port_slot, p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1 LIMIT 1
      `,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const ar = accRow.rows?.[0] || {};
      await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
        vpsId: node?.id || ar.vps_id,
        portNo: portNo || ar.assigned_port_no || ar.port_slot,
        folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || ar.folder_path
      });
      return true;
    }
    if (verdict === 'success') verified = true;
  }
  if (!verified) {
    const folderPath = payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || '';
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='checking', last_error=NULL,
          last_login_message='กำลังตรวจสอบ Login MT5 จาก Journal...', updated_at=NOW()
      WHERE id=$1 AND LOWER(COALESCE(status,'')) IN ('connecting','starting','checking')
    `, [accountId]).catch(() => {});
    await queueJournalReadVerify({
      accountId,
      vpsId: node.id,
      folderPath,
      mt5Login,
      portNo
    }).catch(() => {});
    const applied = await tryApplyPendingJournalRead(accountId, node.id).catch(() => false);
    if (applied) return true;
    return false;
  }

  await promoteAccountConnected({
    accountId,
    portId,
    mt5Login,
    message: MT5_SUCCESS_MSG,
    balance: positiveMoney(result?.balance),
    equity: positiveMoney(result?.equity)
  });
  return true;
}

/**
 * แก้สถานะค้าง checking/starting หลัง Agent เก่าส่ง connected แต่ไม่มี journal
 */
async function resolveStuckLoginAccount(account) {
  if (!account?.id) return { resolved: false };

  const accountId = Number(account.id);
  const vpsId = Number(account.vps_id || 0);
  const portId = Number(account.port_id || 0);
  const portNo = Number(account.assigned_port_no || account.port_no || 0);
  const login = String(account.mt5_login || '').trim();
  const status = String(account.status || '').toLowerCase();
  if (!['connecting', 'starting', 'checking'].includes(status)) {
    return { resolved: false };
  }

  const startedAt = account.connect_started_at
    ? new Date(account.connect_started_at).getTime()
    : account.updated_at
      ? new Date(account.updated_at).getTime()
      : 0;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

  const failFast = await tryFastJournalFail(account);
  if (failFast.resolved) return failFast;

  const expired = await expireStuckLoginCommands(vpsId, 150).catch(() => ({ expired: 0, accountIds: [] }));
  if (expired.accountIds?.includes(accountId)) {
    const recovered = await tryRecoverLoginFromPortHealth(account).catch(() => ({
      resolved: false
    }));
    if (recovered.resolved) return recovered;

    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
      vpsId,
      portNo,
      folderPath: account.folder_path || '',
      reason: 'login_cmd_stuck',
      killMt5: false
    }).catch(() => {});
    return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
  }

  const portRecover = await tryRecoverLoginFromPortHealth(account).catch(() => ({
    resolved: false
  }));
  if (portRecover.resolved) return portRecover;

  const folderPathEarly = account.folder_path || '';
  const journalSync = await syncJournalFromLatestCommand(
    accountId, vpsId, login, folderPathEarly, portNo
  ).catch(() => ({ applied: false }));
  if (journalSync.applied) {
    const stRow = await query(
      `SELECT status, last_login_message FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const stNow = String(stRow.rows?.[0]?.status || '').toLowerCase();
    if (stNow === 'failed') {
      return {
        resolved: true,
        status: 'failed',
        message: stRow.rows?.[0]?.last_login_message || MT5_FAIL_USER_MSG
      };
    }
    return { resolved: true, status: 'connected', source: 'journal_read' };
  }

  const sinceMs = await accountConnectSinceMs(accountId);

  if (elapsedSec >= 8 && !(await shouldDeferLoginJournalFail(account))) {
    const cmd = await findRecentLoginCommand(accountId, vpsId);
    if (cmd) {
      const st = String(cmd.status || '').toLowerCase();
      const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
      const evidence = extractJournalEvidence(res.journalEvidence, res.journal_evidence, res.message, cmd.error);
      if (
        evidence &&
        login &&
        parseMt5JournalOutcome(evidence, login, undefined, sinceMs) === 'failed'
      ) {
        await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
          vpsId, portNo, folderPath: folderPathEarly, reason: 'login_cmd_journal_failed'
        });
        return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
      }
      if (['failed', 'error'].includes(st)) {
        await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
          vpsId, portNo, folderPath: folderPathEarly, reason: 'login_cmd_failed'
        });
        return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
      }
    }
  }

  const fast = await tryFastConnectConfirm(account).catch(() => ({ resolved: false }));
  if (fast.resolved) return fast;

  if (elapsedSec >= 12) {
    const lateFail = await tryFastJournalFail(account);
    if (lateFail.resolved) return lateFail;
  }

  if (folderPathEarly && elapsedSec >= 1) {
    const appliedEarly = await tryApplyPendingJournalRead(accountId, vpsId).catch(() => false);
    if (appliedEarly) {
      const stEarly = await query(
        `SELECT status, last_login_message FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const stNowEarly = String(stEarly.rows?.[0]?.status || '').toLowerCase();
      if (stNowEarly === 'failed') {
        return {
          resolved: true,
          status: 'failed',
          message: stEarly.rows?.[0]?.last_login_message || MT5_FAIL_USER_MSG
        };
      }
      if (stNowEarly === 'connected') {
        const vEarly = await verifyLoginFromCommand({
          accountId,
          vpsId,
          mt5Login: login,
          portNo
        }).catch(() => ({ ok: false }));
        if (vEarly.ok) {
          return { resolved: true, status: 'connected', source: 'journal_read_early' };
        }
      }
    }
  }

  const cmdFailedProbe = await probeRecentLoginCommandFailed(account);
  if (cmdFailedProbe.failed) {
    await failAccountFromJournal(accountId, portId, cmdFailedProbe.message, {
      vpsId,
      portNo,
      folderPath: account.folder_path || '',
      reason: 'login_cmd_failed',
      killMt5: true,
      clearPackagePort: true
    }).catch(() => {});
    return { resolved: true, status: 'failed', message: cmdFailedProbe.message };
  }

  const verRowEarly = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const agentVerEarly = String(verRowEarly.rows?.[0]?.agent_version || '');
  const agentReadyEarly = hasJournalGateMarker(agentVerEarly);

  const cmdVerify = await verifyLoginFromCommand({
    accountId,
    vpsId,
    mt5Login: login,
    portNo
  }).catch(() => ({ ok: false }));

  if (cmdVerify.ok) {
    await promoteAccountConnected({
      accountId,
      portId,
      mt5Login: login,
      message: MT5_SUCCESS_MSG
    });
    return { resolved: true, status: 'connected', source: cmdVerify.source };
  }

  if (cmdVerify.reason === 'JOURNAL_FAILED') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG);
    return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
  }

  const verRow = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const agentVer = String(verRow.rows?.[0]?.agent_version || '');
  const agentReady = hasJournalGateMarker(agentVer);

  if (agentReady && /รีสตาร์ท|Restart-Service/i.test(String(account.last_login_message || ''))) {
    await query(`
      UPDATE vps_system.mt5_accounts
      SET last_login_message='กำลังตรวจสอบ Login MT5 จาก Journal...', last_error=NULL, updated_at=NOW()
      WHERE id=$1
    `, [accountId]).catch(() => {});
  }

  const folderPath = account.folder_path || '';
  const loginBusy = await hasLoginCommandInProgress(accountId, vpsId);
  if (folderPath && elapsedSec >= 8 && !loginBusy) {
    await queueJournalReadVerify({
      accountId, vpsId, folderPath, mt5Login: login, portNo
    }).catch(() => {});
  }
  const applied2 = await tryApplyPendingJournalRead(accountId, vpsId).catch(() => false);
  if (applied2) {
    const stRow2 = await query(
      `SELECT status, last_login_message FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const stNow2 = String(stRow2.rows?.[0]?.status || '').toLowerCase();
    if (stNow2 === 'failed') {
      return {
        resolved: true,
        status: 'failed',
        message: stRow2.rows?.[0]?.last_login_message || MT5_FAIL_USER_MSG
      };
    }
    const vAfterRead = await verifyLoginFromCommand({
      accountId,
      vpsId,
      mt5Login: login,
      portNo
    }).catch(() => ({ ok: false }));
    if (vAfterRead.ok) {
      return { resolved: true, status: 'connected', source: 'journal_read' };
    }
  }

  if (!agentReady) {
    await expireStuckMaintenanceCommands(vpsId).catch(() => {});
    const upgradeState = await getAgentUpgradeState(vpsId);

    if (elapsedSec >= 120) {
      const failMsg = messageForUpgradeState(upgradeState);
      await failAccountFromJournal(accountId, portId, failMsg, {
        vpsId,
        portNo,
        folderPath: account.folder_path || '',
        reason: 'connect_timeout'
      }).catch(() => {});
      return { resolved: true, status: 'failed', message: failMsg };
    }

    if (elapsedSec >= 25 && upgradeState !== 'ready') {
      const waitMsg = messageForUpgradeState(upgradeState);
      await query(`
        UPDATE vps_system.mt5_accounts
        SET last_login_message=$2, updated_at=NOW()
        WHERE id=$1 AND LOWER(COALESCE(status,'')) IN ('connecting','starting','checking')
      `, [accountId, waitMsg]).catch(() => {});
      return { resolved: false, message: waitMsg };
    }
  }

  if (agentReady && elapsedSec >= 12) {
    const inProg = await findLoginCommandInProgress(accountId, vpsId);
    const recent = await findRecentLoginCommand(accountId, vpsId);
    const recentSt = String(recent?.status || '').toLowerCase();
    if (!inProg && (!recent || recentSt === 'cancelled')) {
      const accRow = await query(
        `
        SELECT a.user_id, a.mt5_password, a.server_name, a.mt5_server, a.port_slot, p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1
        LIMIT 1
      `,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const ar = accRow.rows?.[0];
      if (ar?.mt5_password) {
        const payload = buildMt5LoginPayload({
          accountId,
          userId: ar.user_id,
          reservedPort: {
            vps_id: vpsId,
            port_id: portId,
            port_number: portNo,
            folder_path: account.folder_path || ar.folder_path
          },
          portSlot: account.port_slot || ar.port_slot,
          mt5Login: login,
          mt5Password: ar.mt5_password,
          serverName: ar.server_name || ar.mt5_server
        });
        await query(
          `
          INSERT INTO vps_system.vps_agent_commands
          (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
          VALUES ($1,$1,$2,'login_mt5',$3::jsonb,'pending',NOW(),NOW())
        `,
          [vpsId, portId, JSON.stringify(payload)]
        ).catch(() => {});
      }
    }
  }

  const readCount = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND status IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '10 minutes'
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  const readsDone = Number(readCount.rows?.[0]?.c || 0);

  if (elapsedSec >= 90 && cmdVerify.reason === 'JOURNAL_REQUIRED') {
    const winTitleLate = String(account.mt5_window_title || '').trim();
    if (winTitleLate && windowTitleConfirmsLogin(winTitleLate, login)) {
      const portRunLate = await verifyPortRunningLogin({
        vpsId,
        portNo,
        mt5Login: login
      }).catch(() => ({ ok: false }));
      if (portRunLate.ok) {
        return promoteConnected('window_title_late', MT5_SUCCESS_MSG);
      }
    }
    await failAccountFromJournal(accountId, portId, MT5_LOGIN_TIMEOUT_MSG, {
      vpsId,
      portNo,
      folderPath: account.folder_path || '',
      reason: 'login_journal_timeout',
      killMt5: true,
      clearPackagePort: false
    }).catch(() => {});
    return { resolved: true, status: 'failed', message: MT5_LOGIN_TIMEOUT_MSG };
  }

  return { resolved: false };
}

/** หลัง timeout — ปิด MT5 + ปล่อย Folder แต่คง PORT แพ็กเกจไว้ให้กดเชื่อมต่อซ้ำ */
async function releaseFolderForLoginRetry(userId, portSlot, opts = {}) {
  const uid = Number(userId || 0);
  const slot = Number(portSlot || 0);
  if (!uid || !slot) return { ok: false, message: 'missing user or port slot' };

  const msg = String(opts.message || MT5_LOGIN_TIMEOUT_MSG).trim() || MT5_LOGIN_TIMEOUT_MSG;
  const portNos = systemPortNosForFail(slot);
  const portList = portNos.length ? portNos : [slot, 100 + slot];

  const rows = await query(
    `
    SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.windows_port_no,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id=$1
      AND LOWER(TRIM(COALESCE(a.status, ''))) NOT IN ('deleted', 'expired', 'connected')
      AND (
        a.port_slot = $2
        OR a.assigned_port_no = ANY($3::int[])
        OR a.windows_port_no = ANY($3::int[])
      )
    ORDER BY a.updated_at DESC
    LIMIT 5
  `,
    [uid, slot, portList]
  ).catch(() => ({ rows: [] }));

  let folderPath = String(opts.folderPath || '').trim();
  const seenVps = new Set();

  for (const row of rows.rows || []) {
    if (!folderPath && row.folder_path) folderPath = String(row.folder_path).trim();
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='ready',
          last_error=$2,
          last_login_message=$2,
          updated_at=NOW()
      WHERE id=$1
    `,
      [row.id, msg]
    ).catch(() => {});
    if (row.vps_id) seenVps.add(Number(row.vps_id));
  }

  if (!folderPath) {
    folderPath = folderPathForPackageSlot({ node_name: 'VPS-WIN-01' }, slot);
  }

  for (const vpsId of seenVps) {
    const adminSlot = adminPortNoFromSystem(slot) || slot;
    await queueForceStopMt5(vpsId, adminSlot, folderPath, 'login_timeout_retry').catch(() => {});
    await clearPortHealthRunning(vpsId, adminSlot).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(vpsId).catch(() => ({ adminNodeId: 0 }));
    if (adminNodeId) {
      await reconcilePortIdleWhenAgentFree(adminNodeId, adminSlot, folderPath).catch(() => {});
      await setAdminAllocationStatus(adminNodeId, adminSlot, 'free').catch(() => {});
    }
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL,
          process_id=NULL, last_pid=NULL, mt5_login=NULL, current_mt5_login=NULL,
          last_error=$2, updated_at=NOW()
      WHERE vps_id=$1 AND port_no = ANY($3::int[])
    `,
      [vpsId, msg, portList]
    ).catch(() => {});
  }

  if (!seenVps.size) {
    const nodes = await query(
      `
      SELECT sn.id AS vps_id
      FROM vps_nodes n
      JOIN vps_system.vps_nodes sn
        ON UPPER(TRIM(COALESCE(sn.node_code, ''))) = UPPER(TRIM(COALESCE(n.node_name, '')))
      WHERE COALESCE(n.agent_enabled, TRUE)=TRUE
      ORDER BY n.id ASC
      LIMIT 1
    `
    ).catch(() => ({ rows: [] }));
    const vpsId = Number(nodes.rows?.[0]?.vps_id || 0);
    if (vpsId) {
      await queueForceStopMt5(vpsId, slot, folderPath, 'login_timeout_retry').catch(() => {});
      await clearPortHealthRunning(vpsId, slot).catch(() => {});
      const { adminNodeId } = await resolveSystemVpsId(vpsId).catch(() => ({ adminNodeId: 0 }));
      if (adminNodeId) {
        await setAdminAllocationStatus(adminNodeId, slot, 'free').catch(() => {});
      }
    }
  }

  return { ok: true, portSlot: slot, retry: true, message: msg };
}

/** ปล่อย PORT แพ็กเกจทั้งช่อง (port_slot + binding VPS) หลัง login ผิด */
async function releaseUserPackagePortSlot(userId, portSlot, opts = {}) {
  const uid = Number(userId || 0);
  const slot = Number(portSlot || 0);
  if (!uid || !slot) return { ok: false, message: 'missing user or port slot' };

  const msg = String(opts.message || MT5_FAIL_USER_MSG).trim() || MT5_FAIL_USER_MSG;
  const portNos = systemPortNosForFail(slot);

  const rows = await query(
    `
    SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.windows_port_no, a.status,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id=$1
      AND LOWER(TRIM(COALESCE(a.status, ''))) NOT IN ('deleted', 'expired')
      AND (
        a.port_slot = $2
        OR a.assigned_port_no = ANY($3::int[])
        OR a.windows_port_no = ANY($3::int[])
      )
    ORDER BY a.updated_at DESC
  `,
    [uid, slot, portNos.length ? portNos : [slot, 100 + slot]]
  ).catch(() => ({ rows: [] }));

  const seenVps = new Set();
  let folderPath = String(opts.folderPath || '').trim();

  for (const row of rows.rows || []) {
    if (!folderPath && row.folder_path) folderPath = String(row.folder_path).trim();
    await failAccountFromJournal(Number(row.id), Number(row.port_id || 0), msg, {
      vpsId: row.vps_id,
      portNo: row.assigned_port_no || row.windows_port_no || slot,
      folderPath: row.folder_path,
      reason: opts.reason || 'package_port_login_fail',
      killMt5: true,
      clearPackagePort: true,
      journalVerdict: 'failed',
      forceFailed: true
    }).catch(() => {});
    const vpsKey = Number(row.vps_id || 0);
    if (vpsKey) seenVps.add(vpsKey);
  }

  const { clearOtherAccountsOnPortSlot } = require('./mt5PortAccount');
  await clearOtherAccountsOnPortSlot(query, uid, slot, null).catch(() => {});

  const portList = portNos.length ? portNos : [slot, 100 + slot];
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET port_slot=NULL,
        assigned_port_no=NULL,
        windows_port_no=NULL,
        port_id=NULL,
        status='failed',
        last_error=$3,
        last_login_message=$3,
        updated_at=NOW()
    WHERE user_id=$1
      AND (
        port_slot=$2
        OR assigned_port_no = ANY($4::int[])
        OR windows_port_no = ANY($4::int[])
      )
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('connected', 'deleted', 'expired')
  `,
    [uid, slot, msg, portList]
  ).catch(() => {});

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET assigned_port_no=NULL,
        windows_port_no=NULL,
        port_id=NULL,
        updated_at=NOW()
    WHERE user_id=$1
      AND (
        assigned_port_no = ANY($2::int[])
        OR windows_port_no = ANY($2::int[])
      )
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('deleted', 'failed')
  `,
    [uid, portList]
  ).catch(() => {});

  for (const vpsId of seenVps) {
    const adminSlot = adminPortNoFromSystem(slot) || slot;
    if (!folderPath) {
      folderPath = folderPathForPackageSlot({ node_name: 'VPS-WIN-01' }, slot);
    }
    await queueForceStopMt5(vpsId, adminSlot, folderPath, 'package_port_login_fail').catch(() => {});
    await clearPortHealthRunning(vpsId, adminSlot).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(vpsId).catch(() => ({ adminNodeId: 0 }));
    await releaseUserPortCompletely({
      systemVpsId: vpsId,
      adminNodeId: adminNodeId || vpsId,
      portNo: adminSlot,
      folderPath
    }).catch(() => {});
  }

  if (!seenVps.size) {
    const nodes = await query(
      `
      SELECT sn.id AS vps_id
      FROM vps_nodes n
      JOIN vps_system.vps_nodes sn
        ON UPPER(TRIM(COALESCE(sn.node_code, ''))) = UPPER(TRIM(COALESCE(n.node_name, '')))
      WHERE COALESCE(n.agent_enabled, TRUE)=TRUE
      ORDER BY n.id ASC
      LIMIT 1
    `
    ).catch(() => ({ rows: [] }));
    const vpsId = Number(nodes.rows?.[0]?.vps_id || 0);
    if (vpsId) {
      if (!folderPath) {
        folderPath = folderPathForPackageSlot({ node_name: 'VPS-WIN-01' }, slot);
      }
      await queueForceStopMt5(vpsId, slot, folderPath, 'package_port_login_fail').catch(() => {});
      await clearPortHealthRunning(vpsId, slot).catch(() => {});
      const { adminNodeId } = await resolveSystemVpsId(vpsId).catch(() => ({ adminNodeId: 0 }));
      await releaseUserPortCompletely({
        systemVpsId: vpsId,
        adminNodeId: adminNodeId || vpsId,
        portNo: slot,
        folderPath
      }).catch(() => {});
    }
  }

  return { ok: true, portSlot: null, message: msg };
}

/** หลัง login ผิด — เคลียร์ PORT แพ็กเกจ + ปิด MT5 (เรียกซ้ำได้) */
async function ensureLoginFailPortReleased(accountId, opts = {}) {
  const id = Number(accountId || 0);
  if (!id) return { ok: false, message: 'missing accountId' };

  const accRes = await query(
    `
    SELECT a.id, a.user_id, a.vps_id, a.port_id, a.port_slot, a.assigned_port_no,
           a.windows_port_no, a.status, a.last_error,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1
    LIMIT 1
  `,
    [id]
  ).catch(() => ({ rows: [] }));
  const acc = accRes.rows?.[0];
  if (!acc) return { ok: false, message: 'account not found' };

  const slot = Number(acc.port_slot || opts.portSlot || acc.assigned_port_no || 0);
  if (acc.user_id && slot) {
    return releaseUserPackagePortSlot(acc.user_id, slot, {
      message: opts.message || acc.last_error,
      reason: opts.reason || 'login_auth_failed_cleanup',
      folderPath: opts.folderPath || acc.folder_path,
      portSlot: slot
    });
  }

  const msg = String(opts.message || acc.last_error || MT5_FAIL_USER_MSG).trim() || MT5_FAIL_USER_MSG;
  await failAccountFromJournal(id, Number(acc.port_id || 0), msg, {
    vpsId: acc.vps_id,
    portNo: acc.assigned_port_no || acc.windows_port_no,
    folderPath: acc.folder_path,
    reason: opts.reason || 'login_auth_failed_cleanup',
    killMt5: true,
    clearPackagePort: true,
    journalVerdict: 'failed',
    forceFailed: true
  }).catch(() => {});

  return { ok: true, portSlot: null, message: msg };
}

/** เคลียร์ PORT แพ็กเกจที่ค้างจาก login ผิดก่อนหน้า */
async function repairFailedAccountsHoldingSlots(userId) {
  if (!userId) return;
  const rows = await query(
    `
    SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.windows_port_no,
           a.last_error, COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id=$1
      AND a.port_slot IS NOT NULL
      AND LOWER(TRIM(COALESCE(a.status, ''))) = 'failed'
  `,
    [userId]
  ).catch(() => ({ rows: [] }));

  const slots = new Set();
  for (const row of rows.rows || []) {
    const s = Number(
      row.port_slot || adminPortNoFromSystem(row.assigned_port_no || row.windows_port_no) || 0
    );
    if (s) slots.add(s);
  }
  for (const slot of slots) {
    await releaseUserPackagePortSlot(userId, slot, {
      message: MT5_FAIL_USER_MSG,
      reason: 'repair_failed_slot'
    }).catch(() => {});
  }
}

module.exports = {
  findRecentLoginCommand,
  findLoginCommandInProgress,
  extractJournalEvidence,
  verifyPortRunningLogin,
  verifyPortMetricsLogin,
  hasRecentAccountMetrics,
  hasRecentAgentLoginSuccess,
  verifyLoginFromCommand,
  applyLoginMt5FromCommandResult,
  applyLoginMt5CommandFailed,
  applyJournalReadCommandResult,
  queueJournalReadVerify,
  tryApplyPendingJournalRead,
  syncJournalFromLatestCommand,
  handleLegacyWindowVerifiedConnect,
  isLegacyWindowVerifiedMessage,
  promoteAccountConnected,
  restoreAccountVpsBindingFromLatestLogin,
  queueStopMt5ForAccount,
  failAccountFromJournal,
  ensureLoginFailPortReleased,
  releaseUserPackagePortSlot,
  releaseFolderForLoginRetry,
  repairFailedAccountsHoldingSlots,
  resolveStuckLoginAccount,
  tryFastConnectConfirm,
  tryRecoverLoginFromPortHealth,
  tryRecoverReadyAccount,
  reconcileConnectedAccountLive,
  tryFastJournalFail,
  findJournalFailFast,
  parseJournalRelaxed,
  finishPendingLoginCommands,
  cancelJournalVerifyForAccount,
  cancelJournalVerifyWrongPort,
  cancelJournalVerifyForVps,
  expireStuckLoginCommands,
  expireStalePendingAgentCommands,
  cancelPendingLoginForAccount,
  hasLoginCommandInProgress,
  accountConnectSinceMs,
  journalSinceMsForVerify,
  isAccountLoginJournalVerified,
  probeRecentLoginCommandFailed,
  processInboundConnectJournal,
  stashConnectJournalEvidence,
  mergeConnectJournalToLoginCommand
};
