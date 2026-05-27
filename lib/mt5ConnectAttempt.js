'use strict';

const crypto = require('crypto');
const { query } = require('../config/database');
const {
  ensureMt5PreviewColumns,
  patchAccountMt5Preview,
  previewPublicPath,
  windowTitleFromMessage
} = require('./mt5Preview');
const { parseMt5JournalOutcome, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('./mt5JournalVerify');
const { promoteAccountConnected, failAccountFromJournal, verifyPortRunningLogin } = require('./mt5LoginCommandVerify');

const ATTEMPT_TIMEOUT_MS = Number(process.env.MT5_CONNECT_ATTEMPT_TIMEOUT_MS || 300000);
const COMMAND_DEDUP_MS = Number(process.env.MT5_CONNECT_ATTEMPT_COMMAND_DEDUP_MS || 12000);

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clean(v) {
  return String(v || '').trim();
}

function positiveMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isAttemptTerminal(status) {
  return ['connected', 'failed', 'cancelled', 'stopped'].includes(String(status || '').toLowerCase());
}

function normalizeAttemptStatus(status) {
  const st = String(status || '').trim().toLowerCase();
  if (!st) return 'queued';
  if (['queued', 'pending'].includes(st)) return 'queued';
  if (st === 'connecting') return 'starting';
  if (['starting', 'window_seen'].includes(st)) return 'starting';
  if (['checking', 'journal_seen', 'snapshot_seen', 'metrics_ready'].includes(st)) return 'checking';
  if (st === 'connected') return 'connected';
  if (['failed', 'failed_auth'].includes(st)) return 'failed';
  if (st === 'stopped') return 'stopped';
  return st;
}

function attemptDisplayStatus(status) {
  const st = normalizeAttemptStatus(status);
  return st === 'queued' ? 'starting' : st;
}

function getConnectStepMeta(row, status, metricsReady = false) {
  const st = normalizeAttemptStatus(status || row?.attempt_status || row?.status);
  const message = clean(row?.attempt_message || row?.last_login_message);
  const lowerMessage = message.toLowerCase();
  const hasWindow = Boolean(clean(row?.attempt_window_title || row?.mt5_window_title));
  const hasJournal = Boolean(row?.journal_verified) || /journal|authorized on|ยืนยันเลขบัญชีแล้ว/.test(lowerMessage);
  const hasSnapshot = Boolean(row?.snapshot_verified || clean(row?.observed_login) || metricsReady);

  if (st === 'connected') {
    return {
      key: 'connected',
      index: 4,
      total: 4,
      label: 'ขั้นตอน 4/4: ยืนยันสำเร็จ',
      detail: 'ยืนยันเลขบัญชีและพร้อมใช้งานแล้ว'
    };
  }

  if (st === 'failed') {
    return {
      key: 'failed',
      index: 0,
      total: 4,
      label: 'เชื่อมต่อไม่สำเร็จ',
      detail: message || MT5_FAIL_USER_MSG
    };
  }

  if (st === 'queued') {
    return {
      key: 'queued',
      index: 1,
      total: 4,
      label: 'ขั้นตอน 1/4: ส่งคำสั่งไป VPS',
      detail: message || 'กำลังส่งคำสั่งเปิด MT5 ไปยัง VPS...'
    };
  }

  if (st === 'starting' && !hasWindow) {
    return {
      key: 'starting',
      index: 2,
      total: 4,
      label: 'ขั้นตอน 2/4: กำลังเปิด MT5',
      detail: message || 'กำลังเปิด MT5 บน VPS...'
    };
  }

  if (st === 'starting' || (st === 'checking' && hasWindow && !hasJournal && !hasSnapshot)) {
    return {
      key: 'window_seen',
      index: 3,
      total: 4,
      label: 'ขั้นตอน 3/4: กำลังเชื่อมต่อ',
      detail: 'เห็นหน้าต่าง MT5 แล้ว กำลังยืนยันเลขบัญชี...'
    };
  }

  if (st === 'checking' && hasSnapshot) {
    return {
      key: 'snapshot',
      index: 4,
      total: 4,
      label: 'ขั้นตอน 4/4: กำลังยืนยันบัญชี',
      detail: 'กำลังอ่าน Balance / Equity และยืนยันเลขบัญชี...'
    };
  }

  if (st === 'checking' && hasJournal) {
    return {
      key: 'journal',
      index: 3,
      total: 4,
      label: 'ขั้นตอน 3/4: กำลังเชื่อมต่อ',
      detail: 'พบหน้าต่าง MT5 แล้ว กำลังรอ Journal ยืนยัน...'
    };
  }

  return {
    key: 'checking',
    index: 3,
    total: 4,
    label: 'ขั้นตอน 3/4: กำลังเชื่อมต่อ',
    detail: 'กำลังตรวจสอบเลขบัญชี MT5...'
  };
}

function exactLogin(login) {
  return clean(login);
}

function exactObservedLogin(v) {
  const s = clean(v);
  if (!s) return '';
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? String(Math.trunc(n)) : s;
}

function isExactLoginMatch(expectedLogin, observedLogin) {
  const expected = exactLogin(expectedLogin);
  const observed = exactObservedLogin(observedLogin);
  return Boolean(expected && observed && expected === observed);
}

function canRecoverFailedAttemptAsConnected(attempt, evidenceSource = '') {
  if (normalizeAttemptStatus(attempt?.status) !== 'failed') return false;
  const source = clean(evidenceSource).toLowerCase();
  const trusted = [
    'journal',
    'journal_command',
    'snapshot',
    'snapshot_port_health',
    'connect_result',
    'port_health_recovery',
    'window_title_recovery'
  ];
  if (!trusted.includes(source)) return false;
  const failSource = clean(attempt?.evidence_source).toLowerCase();
  const failMsg = clean(attempt?.last_error || attempt?.last_message).toLowerCase();
  return failSource === 'attempt_timeout' || /ไม่สามารถยืนยัน login จาก mt5 ได้ทันเวลา|timed out|timeout/.test(failMsg);
}

function attemptHasLivePortProof(attempt, accountRow = null) {
  const expected = clean(attempt?.mt5_login);
  if (!expected) return false;
  const portLogin = clean(attempt?.port_health_login);
  if (attempt?.port_health_verified && isExactLoginMatch(expected, portLogin)) {
    return true;
  }
  const title = clean(accountRow?.mt5_window_title || attempt?.window_title);
  if (title && title.includes(expected)) {
    return true;
  }
  return false;
}

async function tryRecoverTimedOutAttempt(attempt, accountRow = null) {
  if (!attempt?.attempt_id) return null;
  const st = normalizeAttemptStatus(attempt.status);
  if (st !== 'failed' && !isAttemptTerminal(st)) return null;
  if (!canRecoverFailedAttemptAsConnected(attempt, 'port_health_recovery')) {
    if (st !== 'failed') return null;
    if (!attemptHasLivePortProof(attempt, accountRow)) return null;
    const failMsg = clean(attempt?.last_error || attempt?.last_message).toLowerCase();
    if (!/ไม่สามารถยืนยัน login จาก mt5 ได้ทันเวลา|timed out|timeout|attempt_timeout/.test(failMsg)) {
      return null;
    }
  }

  const expected = clean(attempt.mt5_login);
  const bal = positiveMoney(attempt.balance) ?? positiveMoney(accountRow?.last_balance);
  const eq = positiveMoney(attempt.equity) ?? positiveMoney(accountRow?.last_equity);
  const observed = clean(attempt.observed_login) || expected;

  if (!attemptHasLivePortProof(attempt, accountRow) && !(bal || eq)) {
    return null;
  }

  return finalizeAttemptConnected(attempt, {
    message: MT5_SUCCESS_MSG,
    evidenceSource: attemptHasLivePortProof(attempt, accountRow)
      ? 'port_health_recovery'
      : 'snapshot',
    observedLogin: observed,
    balance: bal,
    equity: eq
  }).catch(() => null);
}

async function ensureMt5ConnectAttemptTables() {
  await query(`CREATE SCHEMA IF NOT EXISTS vps_system`).catch(() => {});
  await ensureMt5PreviewColumns().catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.mt5_connect_attempts (
      id BIGSERIAL PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      account_id BIGINT NOT NULL,
      user_id BIGINT,
      vps_id BIGINT,
      port_id BIGINT,
      port_slot INT,
      assigned_port_no INT,
      folder_path TEXT,
      mt5_login TEXT,
      server_name TEXT,
      command_id BIGINT,
      status TEXT DEFAULT 'queued',
      terminal BOOLEAN DEFAULT FALSE,
      login_verified BOOLEAN DEFAULT FALSE,
      journal_verified BOOLEAN DEFAULT FALSE,
      snapshot_verified BOOLEAN DEFAULT FALSE,
      port_health_verified BOOLEAN DEFAULT FALSE,
      metrics_ready BOOLEAN DEFAULT FALSE,
      observed_login TEXT,
      port_health_login TEXT,
      balance NUMERIC,
      equity NUMERIC,
      process_id BIGINT,
      evidence_source TEXT,
      last_message TEXT,
      last_error TEXT,
      window_title TEXT,
      raw_last_event JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `).catch(() => {});

  await query(`
    CREATE INDEX IF NOT EXISTS idx_mt5_connect_attempts_account_created
    ON vps_system.mt5_connect_attempts (account_id, created_at DESC)
  `).catch(() => {});
  await query(`
    CREATE INDEX IF NOT EXISTS idx_mt5_connect_attempts_node_status
    ON vps_system.mt5_connect_attempts (vps_id, status, updated_at DESC)
  `).catch(() => {});

  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS current_attempt_id TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS login_verified BOOLEAN DEFAULT FALSE`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS metrics_ready BOOLEAN DEFAULT FALSE`).catch(() => {});
}

async function createConnectAttempt({
  accountId,
  userId,
  vpsId,
  portId,
  portSlot,
  assignedPortNo,
  folderPath,
  mt5Login,
  serverName,
  commandId = null
}) {
  await ensureMt5ConnectAttemptTables();
  const attemptId = crypto.randomUUID();
  const payload = [
    attemptId,
    Number(accountId),
    userId ? Number(userId) : null,
    vpsId ? Number(vpsId) : null,
    portId ? Number(portId) : null,
    portSlot ? Number(portSlot) : null,
    assignedPortNo ? Number(assignedPortNo) : null,
    clean(folderPath) || null,
    clean(mt5Login) || null,
    clean(serverName) || null,
    commandId ? Number(commandId) : null
  ];
  await query(
    `
    INSERT INTO vps_system.mt5_connect_attempts
    (attempt_id, account_id, user_id, vps_id, port_id, port_slot, assigned_port_no, folder_path,
     mt5_login, server_name, command_id, status, terminal, login_verified, metrics_ready,
     last_message, created_at, updated_at)
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',FALSE,FALSE,FALSE,'กำลังส่งคำสั่งเปิด MT5...',NOW(),NOW())
  `,
    payload
  );

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET current_attempt_id=$2,
        login_verified=FALSE,
        metrics_ready=FALSE,
        status='connecting',
        last_error=NULL,
        last_login_message='กำลังเปิด MT5 และ Login...',
        connect_started_at=NOW(),
        updated_at=NOW()
    WHERE id=$1
  `,
    [Number(accountId), attemptId]
  ).catch(() => {});

  return attemptId;
}

async function getAttemptById(attemptId) {
  if (!attemptId) return null;
  await ensureMt5ConnectAttemptTables();
  const r = await query(
    `
    SELECT at.*, a.current_attempt_id
    FROM vps_system.mt5_connect_attempts at
    LEFT JOIN vps_system.mt5_accounts a ON a.id=at.account_id
    WHERE at.attempt_id=$1
    LIMIT 1
  `,
    [String(attemptId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function getLatestAttemptForAccount(accountId) {
  if (!accountId) return null;
  await ensureMt5ConnectAttemptTables();
  const r = await query(
    `
    SELECT at.*, a.current_attempt_id
    FROM vps_system.mt5_connect_attempts at
    LEFT JOIN vps_system.mt5_accounts a ON a.id=at.account_id
    WHERE at.account_id=$1
    ORDER BY
      CASE WHEN at.attempt_id = a.current_attempt_id THEN 0 ELSE 1 END,
      at.created_at DESC,
      at.id DESC
    LIMIT 1
  `,
    [Number(accountId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function resolveAttempt({ attemptId, accountId }) {
  const byId = await getAttemptById(attemptId).catch(() => null);
  if (byId) return byId;
  if (!accountId) return null;
  return getLatestAttemptForAccount(accountId).catch(() => null);
}

async function updateAttemptRow(attemptId, patch = {}) {
  const cols = [];
  const vals = [];
  let i = 1;
  const map = {
    vps_id: patch.vpsId,
    port_id: patch.portId,
    port_slot: patch.portSlot,
    assigned_port_no: patch.assignedPortNo,
    folder_path: patch.folderPath,
    mt5_login: patch.mt5Login,
    server_name: patch.serverName,
    command_id: patch.commandId,
    status: patch.status,
    terminal: patch.terminal,
    login_verified: patch.loginVerified,
    journal_verified: patch.journalVerified,
    snapshot_verified: patch.snapshotVerified,
    port_health_verified: patch.portHealthVerified,
    metrics_ready: patch.metricsReady,
    observed_login: patch.observedLogin,
    port_health_login: patch.portHealthLogin,
    balance: patch.balance,
    equity: patch.equity,
    process_id: patch.processId,
    evidence_source: patch.evidenceSource,
    last_message: patch.lastMessage,
    last_error: patch.lastError,
    window_title: patch.windowTitle,
    raw_last_event: patch.rawLastEvent
  };
  for (const [col, value] of Object.entries(map)) {
    if (value === undefined) continue;
    cols.push(`${col}=$${i++}`);
    vals.push(value);
  }
  cols.push(`updated_at=NOW()`);
  if (patch.finishedAt === true) cols.push(`finished_at=NOW()`);
  if (!cols.length) return;
  vals.push(String(attemptId));
  await query(
    `UPDATE vps_system.mt5_connect_attempts SET ${cols.join(', ')} WHERE attempt_id=$${i}`,
    vals
  ).catch(() => {});
}

async function updateAccountForAttempt(attempt, patch = {}) {
  if (!attempt?.account_id || !attempt?.attempt_id) return;
  const cols = [];
  const vals = [Number(attempt.account_id), String(attempt.attempt_id)];
  let i = 3;
  const map = {
    status: patch.status,
    last_error: patch.lastError,
    last_login_message: patch.lastMessage,
    mt5_window_title: patch.windowTitle,
    vps_id: patch.vpsId,
    port_id: patch.portId,
    assigned_port_no: patch.assignedPortNo,
    windows_port_no: patch.windowsPortNo,
    port_slot: patch.portSlot,
    login_verified: patch.loginVerified,
    metrics_ready: patch.metricsReady,
    last_balance: patch.balance,
    last_equity: patch.equity
  };
  for (const [col, value] of Object.entries(map)) {
    if (value === undefined) continue;
    cols.push(`${col}=$${i++}`);
    vals.push(value);
  }
  cols.push(`updated_at=NOW()`);
  if (!cols.length) return;
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET ${cols.join(', ')}
    WHERE id=$1
      AND (current_attempt_id=$2 OR current_attempt_id IS NULL)
  `,
    vals
  ).catch(() => {});
}

async function recordAttemptPreview(attempt, { status, message, windowTitle, previewB64 } = {}) {
  if (!attempt?.account_id) return;
  await patchAccountMt5Preview(attempt.account_id, {
    status: status ? attemptDisplayStatus(status) : undefined,
    message,
    windowTitle,
    previewB64
  }).catch(() => {});
}

async function queueAttemptCommand(attempt, commandType, payload, purpose) {
  if (!attempt?.vps_id || !attempt?.account_id) return false;
  const recent = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type=$2
      AND COALESCE(payload->>'attemptId', '') = $3
      AND COALESCE(payload->>'purpose', '') = $4
      AND created_at > NOW() - (($5::text || ' milliseconds')::interval)
      AND LOWER(COALESCE(status, '')) IN ('pending','queued','picked','processing','running','success','done')
    LIMIT 1
  `,
    [Number(attempt.vps_id), String(commandType), String(attempt.attempt_id), String(purpose), String(COMMAND_DEDUP_MS)]
  ).catch(() => ({ rows: [] }));
  if (recent.rows?.[0]) return false;

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1,$1,$2,$3,$4::jsonb,'pending',NOW(),NOW())
  `,
    [Number(attempt.vps_id), attempt.port_id ? Number(attempt.port_id) : null, commandType, JSON.stringify(payload)]
  ).catch(() => {});
  return true;
}

async function ensureAttemptVerificationCommands(attempt) {
  if (!attempt || isAttemptTerminal(attempt.status)) return false;
  const ageMs = Date.now() - new Date(attempt.created_at || attempt.updated_at || Date.now()).getTime();
  if (ageMs > ATTEMPT_TIMEOUT_MS) return false;

  let queued = false;
  const common = {
    attemptId: String(attempt.attempt_id),
    accountId: Number(attempt.account_id),
    userId: attempt.user_id ? Number(attempt.user_id) : undefined,
    mt5Login: clean(attempt.mt5_login),
    portId: attempt.port_id ? Number(attempt.port_id) : undefined,
    portSlot: attempt.port_slot ? Number(attempt.port_slot) : undefined,
    port: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    portNo: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    portNumber: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    port_no: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    vpsFolderPath: clean(attempt.folder_path) || undefined,
    folder_path: clean(attempt.folder_path) || undefined,
    folderPath: clean(attempt.folder_path) || undefined
  };

  if (attempt.folder_path && attempt.mt5_login) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    queued = await queueAttemptCommand(
      attempt,
      'port_read_file',
      {
        ...common,
        file_path: `logs\\${today}.log`,
        purpose: 'attempt_verify_journal'
      },
      'attempt_verify_journal'
    ) || queued;
  }

  queued = await queueAttemptCommand(
    attempt,
    'account_snapshot',
    {
      ...common,
      purpose: 'attempt_verify_snapshot'
    },
    'attempt_verify_snapshot'
  ) || queued;

  return queued;
}

async function finalizeAttemptConnected(attempt, { message, evidenceSource, observedLogin, balance, equity, processId } = {}) {
  if (!attempt?.attempt_id) return { ok: false, reason: 'NO_ATTEMPT' };
  const fresh = await getAttemptById(attempt.attempt_id).catch(() => null);
  if (!fresh) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };
  const recoverTimedOutFailure = canRecoverFailedAttemptAsConnected(fresh, evidenceSource);
  if (isAttemptTerminal(fresh.status) && !recoverTimedOutFailure) {
    return { ok: fresh.status === 'connected', status: fresh.status, attempt: fresh };
  }

  const bal = positiveMoney(balance);
  const eq = positiveMoney(equity);
  const metricsReady = Boolean(bal || eq || fresh.metrics_ready);
  const finalMsg = clean(message) || MT5_SUCCESS_MSG;
  const attemptIsCurrent = !fresh.current_attempt_id || String(fresh.current_attempt_id) == String(fresh.attempt_id);

  if (attemptIsCurrent) {
    await promoteAccountConnected({
      accountId: Number(fresh.account_id),
      portId: fresh.port_id ? Number(fresh.port_id) : null,
      mt5Login: clean(fresh.mt5_login),
      message: finalMsg
    }).catch(() => {});
  }

  await updateAttemptRow(fresh.attempt_id, {
    status: 'connected',
    terminal: true,
    loginVerified: true,
    metricsReady,
    observedLogin: observedLogin !== undefined ? exactObservedLogin(observedLogin) : fresh.observed_login,
    balance: bal !== null ? bal : undefined,
    equity: eq !== null ? eq : undefined,
    processId: processId !== undefined ? processId : fresh.process_id,
    evidenceSource: clean(evidenceSource) || fresh.evidence_source || 'attempt_verifier',
    lastMessage: finalMsg,
    lastError: null,
    finishedAt: true
  });

  if (attemptIsCurrent) {
    await updateAccountForAttempt(fresh, {
      status: 'connected',
      lastError: null,
      lastMessage: finalMsg,
      vpsId: fresh.vps_id ? Number(fresh.vps_id) : undefined,
      portId: fresh.port_id ? Number(fresh.port_id) : undefined,
      assignedPortNo: fresh.assigned_port_no ? Number(fresh.assigned_port_no) : undefined,
      windowsPortNo: fresh.assigned_port_no ? Number(fresh.assigned_port_no) : undefined,
      portSlot: fresh.port_slot ? Number(fresh.port_slot) : undefined,
      loginVerified: true,
      metricsReady,
      balance: bal !== null ? bal : undefined,
      equity: eq !== null ? eq : undefined
    });

    await query(
      `
      INSERT INTO vps_system.mt5_login_history
      (user_id, account_id, vps_id, port_id, port_no, mt5_login, server_name, status, message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'connected',$8)
    `,
      [
        fresh.user_id ? Number(fresh.user_id) : null,
        Number(fresh.account_id),
        fresh.vps_id ? Number(fresh.vps_id) : null,
        fresh.port_id ? Number(fresh.port_id) : null,
        fresh.assigned_port_no ? Number(fresh.assigned_port_no) : null,
        clean(fresh.mt5_login) || null,
        clean(fresh.server_name) || null,
        finalMsg
      ]
    ).catch(() => {});
  }

  return { ok: true, status: 'connected', message: finalMsg, attemptId: fresh.attempt_id };
}

async function finalizeAttemptFailed(attempt, message, { evidenceSource } = {}) {
  if (!attempt?.attempt_id) return { ok: false, reason: 'NO_ATTEMPT' };
  const fresh = await getAttemptById(attempt.attempt_id).catch(() => null);
  if (!fresh) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };
  if (isAttemptTerminal(fresh.status)) {
    return { ok: fresh.status === 'failed', status: fresh.status, attempt: fresh };
  }

  const failMsg = clean(message) || MT5_FAIL_USER_MSG;
  const attemptIsCurrent = !fresh.current_attempt_id || String(fresh.current_attempt_id) == String(fresh.attempt_id);
  if (attemptIsCurrent) {
    await failAccountFromJournal(Number(fresh.account_id), fresh.port_id ? Number(fresh.port_id) : null, failMsg, {
      vpsId: fresh.vps_id ? Number(fresh.vps_id) : null,
      portNo: fresh.assigned_port_no ? Number(fresh.assigned_port_no) : null,
      folderPath: clean(fresh.folder_path) || null,
      reason: clean(evidenceSource) || 'attempt_verifier'
    }).catch(() => {});
  }

  await updateAttemptRow(fresh.attempt_id, {
    status: 'failed',
    terminal: true,
    loginVerified: false,
    evidenceSource: clean(evidenceSource) || fresh.evidence_source || 'attempt_verifier',
    lastMessage: failMsg,
    lastError: failMsg,
    finishedAt: true
  });

  if (attemptIsCurrent) {
    await updateAccountForAttempt(fresh, {
      status: 'failed',
      lastError: failMsg,
      lastMessage: failMsg,
      loginVerified: false
    });

    await query(
      `
      INSERT INTO vps_system.mt5_login_history
      (user_id, account_id, vps_id, port_id, port_no, mt5_login, server_name, status, message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8)
    `,
      [
        fresh.user_id ? Number(fresh.user_id) : null,
        Number(fresh.account_id),
        fresh.vps_id ? Number(fresh.vps_id) : null,
        fresh.port_id ? Number(fresh.port_id) : null,
        fresh.assigned_port_no ? Number(fresh.assigned_port_no) : null,
        clean(fresh.mt5_login) || null,
        clean(fresh.server_name) || null,
        failMsg
      ]
    ).catch(() => {});
  }

  return { ok: true, status: 'failed', message: failMsg, attemptId: fresh.attempt_id };
}

async function maybeFinalizeAttempt(attemptId) {
  const attempt = await getAttemptById(attemptId).catch(() => null);
  if (!attempt || isAttemptTerminal(attempt.status)) return attempt;

  const expectedLogin = clean(attempt.mt5_login);
  if (attempt.journal_verified) {
    await finalizeAttemptConnected(attempt, {
      message: attempt.last_message || MT5_SUCCESS_MSG,
      evidenceSource: attempt.evidence_source || 'journal',
      observedLogin: expectedLogin,
      balance: attempt.balance,
      equity: attempt.equity,
      processId: attempt.process_id
    }).catch(() => {});
    return getAttemptById(attemptId).catch(() => null);
  }

  if (
    attempt.snapshot_verified
    && attempt.metrics_ready
    && isExactLoginMatch(expectedLogin, attempt.observed_login)
  ) {
    await finalizeAttemptConnected(attempt, {
      message: attempt.last_message || 'ยืนยันการเชื่อมต่อจาก MT5 API แล้ว',
      evidenceSource: attempt.evidence_source || 'snapshot',
      observedLogin: attempt.observed_login,
      balance: attempt.balance,
      equity: attempt.equity,
      processId: attempt.process_id
    }).catch(() => {});
    return getAttemptById(attemptId).catch(() => null);
  }

  if (
    attempt.snapshot_verified
    && attempt.port_health_verified
    && isExactLoginMatch(expectedLogin, attempt.observed_login)
    && isExactLoginMatch(expectedLogin, attempt.port_health_login)
  ) {
    await finalizeAttemptConnected(attempt, {
      message: attempt.last_message || 'ยืนยันการเชื่อมต่อจาก MT5 API และ port health แล้ว',
      evidenceSource: attempt.evidence_source || 'snapshot_port_health',
      observedLogin: attempt.observed_login,
      balance: attempt.balance,
      equity: attempt.equity,
      processId: attempt.process_id
    }).catch(() => {});
    return getAttemptById(attemptId).catch(() => null);
  }

  if (
    attempt.port_health_verified
    && isExactLoginMatch(expectedLogin, attempt.port_health_login)
    && (attempt.metrics_ready || positiveMoney(attempt.balance) || positiveMoney(attempt.equity))
  ) {
    await finalizeAttemptConnected(attempt, {
      message: attempt.last_message || MT5_SUCCESS_MSG,
      evidenceSource: 'port_health_recovery',
      observedLogin: expectedLogin,
      balance: attempt.balance,
      equity: attempt.equity,
      processId: attempt.process_id
    }).catch(() => {});
    return getAttemptById(attemptId).catch(() => null);
  }

  const createdAtMs = attempt.created_at ? new Date(attempt.created_at).getTime() : 0;
  if (createdAtMs && Date.now() - createdAtMs > ATTEMPT_TIMEOUT_MS) {
    await finalizeAttemptFailed(
      attempt,
      'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่',
      { evidenceSource: 'attempt_timeout' }
    ).catch(() => {});
    return getAttemptById(attemptId).catch(() => null);
  }

  return attempt;
}

async function markAttemptProgress(attempt, {
  status,
  message,
  lastError,
  windowTitle,
  previewB64,
  processId,
  observedLogin,
  balance,
  equity,
  evidenceSource,
  journalVerified,
  snapshotVerified,
  portHealthVerified,
  portHealthLogin,
  rawLastEvent
} = {}) {
  if (!attempt?.attempt_id) return null;
  const fresh = await getAttemptById(attempt.attempt_id).catch(() => null);
  if (fresh?.terminal) return fresh;
  const base = fresh || attempt;
  const nextStatus = normalizeAttemptStatus(status || base.status);
  const bal = positiveMoney(balance);
  const eq = positiveMoney(equity);
  const metricsReady = Boolean(bal || eq || base.metrics_ready);
  await updateAttemptRow(base.attempt_id, {
    status: nextStatus,
    lastMessage: message !== undefined ? clean(message) || null : undefined,
    lastError: lastError !== undefined ? clean(lastError) || null : undefined,
    windowTitle: windowTitle !== undefined ? clean(windowTitle) || null : undefined,
    processId: processId !== undefined ? processId : undefined,
    observedLogin: observedLogin !== undefined ? exactObservedLogin(observedLogin) || null : undefined,
    balance: bal !== null ? bal : undefined,
    equity: eq !== null ? eq : undefined,
    metricsReady,
    evidenceSource: evidenceSource !== undefined ? clean(evidenceSource) || null : undefined,
    journalVerified,
    snapshotVerified,
    portHealthVerified,
    portHealthLogin: portHealthLogin !== undefined ? exactObservedLogin(portHealthLogin) || null : undefined,
    rawLastEvent
  });

  await updateAccountForAttempt(base, {
    status: attemptDisplayStatus(nextStatus),
    lastError: lastError !== undefined ? clean(lastError) || null : undefined,
    lastMessage: message !== undefined ? clean(message) || null : undefined,
    windowTitle: windowTitle !== undefined ? clean(windowTitle) || null : undefined,
    vpsId: base.vps_id ? Number(base.vps_id) : undefined,
    portId: base.port_id ? Number(base.port_id) : undefined,
    assignedPortNo: base.assigned_port_no ? Number(base.assigned_port_no) : undefined,
    windowsPortNo: base.assigned_port_no ? Number(base.assigned_port_no) : undefined,
    portSlot: base.port_slot ? Number(base.port_slot) : undefined,
    metricsReady,
    balance: bal !== null ? bal : undefined,
    equity: eq !== null ? eq : undefined
  });

  if (windowTitle || previewB64 || message) {
    await recordAttemptPreview(base, {
      status: nextStatus,
      message,
      windowTitle,
      previewB64
    }).catch(() => {});
  }

  return getAttemptById(base.attempt_id).catch(() => null);
}

async function ingestConnectResultEvent(node, body) {
  await ensureMt5ConnectAttemptTables();
  const accountId = num(body.accountId || body.account_id || 0);
  const rawStatus = clean(body.status).toLowerCase();
  const attempt = await resolveAttempt({
    attemptId: clean(body.attemptId || body.attempt_id),
    accountId
  }).catch(() => null);
  if (!attempt) return { ok: true, ignored: true, reason: 'ATTEMPT_NOT_FOUND' };

  const status = normalizeAttemptStatus(rawStatus);
  const message = clean(body.message);
  const mt5Login = clean(body.mt5Login || body.mt5_login || attempt.mt5_login);
  const portNo = num(body.portNo || body.port_no || body.portNumber || body.port || attempt.assigned_port_no);
  const observedLogin = clean(body.observedLogin || body.observed_login || body.accountLogin || body.account_login);
  const windowTitle = clean(body.windowTitle || body.mt5WindowTitle);
  const previewB64 = clean(body.previewImage || body.mt5PreviewImage);
  const pid = body.process_id || body.pid || null;
  const journalEvidence = clean(
    body.journalEvidence || body.journal_evidence || body.journal || body.latestLog || body.logText
  );
  const verdict = journalEvidence && mt5Login ? parseMt5JournalOutcome(journalEvidence, mt5Login) : null;
  const bal = positiveMoney(body.balance);
  const eq = positiveMoney(body.equity);
  const terminalFailLike = rawStatus === 'failed_auth' || (status === 'failed' && !/timeout|ทันเวลา|รอสักครู่|worker/i.test(message));
  const provenConnected = status === 'connected'
    && (verdict === 'success' || body.loginVerified === true || body.login_verified === true);
  const progressStatus = terminalFailLike
    ? 'failed'
    : provenConnected
      ? 'checking'
      : status === 'failed' && /timeout|ทันเวลา|รอสักครู่|worker/i.test(message)
        ? 'checking'
        : status;

  const mergedAttempt = await markAttemptProgress(attempt, {
    status: progressStatus,
    message: message || undefined,
    lastError: terminalFailLike ? (message || undefined) : null,
    windowTitle: windowTitle || undefined,
    previewB64: previewB64 || undefined,
    processId: pid || undefined,
    observedLogin: observedLogin || undefined,
    balance: bal,
    equity: eq,
    evidenceSource: rawStatus === 'connected' ? 'connect_result' : rawStatus,
    journalVerified: verdict === 'success' ? true : undefined,
    rawLastEvent: body
  }).catch(() => attempt);

  if (verdict === 'failed' || terminalFailLike) {
    return finalizeAttemptFailed(mergedAttempt || attempt, message || MT5_FAIL_USER_MSG, {
      evidenceSource: verdict === 'failed' ? 'journal_failed' : (rawStatus || 'connect_result')
    });
  }

  if (provenConnected) {
    return finalizeAttemptConnected(mergedAttempt || attempt, {
      message: message || MT5_SUCCESS_MSG,
      evidenceSource: verdict === 'success' ? 'journal' : 'connect_result',
      observedLogin: observedLogin || mt5Login,
      balance: bal,
      equity: eq,
      processId: pid || undefined
    });
  }

  if (status === 'failed' && /timeout|ทันเวลา|รอสักครู่|worker/i.test(message)) {
    await ensureAttemptVerificationCommands(mergedAttempt || attempt).catch(() => {});
    return { ok: true, pending: true, status: 'checking', attemptId: attempt.attempt_id };
  }

  if (status === 'starting' || status === 'checking') {
    await ensureAttemptVerificationCommands(mergedAttempt || attempt).catch(() => {});
  }

  await maybeFinalizeAttempt(attempt.attempt_id).catch(() => {});
  return { ok: true, status: attemptDisplayStatus(status), attemptId: attempt.attempt_id };
}

async function ingestCommandResultEvent(node, { commandId, commandType, payload, ok, result, error, message }) {
  await ensureMt5ConnectAttemptTables();
  const accountId = num(payload?.accountId || payload?.account_id || 0);
  const attempt = await resolveAttempt({
    attemptId: clean(payload?.attemptId || payload?.attempt_id || result?.attemptId || result?.attempt_id),
    accountId
  }).catch(() => null);
  if (!attempt) return { ok: true, ignored: true, reason: 'ATTEMPT_NOT_FOUND' };

  const ctype = clean(commandType).toLowerCase();
  const msg = clean(message || result?.message || result?.status || error);
  const mt5Login = clean(result?.login || payload?.mt5Login || payload?.mt5_login || attempt.mt5_login);

  if (ctype === 'login_mt5') {
    if (!ok) {
      if (/timeout|ทันเวลา|worker/i.test(msg)) {
        await markAttemptProgress(attempt, {
          status: 'checking',
          message: msg || 'กำลังรอ verifier ยืนยัน MT5...',
          rawLastEvent: { ok, result, error, commandId, commandType: ctype }
        }).catch(() => {});
        await ensureAttemptVerificationCommands(attempt).catch(() => {});
        return { ok: true, pending: true, attemptId: attempt.attempt_id };
      }
      return finalizeAttemptFailed(attempt, msg || MT5_FAIL_USER_MSG, { evidenceSource: 'login_command_failed' });
    }

    const evidence = clean(result?.journalEvidence || result?.journal_evidence || result?.message);
    const verdict = evidence && mt5Login ? parseMt5JournalOutcome(evidence, mt5Login) : null;
    if (verdict === 'failed') {
      return finalizeAttemptFailed(attempt, MT5_FAIL_USER_MSG, { evidenceSource: 'login_command_journal_failed' });
    }
    await markAttemptProgress(attempt, {
      status: result?.loginVerified === true || result?.login_verified === true || verdict === 'success' ? 'checking' : 'starting',
      message: msg || 'MT5 เริ่มทำงานแล้ว กำลังรอ verifier...',
      processId: result?.process_id || result?.pid || undefined,
      evidenceSource: 'login_command',
      journalVerified: verdict === 'success' ? true : undefined,
      rawLastEvent: { ok, result, commandId, commandType: ctype }
    }).catch(() => {});

    if (verdict === 'success' && (result?.loginVerified === true || result?.login_verified === true)) {
      return finalizeAttemptConnected(attempt, {
        message: msg || MT5_SUCCESS_MSG,
        evidenceSource: 'journal',
        observedLogin: mt5Login,
        processId: result?.process_id || result?.pid || undefined
      });
    }

    await ensureAttemptVerificationCommands(attempt).catch(() => {});
    return { ok: true, pending: true, attemptId: attempt.attempt_id };
  }

  if ((ctype === 'port_read_file' || ctype === 'read_file') && /verify_journal/i.test(clean(payload?.purpose))) {
    const content = clean(result?.content || result?.journalEvidence || result?.journal_evidence || result?.text);
    const verdict = content && mt5Login ? parseMt5JournalOutcome(content, mt5Login) : null;
    await markAttemptProgress(attempt, {
      status: verdict === 'success' ? 'checking' : 'checking',
      message: verdict === 'success'
        ? 'Journal ยืนยันเลขบัญชีแล้ว'
        : verdict === 'failed'
          ? MT5_FAIL_USER_MSG
          : 'กำลังรอ Journal ยืนยัน...',
      evidenceSource: 'journal_command',
      journalVerified: verdict === 'success' ? true : undefined,
      rawLastEvent: { ok, result, commandId, commandType: ctype, verdict }
    }).catch(() => {});
    if (verdict === 'failed') {
      return finalizeAttemptFailed(attempt, MT5_FAIL_USER_MSG, { evidenceSource: 'journal_command' });
    }
    if (verdict === 'success') {
      return finalizeAttemptConnected(attempt, {
        message: MT5_SUCCESS_MSG,
        evidenceSource: 'journal',
        observedLogin: mt5Login
      });
    }
    return { ok: true, pending: true, attemptId: attempt.attempt_id };
  }

  if (['account_snapshot', 'sync_mt5_account', 'read_account_metrics'].includes(ctype)) {
    const snap = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : result || {};
    const observed = clean(
      snap.observedLogin || snap.observed_login || snap.login || snap.accountLogin || snap.account_login
    );
    const balance = positiveMoney(snap.balance ?? result?.balance);
    const equity = positiveMoney(snap.equity ?? result?.equity);
    const snapshotVerified = isExactLoginMatch(mt5Login, observed);
    const portProof = attempt.vps_id && attempt.assigned_port_no && snapshotVerified
      ? await verifyPortRunningLogin(Number(attempt.vps_id), Number(attempt.assigned_port_no), mt5Login).catch(() => ({ ok: false }))
      : { ok: false };

    await markAttemptProgress(attempt, {
      status: 'checking',
      message: snapshotVerified
        ? `Snapshot ยืนยันเลขบัญชี ${observed} แล้ว`
        : msg || 'ได้รับ snapshot จาก MT5 แล้ว',
      observedLogin: observed || undefined,
      balance,
      equity,
      snapshotVerified: snapshotVerified ? true : undefined,
      portHealthVerified: portProof.ok ? true : undefined,
      portHealthLogin: portProof.ok ? mt5Login : undefined,
      evidenceSource: snapshotVerified ? 'snapshot' : 'snapshot_metrics',
      rawLastEvent: { ok, result, commandId, commandType: ctype }
    }).catch(() => {});

    if (snapshotVerified && (portProof.ok || balance !== null || equity !== null)) {
      return finalizeAttemptConnected(attempt, {
        message: portProof.ok
          ? 'ยืนยันการเชื่อมต่อจาก MT5 API และ port health แล้ว'
          : 'ยืนยันการเชื่อมต่อจาก MT5 API แล้ว',
        evidenceSource: portProof.ok ? 'snapshot_port_health' : 'snapshot',
        observedLogin: observed,
        balance,
        equity
      });
    }

    return { ok: true, pending: true, attemptId: attempt.attempt_id };
  }

  return { ok: true, ignored: true, reason: 'UNSUPPORTED_COMMAND', attemptId: attempt.attempt_id };
}

async function ingestPortHealthEvent(node, portData) {
  await ensureMt5ConnectAttemptTables();
  const portNo = num(portData.port_no || portData.portNo || portData.portNumber || 0);
  if (!node?.id || !portNo) return { ok: false, reason: 'NO_PORT' };
  const running = Boolean(portData.running ?? portData.is_running ?? portData.isRunning);
  const reportedLogin = clean(portData.mt5_login || portData.mt5Login);
  const pid = portData.process_id || portData.pid || null;
  const folderPath = clean(portData.folder_path || portData.folderPath);

  const r = await query(
    `
    SELECT at.*, a.current_attempt_id
    FROM vps_system.mt5_connect_attempts at
    JOIN vps_system.mt5_accounts a ON a.id=at.account_id
    WHERE at.vps_id=$1
      AND at.assigned_port_no=$2
      AND at.terminal=FALSE
      AND at.attempt_id=a.current_attempt_id
    ORDER BY at.created_at DESC, at.id DESC
  `,
    [Number(node.id), portNo]
  ).catch(() => ({ rows: [] }));

  for (const attempt of r.rows || []) {
    const expected = clean(attempt.mt5_login);
    const exact = running && isExactLoginMatch(expected, reportedLogin);
    await markAttemptProgress(attempt, {
      status: running ? 'checking' : undefined,
      processId: pid || undefined,
      portHealthVerified: exact ? true : undefined,
      portHealthLogin: reportedLogin || undefined,
      evidenceSource: exact ? 'port_health' : undefined,
      rawLastEvent: { portHealth: portData }
    }).catch(() => {});

    if (folderPath && !attempt.folder_path) {
      await updateAttemptRow(attempt.attempt_id, { folderPath });
    }

    if (exact) {
      await ensureAttemptVerificationCommands(attempt).catch(() => {});
      await maybeFinalizeAttempt(attempt.attempt_id).catch(() => {});
    }
  }

  return { ok: true, count: r.rows?.length || 0 };
}

async function expireStaleConnectAttempts(nodeId = null) {
  await ensureMt5ConnectAttemptTables();
  const params = [];
  let where = `at.terminal=FALSE AND at.created_at < NOW() - (($1::text || ' milliseconds')::interval)`;
  params.push(String(ATTEMPT_TIMEOUT_MS));
  if (nodeId) {
    params.push(Number(nodeId));
    where += ` AND at.vps_id=$2`;
  }
  const r = await query(
    `
    SELECT at.*, a.current_attempt_id
    FROM vps_system.mt5_connect_attempts at
    JOIN vps_system.mt5_accounts a ON a.id=at.account_id
    WHERE ${where}
    ORDER BY at.created_at ASC
  `,
    params
  ).catch(() => ({ rows: [] }));

  for (const attempt of r.rows || []) {
    await maybeFinalizeAttempt(attempt.attempt_id).catch(() => {});
  }
  return r.rows?.length || 0;
}

async function getConnectStatusForUser(userId, accountId = 0) {
  await ensureMt5ConnectAttemptTables();
  const params = [Number(userId)];
  let where = `a.user_id=$1`;
  if (accountId) {
    params.push(Number(accountId));
    where += ` AND a.id=$2`;
  }

  const r = await query(
    `
    SELECT
      a.id,
      a.status,
      a.last_error,
      a.last_login_message,
      a.vps_id,
      a.port_id,
      a.port_slot,
      a.assigned_port_no,
      a.mt5_login,
      a.server_name,
      a.updated_at,
      a.connect_started_at,
      a.last_balance,
      a.last_equity,
      a.metrics_ready AS account_metrics_ready,
      a.login_verified AS account_login_verified,
      a.current_attempt_id,
      a.mt5_window_title,
      p.folder_path,
      at.attempt_id,
      at.status AS attempt_status,
      at.terminal AS attempt_terminal,
      at.login_verified,
      at.metrics_ready,
      at.journal_verified,
      at.snapshot_verified,
      at.port_health_verified,
      at.observed_login,
      at.port_health_login,
      at.balance AS attempt_balance,
      at.equity AS attempt_equity,
      at.last_message AS attempt_message,
      at.last_error AS attempt_error,
      at.window_title AS attempt_window_title,
      at.created_at AS attempt_created_at,
      at.updated_at AS attempt_updated_at
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    LEFT JOIN vps_system.mt5_connect_attempts at ON at.attempt_id = a.current_attempt_id
    WHERE ${where}
    ORDER BY
      CASE
        WHEN LOWER(COALESCE(a.status, '')) IN ('connecting','starting','checking') THEN 0
        WHEN LOWER(COALESCE(a.status, '')) = 'failed' THEN 1
        WHEN LOWER(COALESCE(a.status, '')) = 'connected' THEN 2
        ELSE 3
      END,
      COALESCE(at.updated_at, a.updated_at) DESC NULLS LAST,
      a.id DESC
    LIMIT 1
  `,
    params
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row) {
    return { ok: true, connected: false, status: 'none', message: 'ยังไม่มีรายการเชื่อมต่อ' };
  }

  if (row.attempt_id) {
    const attemptRow = await getAttemptById(row.attempt_id).catch(() => null);
    if (attemptRow) {
      await tryRecoverTimedOutAttempt(attemptRow, row).catch(() => {});
      const refreshed = await query(
        `
        SELECT
          a.id,
          a.status,
          a.last_error,
          a.last_login_message,
          a.vps_id,
          a.port_id,
          a.port_slot,
          a.assigned_port_no,
          a.mt5_login,
          a.server_name,
          a.updated_at,
          a.connect_started_at,
          a.last_balance,
          a.last_equity,
          a.metrics_ready AS account_metrics_ready,
          a.login_verified AS account_login_verified,
          a.current_attempt_id,
          a.mt5_window_title,
          p.folder_path,
          at.attempt_id,
          at.status AS attempt_status,
          at.terminal AS attempt_terminal,
          at.login_verified,
          at.metrics_ready,
          at.journal_verified,
          at.snapshot_verified,
          at.port_health_verified,
          at.observed_login,
          at.port_health_login,
          at.balance AS attempt_balance,
          at.equity AS attempt_equity,
          at.last_message AS attempt_message,
          at.last_error AS attempt_error,
          at.window_title AS attempt_window_title,
          at.created_at AS attempt_created_at,
          at.updated_at AS attempt_updated_at
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        LEFT JOIN vps_system.mt5_connect_attempts at ON at.attempt_id = a.current_attempt_id
        WHERE a.id=$1
        LIMIT 1
      `,
        [Number(row.id)]
      ).catch(() => ({ rows: [] }));
      if (refreshed.rows?.[0]) {
        Object.assign(row, refreshed.rows[0]);
      }
    }
  }

  let status = row.attempt_id ? attemptDisplayStatus(row.attempt_status || row.status) : normalizeAttemptStatus(row.status);
  const terminalConnectedProof = Boolean(
    row.attempt_terminal && (
      row.journal_verified
      || row.login_verified
      || row.account_login_verified
      || (row.snapshot_verified && row.port_health_verified)
    )
  );
  const terminalFailedProof = Boolean(
    row.attempt_terminal && normalizeAttemptStatus(row.attempt_status || '') === 'failed'
  );
  if (terminalConnectedProof) status = 'connected';
  if (terminalFailedProof) status = 'failed';
  const connected = status === 'connected';
  const failed = status === 'failed';
  const pending = ['starting', 'checking'].includes(status);
  const balance = positiveMoney(row.attempt_balance) ?? positiveMoney(row.last_balance);
  const equity = positiveMoney(row.attempt_equity) ?? positiveMoney(row.last_equity);
  const metricsReady = Boolean(balance || equity || row.metrics_ready || row.account_metrics_ready);
  const message = connected
    ? clean(row.attempt_message || row.last_login_message) || MT5_SUCCESS_MSG
    : failed
      ? clean(row.attempt_error || row.last_error || row.attempt_message || row.last_login_message) || MT5_FAIL_USER_MSG
      : clean(row.attempt_message || row.last_login_message) || 'กำลังเปิด MT5 และรอ verifier...';
  const title = clean(row.attempt_window_title || row.mt5_window_title || windowTitleFromMessage(message));
  const previewPath = previewPublicPath(row.id);
  const updatedAt = row.attempt_updated_at || row.updated_at || row.attempt_created_at || row.connect_started_at;
  const startedAt = row.attempt_created_at || row.connect_started_at || updatedAt;
  const elapsedSec = startedAt ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)) : 0;
  const timeoutSec = Math.max(0, Math.floor(ATTEMPT_TIMEOUT_MS / 1000));
  const remainingSec = pending ? Math.max(0, timeoutSec - elapsedSec) : 0;
  const step = getConnectStepMeta(row, status, metricsReady);

  return {
    ok: true,
    account: {
      ...row,
      status,
      updated_at: updatedAt
    },
    attemptId: row.attempt_id || row.current_attempt_id || null,
    connected,
    failed,
    checking: pending,
    pending,
    status,
    loginVerified: connected,
    metricsReady,
    message,
    windowTitle: title,
    previewUrl: previewPath ? `${previewPath}?t=${Date.now()}` : '',
    elapsedSec,
    remainingSec,
    timeoutSec,
    step,
    observedLogin: clean(row.observed_login),
    balance,
    equity
  };
}

module.exports = {
  ATTEMPT_TIMEOUT_MS,
  attemptDisplayStatus,
  createConnectAttempt,
  ensureAttemptVerificationCommands,
  ensureMt5ConnectAttemptTables,
  expireStaleConnectAttempts,
  finalizeAttemptConnected,
  finalizeAttemptFailed,
  getAttemptById,
  getConnectStatusForUser,
  ingestCommandResultEvent,
  ingestConnectResultEvent,
  ingestPortHealthEvent,
  maybeFinalizeAttempt,
  resolveAttempt
};
