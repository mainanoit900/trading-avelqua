'use strict';

const { query } = require('../config/database');
const {
  parseMt5JournalOutcome,
  parseMt5JournalServerAuthFailure,
  parseMt5JournalForeignLogin,
  MT5_SUCCESS_MSG,
  MT5_FAIL_USER_MSG
} = require('./mt5JournalVerify');
const {
  hasJournalGateMarker,
  messageForUpgradeState,
  getAgentUpgradeState,
  expireStuckMaintenanceCommands
} = require('./agentDeploy');
const { buildMt5LoginPayload } = require('./adminVpsPortPicker');
const { clearVpsPortPromotionBlockers } = require('./mt5PortSlotGuard');
const {
  resolveSystemVpsId,
  setAdminAllocationStatus,
  upsertPortHealthRunning,
  clearPortHealthRunning,
  adminPortNoFromSystem,
  reconcilePortIdleWhenAgentFree
} = require('./adminVpsBridge');

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
    SELECT id, status, result, finished_at, payload
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='login_mt5'
      AND (payload->>'accountId')::text = $2::text
      AND finished_at > NOW() - INTERVAL '3 hours'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function accountConnectSinceMs(accountId) {
  if (!accountId) return 0;
  const r = await query(
    `
    SELECT connect_started_at, updated_at
    FROM vps_system.mt5_accounts
    WHERE id=$1
    LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return 0;
  const t = row.connect_started_at || row.updated_at;
  return t ? new Date(t).getTime() : 0;
}

function isCurrentConnectAttempt(finishedAt, sinceMs, slackMs = 5000) {
  const finMs = finishedAt ? new Date(finishedAt).getTime() : 0;
  if (!finMs || !sinceMs) return true;
  return finMs >= (sinceMs - slackMs);
}

function extractJournalEvidence(...sources) {
  for (const src of sources) {
    const text = String(src || '').trim();
    if (!text) continue;
    if (text.length >= 40 && /authorized on|authorization on/i.test(text)) {
      return text.slice(0, 8000);
    }
  }
  return '';
}

function reportedLoginFromPortHealthRow(row) {
  if (!row) return '';
  let reported = String(row.mt5_login || '').trim();
  if (!reported && row.payload) {
    const pl = typeof row.payload === 'object' ? row.payload : {};
    reported = String(pl.mt5_login || pl.mt5Login || '').trim();
  }
  return reported;
}

async function readLatestPortHealth(vpsId, portNo, maxAgeMinutes = null) {
  if (!vpsId || !portNo) return null;
  const params = [Number(vpsId), Number(portNo)];
  let ageSql = '';
  if (maxAgeMinutes != null && Number(maxAgeMinutes) > 0) {
    ageSql = ` AND updated_at > NOW() - ($3::text || ' minutes')::interval`;
    params.push(String(maxAgeMinutes));
  }
  const r = await query(
    `
    SELECT running, mt5_login, payload, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      ${ageSql}
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    params
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function detectPortHealthLoginMismatch(vpsId, portNo, expectedLogin, sinceMs = 0) {
  const expected = String(expectedLogin || '').trim();
  if (!vpsId || !portNo || !expected) return null;
  const row = await readLatestPortHealth(vpsId, portNo, null);
  if (!row?.running) return null;
  if (sinceMs > 0 && row.updated_at) {
    const rowMs = new Date(row.updated_at).getTime();
    if (rowMs < sinceMs) return null;
  }
  const reported = reportedLoginFromPortHealthRow(row);
  if (reported && reported !== expected) return reported;
  return null;
}

async function verifyPortRunningLogin(vpsId, portNo, mt5Login) {
  if (!vpsId || !portNo || !mt5Login) return { ok: false, reason: 'MISSING_PARAMS' };

  const row = await readLatestPortHealth(vpsId, portNo, 3);
  if (!row || !row.running) return { ok: false, reason: 'PORT_NOT_RUNNING' };

  const login = String(mt5Login).trim();
  const reported = reportedLoginFromPortHealthRow(row);
  if (reported && reported === login) {
    return { ok: true, source: 'port_health_login' };
  }

  return { ok: false, reason: 'LOGIN_MISMATCH', reported };
}

function equityFetchLoginConflict(expectedLogin, reportedLogin) {
  const expected = String(expectedLogin || '').trim();
  const reported = String(reportedLogin || '').trim();
  return Boolean(reported && expected && reported !== expected);
}

function attemptWindowProofOk(attempt, expectedLogin) {
  if (!attempt) return false;
  const expected = String(expectedLogin || '').trim();
  const title = String(attempt.window_title || '');
  if (detectWindowTitleLoginMismatch(title, expected)) return false;
  if (attempt.port_health_verified === true) {
    const phLogin = String(attempt.port_health_login || '').trim();
    if (phLogin && phLogin === expected) return true;
  }
  if (attempt.snapshot_verified === true) {
    const observed = String(attempt.observed_login || '').trim();
    if (observed && observed === expected) return true;
  }
  const observed = String(attempt.observed_login || '').trim();
  if (expected && observed && observed === expected) return true;
  return Boolean(expected && title && title.includes(expected));
}

function payloadPortNo(payload = {}) {
  const pl = payload && typeof payload === 'object' ? payload : {};
  for (const key of ['port', 'portNumber', 'port_no', 'portNo', 'folderPort', 'vpsPortNumber']) {
    const n = Number(pl[key] || 0);
    if (n > 0) return n;
  }
  return 0;
}

async function verifyInflightLoginOnPort(vpsId, portNo, mt5Login, attempt = null) {
  const accountId = Number(attempt?.account_id || 0);
  if (!vpsId || !portNo || !accountId) return null;

  const r = await query(
    `
    SELECT id, status, payload, result
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(COALESCE(status, '')) IN ('processing', 'picked', 'running')
      AND COALESCE(payload->>'accountId', '') = $2
      AND created_at > NOW() - INTERVAL '20 minutes'
    ORDER BY id DESC
    LIMIT 1
  `,
    [Number(vpsId), String(accountId)]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row) return null;
  if (payloadPortNo(row.payload || {}) !== Number(portNo)) return null;

  const login = String(mt5Login || '').trim();
  const pl = row.payload || {};
  const cmdLogin = String(pl.mt5Login || pl.mt5_login || pl.login || '').trim();
  if (login && cmdLogin && cmdLogin !== login) return null;

  const res = row.result && typeof row.result === 'object' ? row.result : {};
  if (res.windowVerified === true || res.window_verified === true || res.loginVerified === true) {
    return { ok: true, source: 'login_command_window', commandId: row.id };
  }
  return { ok: false, reason: 'LOGIN_INFLIGHT', commandId: row.id };
}

async function hasInflightLoginCommand(attempt) {
  const accountId = Number(attempt?.account_id || 0);
  const vpsId = Number(attempt?.vps_id || 0);
  if (!accountId || !vpsId) return false;
  const r = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running')
      AND (
        COALESCE(payload->>'accountId', '') = $2
        OR COALESCE(payload->>'account_id', '') = $2
      )
      AND created_at > NOW() - INTERVAL '20 minutes'
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  return Boolean(r.rows?.[0]);
}

/** Port running; block only when health reports a different login (unknown login is OK). */
async function getSuccessfulLoginCommandForAttempt(attempt) {
  if (!attempt?.vps_id || !attempt?.attempt_id) return null;
  const r = await query(
    `
    SELECT id, status, result, payload, finished_at
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND COALESCE(payload->>'attemptId', '') = $2
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
    ORDER BY id DESC
    LIMIT 1
  `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

function loginCommandJournalVerified(result, expectedLogin) {
  if (!result || typeof result !== 'object') return false;
  const login = String(expectedLogin || result.login || '').trim();
  if (result.journalVerified === true || result.journal_verified === true) {
    return Boolean(login);
  }
  const evidence = extractJournalEvidence(
    result.journalEvidence,
    result.journal_evidence,
    result.message
  );
  if (evidence && login) {
    const verdict = parseMt5JournalOutcome(evidence, login);
    if (verdict === 'success') return true;
    if (verdict === 'failed') return false;
  }
  if (result.loginVerified === true || result.login_verified === true) {
    return Boolean(login);
  }
  return false;
}

function detectWindowTitleLoginMismatch(title, expectedLogin) {
  const expected = String(expectedLogin || '').trim();
  const t = String(title || '').trim();
  if (!expected || !t) return null;
  const segments = t.split('|').map((s) => s.trim()).filter(Boolean);
  for (const seg of segments.length ? segments : [t]) {
    const m = seg.match(/^(\d{6,10})\s*[-:]/);
    if (m && m[1] && m[1] !== expected) return m[1];
  }
  return null;
}

/** Login command truly verified — verificationPending alone is not enough (stale MT5 session). */
function loginCommandResultVerified(result, expectedLogin = '') {
  if (!result || typeof result !== 'object') return false;
  const login = String(expectedLogin || result.login || '').trim();
  if (loginCommandJournalVerified(result, login)) return true;
  if (result.loginVerified === true || result.login_verified === true) return true;
  const title = String(result.windowTitle || result.window_title || '');
  if (detectWindowTitleLoginMismatch(title, login)) return false;
  if (result.windowVerified === true || result.window_verified === true) {
    return Boolean(login && title && title.includes(login));
  }
  return false;
}

function loginCommandHasLoginProof(result, expectedLogin = '') {
  return loginCommandResultVerified(result, expectedLogin);
}

async function verifyPortRunningForEquityFetch(vpsId, portNo, mt5Login, attempt = null) {
  if (!vpsId || !portNo || !mt5Login) return { ok: false, reason: 'MISSING_PARAMS' };

  const login = String(mt5Login).trim();

  const loginCmd = attempt ? await getSuccessfulLoginCommandForAttempt(attempt).catch(() => null) : null;
  if (loginCmd?.result && loginCommandResultVerified(loginCmd.result, login)) {
    return { ok: true, source: 'login_command_success' };
  }

  if (attemptWindowProofOk(attempt, login)) {
    return { ok: true, source: 'attempt_window_proof' };
  }

  const inflight = await verifyInflightLoginOnPort(vpsId, portNo, login, attempt);
  if (inflight?.ok) return inflight;
  if (inflight?.reason === 'LOGIN_INFLIGHT') {
    return { ok: false, reason: 'LOGIN_INFLIGHT', commandId: inflight.commandId };
  }

  const healthWindowMin = attempt ? 12 : 3;
  const r = await query(
    `
    SELECT running, mt5_login, payload, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      AND updated_at > NOW() - ($3::text || ' minutes')::interval
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [vpsId, portNo, String(healthWindowMin)]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (row?.running) {
    let reported = String(row.mt5_login || '').trim();
    if (!reported && row.payload) {
      const pl = typeof row.payload === 'object' ? row.payload : {};
      reported = String(pl.mt5_login || pl.mt5Login || '').trim();
    }
    if (equityFetchLoginConflict(login, reported) && !attemptWindowProofOk(attempt, login)) {
      if (loginCmd && loginCommandJournalVerified(loginCmd.result, login)) {
        return { ok: true, source: 'login_command_journal_stale_health' };
      }
      return { ok: false, reason: 'LOGIN_MISMATCH', reported };
    }
    if (reported && reported === login) {
      return { ok: true, source: 'port_health_login', reported };
    }
    if (attempt?.journal_verified) {
      return { ok: true, source: 'attempt_journal_verified' };
    }
    return { ok: false, reason: reported ? 'LOGIN_MISMATCH' : 'LOGIN_NOT_VERIFIED' };
  }

  return { ok: false, reason: 'PORT_NOT_RUNNING' };
}

/**
 * ยืนยัน login จากผลคำสั่ง login_mt5 (ต้องมี journalEvidence)
 */
async function verifyLoginFromCommand({ accountId, vpsId, mt5Login, portNo }) {
  const login = String(mt5Login || '').trim();
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (!cmd) return { ok: false, reason: 'NO_COMMAND' };
  const sinceMs = await accountConnectSinceMs(accountId);
  if (!isCurrentConnectAttempt(cmd.finished_at, sinceMs)) {
    return { ok: false, reason: 'STALE_COMMAND' };
  }

  const st = String(cmd.status || '').toLowerCase();
  if (!['success', 'done'].includes(st)) {
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
    result.message
  );
  if (evidence && login) {
    const verdict = parseMt5JournalOutcome(evidence, login);
    if (verdict === 'success') {
      return { ok: true, source: 'command_journal', journalEvidence: evidence };
    }
    if (verdict === 'failed') {
      return { ok: false, reason: 'JOURNAL_FAILED', journalEvidence: evidence };
    }
  }

  if (loginCommandHasLoginProof(result, login)) {
    return { ok: true, source: 'command_window_pending' };
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
    if (fp && login && nodeId) {
      await queueJournalReadVerify({ accountId, vpsId: nodeId, folderPath: fp, mt5Login: login, portNo }).catch(() => {});
    }
    return { applied: false, action: 'queued' };
  }

  const sinceMs = await accountConnectSinceMs(accountId);
  if (!isCurrentConnectAttempt(row.finished_at, sinceMs)) {
    if (folderPath && login && nodeId) {
      await queueJournalReadVerify({ accountId, vpsId: nodeId, folderPath, mt5Login: login, portNo }).catch(() => {});
    }
    return { applied: false, action: 'stale_ignored' };
  }

  const content = String(
    row.result?.journalEvidence || row.result?.journal_evidence || row.result?.content || ''
  ).trim();
  let verdict = content && login ? parseMt5JournalOutcome(content, login, undefined, sinceMs) : null;
  if (!verdict && content) {
    verdict = parseMt5JournalServerAuthFailure(content, undefined, sinceMs);
  }
  if (verdict === 'success' || verdict === 'failed') {
    const ok = await applyJournalReadCommandResult({ id: nodeId }, row.payload || {}, row.result || {});
    return { applied: ok, action: verdict };
  }

  const finMs = row.finished_at ? new Date(row.finished_at).getTime() : 0;
  if (folderPath && login && finMs && Date.now() - finMs > 6000 && nodeId) {
    await queueJournalReadVerify({ accountId, vpsId: nodeId, folderPath, mt5Login: login, portNo }).catch(() => {});
    return { applied: false, action: 'requeued' };
  }
  return { applied: false, action: 'waiting' };
}

async function tryApplyPendingJournalRead(accountId, vpsId) {
  let nodeId = vpsId;
  if (!nodeId) {
    const restored = await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => null);
    nodeId = restored?.vpsId || null;
  }

  const sql = nodeId
    ? `
    SELECT result, payload, command_type, vps_id, node_id, finished_at
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '15 minutes'
    ORDER BY id DESC
    LIMIT 1
  `
    : `
    SELECT result, payload, command_type, vps_id, node_id, finished_at
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $1::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '15 minutes'
    ORDER BY id DESC
    LIMIT 1
  `;
  const params = nodeId ? [nodeId, String(accountId)] : [String(accountId)];
  const r = await query(sql, params).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return false;
  const sinceMs = await accountConnectSinceMs(accountId);
  if (!isCurrentConnectAttempt(row.result?.finished_at || row.finished_at, sinceMs)) return false;
  const applyNodeId = nodeId || row.vps_id || row.node_id;
  return applyJournalReadCommandResult({ id: applyNodeId }, row.payload || {}, row.result || {});
}

async function queueJournalReadVerify({ accountId, vpsId, folderPath, mt5Login, portNo }) {
  if (!accountId || !vpsId || !mt5Login) return false;

  await cancelStuckJournalReads(vpsId, accountId);

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

  const recentDone = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '12 seconds'
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  if (recentDone.rows?.[0]) return false;

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

async function queueStopMt5ForAccount(accountId, opts = {}) {
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

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: login failed before run',
        finished_at=NOW(),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('run_mt5_bot', 'run_mt5')
      AND (payload->>'accountId')::text = $2::text
      AND LOWER(COALESCE(status, '')) = 'pending'
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

  // dedup: skip if there's already a pending/processing stop_mt5 for this port in the last 60s
  if (portNo) {
    const existing = await query(
      `SELECT id FROM vps_system.vps_agent_commands
       WHERE (vps_id=$1 OR node_id=$1)
         AND command_type='stop_mt5'
         AND (payload->>'port')::text = $2::text
         AND LOWER(COALESCE(status,'')) IN ('pending','processing','picked','running')
         AND created_at > NOW() - INTERVAL '60 seconds'
       LIMIT 1`,
      [vpsId, String(portNo)]
    ).catch(() => ({ rows: [] }));
    if (existing.rows?.length) return true;
  }

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
  const removedGuard = await query(
    `
    SELECT LOWER(COALESCE(status, '')) AS status
    FROM vps_system.mt5_accounts
    WHERE id = $1
    LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const removedSt = String(removedGuard.rows?.[0]?.status || '').trim();
  if (removedSt === 'deleted' || removedSt === 'cancelled' || removedSt === 'expired') {
    return;
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

  await queueStopMt5ForAccount(accountId, {
    portId: effectivePortId,
    vpsId,
    portNo,
    folderPath,
    reason: opts.reason || 'login_failed'
  }).catch(() => {});

  const preservePortSlot = opts.preservePortSlot === true || clean(opts.purposeType).toLowerCase() === 'bot_run';
  const accMeta = await query(
    `SELECT login_verified, metrics_ready, last_equity, last_balance, port_slot FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const hadVerifiedMetrics =
    preservePortSlot &&
    (accMeta.rows?.[0]?.login_verified === true || accMeta.rows?.[0]?.metrics_ready === true) &&
    (accMeta.rows?.[0]?.last_equity != null || accMeta.rows?.[0]?.last_balance != null);

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status=$3,
        last_error=$2,
        last_login_message=$2,
        port_slot=CASE WHEN $4 THEN port_slot ELSE NULL END,
        vps_id=CASE WHEN $4 THEN vps_id ELSE NULL END,
        port_id=CASE WHEN $4 THEN port_id ELSE NULL END,
        assigned_port_no=CASE WHEN $4 THEN assigned_port_no ELSE NULL END,
        windows_port_no=CASE WHEN $4 THEN windows_port_no ELSE NULL END,
        updated_at=NOW()
    WHERE id=$1
  `,
    [accountId, msg, hadVerifiedMetrics ? 'connected' : 'failed', preservePortSlot]
  ).catch(() => {});

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
      await reconcilePortIdleWhenAgentFree(adminNodeId, adminPortNo, folderPath, {
        accountId,
        forceRelease: true
      }).catch(() => {});
      await setAdminAllocationStatus(adminNodeId, adminPortNo, 'free').catch(() => {});
    }
  }

  await query(
    `
    UPDATE vps_system.mt5_connect_attempts
    SET status='failed',
        terminal=TRUE,
        login_verified=FALSE,
        last_message=$2,
        last_error=$2,
        finished_at=COALESCE(finished_at, NOW()),
        updated_at=NOW()
    WHERE account_id=$1
      AND (terminal IS NULL OR terminal = FALSE)
      AND LOWER(COALESCE(status, '')) IN ('connecting', 'starting', 'checking')
  `,
    [accountId, msg]
  ).catch(() => {});
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

  const sinceMs = await accountConnectSinceMs(accountId).catch(() => 0);
  let verdict = content && login ? parseMt5JournalOutcome(content, login, undefined, sinceMs) : null;
  if (!verdict && content) {
    verdict = parseMt5JournalServerAuthFailure(content, undefined, sinceMs);
  }
  const acc = await query(
    `
    SELECT a.port_id, a.vps_id, a.assigned_port_no, a.port_slot, p.folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1 LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const accRow = acc.rows?.[0] || {};
  const portId = Number(accRow.port_id || 0);

  const foreignLogin = content ? parseMt5JournalForeignLogin(content, login, undefined, sinceMs) : null;
  if (foreignLogin) {
    const foreignMsg = `เชื่อมต่อไม่สำเร็จ — พบบัญชี ${foreignLogin} ค้างบน PORT (กรอก ${login})`;
    await failAccountFromJournal(accountId, portId, foreignMsg, {
      vpsId: accRow.vps_id || node?.id,
      portNo: accRow.assigned_port_no || accRow.port_slot || payload?.portNo,
      folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || accRow.folder_path,
      reason: 'journal_foreign_login'
    });
    return true;
  }

  if (verdict === 'failed') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
      vpsId: accRow.vps_id || node?.id,
      portNo: accRow.assigned_port_no || accRow.port_slot || payload?.portNo,
      folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || accRow.folder_path
    });
    return true;
  }
  if (verdict !== 'success') return false;

  await promoteAccountConnected({
    accountId,
    portId,
    mt5Login: login,
    message: 'Journal ยืนยันแล้ว — กำลังดึง Equity...',
    requireMetrics: true
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
  const portSlot = Number(p.portSlot || p.port_slot || 0) || null;
  if (!vpsId && !portId) return null;
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET
      vps_id = COALESCE(vps_id, $2),
      port_id = COALESCE(port_id, $3),
      assigned_port_no = COALESCE(assigned_port_no, $4),
      windows_port_no = COALESCE(windows_port_no, $4),
      port_slot = COALESCE(port_slot, $5),
      updated_at = NOW()
    WHERE id = $1
  `,
    [accountId, vpsId, portId, portNo, portSlot]
  ).catch(() => {});
  return { vpsId, portId, portNo, portSlot };
}

async function promoteAccountConnected({
  accountId,
  portId,
  mt5Login,
  message,
  lockPortAfterLogin = false,
  userId = null,
  balance = null,
  equity = null,
  requireMetrics = false,
  skipVpsRestore = false
}) {
  const msg = message || MT5_SUCCESS_MSG;
  const bal = balance != null && balance !== '' ? Number(balance) : null;
  const eq = equity != null && equity !== '' ? Number(equity) : null;
  const hasMetrics =
    (Number.isFinite(bal) && bal >= 0) || (Number.isFinite(eq) && eq >= 0);
  const accountStatus = requireMetrics && !hasMetrics ? 'checking' : 'connected';
  const accountMsg =
    requireMetrics && !hasMetrics ? 'กำลังดึง Equity จาก MT5...' : msg;
  if (!skipVpsRestore) {
    await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => {});
  }

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
  const bindVpsId = Number(accRow.vps_id || 0) || null;
  const bindPortNo = Number(accRow.assigned_port_no || 0) || null;

  async function runPromoteUpdate() {
    return query(
      `
      UPDATE vps_system.mt5_accounts
      SET status=$3,
          last_error=NULL,
          last_login_message=$2,
          metrics_ready=$4,
          last_balance=COALESCE($5::numeric, last_balance),
          last_equity=COALESCE($6::numeric, last_equity),
          connect_baseline_equity=CASE
            WHEN $6::numeric IS NOT NULL AND $6::numeric > 0 THEN $6::numeric
            ELSE connect_baseline_equity
          END,
          connected_at=COALESCE(connected_at, NOW()),
          updated_at=NOW()
      WHERE id=$1
        AND LOWER(COALESCE(status, '')) NOT IN ('deleted', 'cancelled', 'expired')
    `,
      [
        accountId,
        accountMsg,
        accountStatus,
        hasMetrics,
        Number.isFinite(bal) ? bal : null,
        Number.isFinite(eq) ? eq : null
      ]
    );
  }

  if (bindVpsId && bindPortNo) {
    await clearVpsPortPromotionBlockers(bindVpsId, bindPortNo, accountId).catch(() => 0);
  }

  try {
    await runPromoteUpdate();
  } catch (e) {
    if (/uq_mt5_running_vps_port|duplicate key value violates unique constraint/i.test(String(e?.message || ''))) {
      if (bindVpsId && bindPortNo) {
        await clearVpsPortPromotionBlockers(bindVpsId, bindPortNo, accountId).catch(() => 0);
      }
      await runPromoteUpdate().catch((e2) => {
        console.error('[promoteAccountConnected] retry failed', e2.message);
      });
    } else {
      console.error('[promoteAccountConnected]', e.message);
    }
  }

  if (accountStatus !== 'connected') {
    return;
  }

  if (effectivePortId) {
    if (lockPortAfterLogin) {
      const uid =
        userId != null
          ? Number(userId)
          : Number(
              (
                await query(`SELECT user_id FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`, [
                  accountId
                ]).catch(() => ({ rows: [] }))
              ).rows?.[0]?.user_id || 0
            ) || null;
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='locked',
            locked_by_user_id=COALESCE($3, locked_by_user_id),
            locked_until=NOW() + INTERVAL '3650 days',
            mt5_login=$2,
            current_mt5_login=$2,
            process_id=NULL,
            last_pid=NULL,
            last_error=NULL,
            updated_at=NOW()
        WHERE id=$1
      `,
        [effectivePortId, mt5Login, uid]
      ).catch(() => {});
    } else {
      await query(
        `
        UPDATE vps_system.vps_ports
        SET status='running', mt5_login=$2, current_mt5_login=$2,
            locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
        WHERE id=$1
      `,
        [effectivePortId, mt5Login]
      ).catch(() => {});
    }
  }

  const acc = accRow;
  if (acc?.vps_id) {
    const portNo = Number(acc.assigned_port_no || acc.port_slot || 0);
    const folderPath = String(acc.folder_path || '').trim() || null;
    await upsertPortHealthRunning(acc.vps_id, portNo, folderPath, mt5Login).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(acc.vps_id);
    const adminPortNo = adminPortNoFromSystem(portNo);
    if (adminNodeId && adminPortNo) {
      await setAdminAllocationStatus(
        adminNodeId,
        adminPortNo,
        lockPortAfterLogin ? 'locked' : 'used'
      ).catch(() => {});
    }
  }
}

async function applyLoginMt5FromCommandResult(node, payload, result) {
  const accountId = Number(payload?.accountId ?? payload?.account_id ?? 0);
  if (!accountId || !node?.id) return false;

  const mt5Login = String(result?.login || payload?.mt5Login || payload?.mt5_login || '').trim();
  const portNo = Number(payload?.portNo || payload?.port_no || payload?.portNumber || payload?.port || 0);
  const portId = Number(payload?.portId || payload?.port_id || 0);

  const evidence = extractJournalEvidence(
    result?.journalEvidence,
    result?.journal_evidence,
    result?.message
  );
  let verified = false;
  if (evidence && mt5Login) {
    const verdict = parseMt5JournalOutcome(evidence, mt5Login);
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
    message: MT5_SUCCESS_MSG
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

  if (elapsedSec < 5) return { resolved: false };

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
  if (folderPath && elapsedSec >= 5) {
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
    return { resolved: true, status: 'connected', source: 'journal_read' };
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

  const recentCmd = await findRecentLoginCommand(accountId, vpsId).catch(() => null);
  const recentResult = recentCmd?.result && typeof recentCmd.result === 'object' ? recentCmd.result : {};
  const hasWindowProof =
    loginCommandHasLoginProof(recentResult, login)
    || attemptWindowProofOk(
      {
        window_title: account.mt5_window_title,
        mt5_login: login,
        snapshot_verified: Boolean(account.login_verified),
        observed_login: account.mt5_login
      },
      login
    );
  const journalFailSec = hasWindowProof
    ? Number(process.env.MT5_CONNECT_WINDOW_PROOF_TIMEOUT_SEC || 300)
    : 90;

  if (elapsedSec >= journalFailSec && cmdVerify.reason === 'JOURNAL_REQUIRED') {
    const failMsg = readsDone >= 2 && !hasJournalGateMarker(agentVer)
      ? 'Agent บน VPS ยังเป็นเวอร์ชันเก่า — รัน Restart-Service AvelquaPythonAgent แล้วลองใหม่'
      : 'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่';
    await failAccountFromJournal(accountId, portId, failMsg, {
      vpsId,
      portNo,
      folderPath: account.folder_path || '',
      reason: 'journal_verify_timeout'
    }).catch(() => {});
    return { resolved: true, status: 'failed', message: failMsg };
  }

  return { resolved: false };
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

  for (const row of rows.rows || []) {
    await failAccountFromJournal(Number(row.id), Number(row.port_id || 0), row.last_error, {
      vpsId: row.vps_id,
      portNo: row.assigned_port_no || row.windows_port_no,
      folderPath: row.folder_path,
      reason: 'repair_failed_slot'
    }).catch(() => {});
  }
}

module.exports = {
  findRecentLoginCommand,
  findLoginCommandInProgress,
  accountConnectSinceMs,
  extractJournalEvidence,
  verifyPortRunningLogin,
  readLatestPortHealth,
  detectPortHealthLoginMismatch,
  verifyPortRunningForEquityFetch,
  getSuccessfulLoginCommandForAttempt,
  loginCommandJournalVerified,
  loginCommandHasLoginProof,
  loginCommandResultVerified,
  detectWindowTitleLoginMismatch,
  hasInflightLoginCommand,
  verifyLoginFromCommand,
  applyLoginMt5FromCommandResult,
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
  repairFailedAccountsHoldingSlots,
  resolveStuckLoginAccount
};
