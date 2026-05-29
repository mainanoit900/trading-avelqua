'use strict';

const crypto = require('crypto');
const { query } = require('../config/database');
const {
  ensureMt5PreviewColumns,
  patchAccountMt5Preview,
  previewPublicPath,
  windowTitleFromMessage
} = require('./mt5Preview');
const { runSchemaOnce } = require('./schemaOnce');
const { parseMt5JournalOutcome, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('./mt5JournalVerify');
const {
  promoteAccountConnected,
  failAccountFromJournal,
  verifyPortRunningLogin,
  verifyPortRunningForEquityFetch,
  hasInflightLoginCommand,
  getSuccessfulLoginCommandForAttempt,
  loginCommandJournalVerified
} = require('./mt5LoginCommandVerify');

const ATTEMPT_TIMEOUT_MS = Number(process.env.MT5_CONNECT_ATTEMPT_TIMEOUT_MS || 180000);
const COMMAND_DEDUP_MS = Number(process.env.MT5_CONNECT_ATTEMPT_COMMAND_DEDUP_MS || 20000);
const LOGIN_EQUITY_FETCH_MAX = Number(process.env.MT5_LOGIN_EQUITY_FETCH_MAX || 8);
const LOGIN_EQUITY_FETCH_MIN_GAP_MS = Number(process.env.MT5_LOGIN_EQUITY_FETCH_MIN_GAP_MS || 4000);

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

/** Balance/Equity สำหรับยืนยันเชื่อมต่อ — อนุญาต 0 (บัญชี demo) */
function moneyMetric(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveAttemptMetrics(attempt, balance, equity) {
  const bal = moneyMetric(balance) ?? moneyMetric(attempt?.balance);
  const eq = moneyMetric(equity) ?? moneyMetric(attempt?.equity);
  return { balance: bal, equity: eq, ready: bal !== null || eq !== null };
}

function resolveExplicitMetrics(balance, equity) {
  const bal = moneyMetric(balance);
  const eq = moneyMetric(equity);
  return { balance: bal, equity: eq, ready: bal !== null || eq !== null };
}

const FINALIZE_EQUITY_SOURCES = new Set([
  'login_equity_fetch',
  'snapshot',
  'connect_result_equity',
  'login_command_metrics',
  'login_command_post_metrics',
  'cached_equity',
  'journal',
  'journal_command',
  'attempt_verifier'
]);

async function hasSuccessfulLoginCommand(attempt) {
  if (!attempt?.vps_id || !attempt?.attempt_id) return false;
  const r = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND COALESCE(payload->>'attemptId', '') = $2
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
    LIMIT 1
  `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [] }));
  return Boolean(r.rows?.[0]);
}

async function hasSuccessfulLoginEquityFetch(attempt) {
  if (!attempt?.vps_id || !attempt?.attempt_id) return false;
  const r = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type = 'account_snapshot'
      AND COALESCE(payload->>'attemptId', '') = $2
      AND COALESCE(payload->>'purpose', '') = 'login_equity_fetch'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
    LIMIT 1
  `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [] }));
  return Boolean(r.rows?.[0]);
}

async function canFinalizeAttemptWithMetrics(attempt, evidenceSource, balance, equity) {
  const explicit = resolveExplicitMetrics(balance, equity);
  if (!explicit.ready) return false;
  const source = clean(evidenceSource).toLowerCase();
  if (FINALIZE_EQUITY_SOURCES.has(source)) {
    if (source === 'cached_equity') return true;
    if (['connect_result_equity', 'connect_result', 'login_command_post_metrics', 'login_command_metrics'].includes(source)) {
      return hasSuccessfulLoginCommand(attempt);
    }
    return true;
  }
  if (attempt?.journal_verified || attempt?.snapshot_verified) {
    return hasSuccessfulLoginCommand(attempt);
  }
  return hasSuccessfulLoginEquityFetch(attempt);
}

function attemptHasVerifiedLoginProof(attempt) {
  return Boolean(
    attempt?.journal_verified
    || attempt?.snapshot_verified
    || attempt?.port_health_verified
    || attemptHasWindowLoginProof(attempt)
  );
}

async function tryPromoteVerifiedLoginAttempt(attempt, opts = {}) {
  if (!attempt?.attempt_id) return false;
  const fresh = await getAttemptById(attempt.attempt_id).catch(() => null);
  if (!fresh || isAttemptTerminal(fresh.status)) return false;
  if (!(await hasSuccessfulLoginCommand(fresh))) return false;
  if (!attemptHasVerifiedLoginProof(fresh)) return false;

  const metrics = resolveAttemptMetrics(fresh, opts.balance, opts.equity);
  if (!metrics.ready) return false;

  const evidenceSource = clean(opts.evidenceSource) || 'login_command_post_metrics';
  if (!(await canFinalizeAttemptWithMetrics(fresh, evidenceSource, metrics.balance, metrics.equity))) {
    return false;
  }

  const fin = await finalizeAttemptConnected(fresh, {
    message: clean(opts.message) || MT5_SUCCESS_MSG,
    evidenceSource,
    observedLogin: clean(opts.observedLogin) || clean(fresh.observed_login) || clean(fresh.mt5_login),
    balance: metrics.balance,
    equity: metrics.equity,
    processId: opts.processId !== undefined ? opts.processId : fresh.process_id
  }).catch(() => null);

  return Boolean(
    fin
    && (fin.status === 'connected' || normalizeAttemptStatus(fin?.status) === 'connected')
  );
}

function attemptLoginComplete(attempt, row = null) {
  if (Boolean(attempt?.metrics_ready || attempt?.login_verified)) return true;
  if (Boolean(row?.metrics_ready || row?.account_metrics_ready || row?.login_verified || row?.account_login_verified)) {
    return true;
  }
  const src = clean(attempt?.evidence_source || row?.evidence_source);
  return src === 'verified_without_equity_poll';
}

function attemptMetricsSatisfied(attempt, balance, equity, row = null) {
  const metrics = resolveAttemptMetrics(attempt, balance, equity);
  return metrics.ready || attemptLoginComplete(attempt, row);
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
  const purposeType = clean(row?.purpose_type || 'login_only').toLowerCase();
  const message = clean(row?.attempt_message || row?.last_login_message);
  const lowerMessage = message.toLowerCase();
  const hasWindow = Boolean(clean(row?.attempt_window_title || row?.mt5_window_title));
  const hasJournal = Boolean(row?.journal_verified) || /journal|authorized on|ยืนยันเลขบัญชีแล้ว/.test(lowerMessage);
  const hasSnapshot = Boolean(row?.snapshot_verified || clean(row?.observed_login) || metricsReady);

  const loginVerified = Boolean(
    row?.login_verified
    || row?.account_login_verified
    || row?.metrics_ready
    || row?.account_metrics_ready
  );

  if (st === 'connected' && metricsReady) {
    const detail =
      purposeType === 'bot_run'
        ? 'ยืนยันเลขบัญชีและ Equity แล้ว — MT5 เปิดค้างไว้รัน BOT'
        : 'ยืนยันเลขบัญชีและ Equity แล้ว — MT5 ปิดแล้ว พร้อม Run BOT';
    return {
      key: 'connected',
      index: 4,
      total: 4,
      label: purposeType === 'bot_run' ? 'ขั้นตอน 4/4: พร้อมรัน BOT' : 'ขั้นตอน 4/4: ยืนยันสำเร็จ',
      detail
    };
  }

  if (st === 'connected' && !metricsReady) {
    return {
      key: 'metrics',
      index: 4,
      total: 4,
      label: 'ขั้นตอน 4/4: กำลังดึง Equity',
      detail: 'ยืนยันเลขบัญชีแล้ว กำลังดึงยอด Equity จาก MT5...'
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

function loginFromWindowTitle(title, expectedLogin = '') {
  const t = clean(title);
  if (!t) return '';
  const segments = t.split('|').map((s) => s.trim()).filter(Boolean);
  const expected = exactLogin(expectedLogin);
  for (const seg of segments.length ? segments : [t]) {
    const m = seg.match(/^(\d{6,10})\s*[-:]/);
    const found = m ? m[1] : '';
    if (!found) continue;
    if (expected && isExactLoginMatch(expectedLogin, found)) return found;
    if (expected && found !== expected) continue;
    if (!expected) return found;
  }
  if (expected && t.includes(String(expectedLogin))) return exactObservedLogin(expectedLogin);
  return '';
}

function detectWindowTitleLoginMismatch(title, expectedLogin) {
  const expected = exactLogin(expectedLogin);
  const t = clean(title);
  if (!expected || !t) return null;
  const segments = t.split('|').map((s) => s.trim()).filter(Boolean);
  for (const seg of segments.length ? segments : [t]) {
    const m = seg.match(/^(\d{6,10})\s*[-:]/);
    if (m && m[1] && m[1] !== expected) return m[1];
  }
  return null;
}

function journalDateStamps() {
  const offsetMin = Number(process.env.MT5_JOURNAL_TZ_OFFSET_MIN || 420);
  const stamps = new Set();
  const now = Date.now();
  for (let dayShift = -1; dayShift <= 1; dayShift += 1) {
    const local = new Date(now + offsetMin * 60 * 1000 + dayShift * 86400000);
    stamps.add(local.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  stamps.add(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  return [...stamps].sort((a, b) => b.localeCompare(a));
}

function journalLogPathsForFolder(folderPath) {
  const base = String(folderPath || '').trim().replace(/[\\/]+$/, '');
  if (!base) return [];
  const altBase = base.replace(/MT5_PORTS/gi, 'MT5_PORTs');
  const bases = [...new Set([base, altBase].filter(Boolean))];
  const paths = [];
  const dates = journalDateStamps();
  for (const b of bases) {
    for (const d of dates) {
      paths.push(`${b}\\logs\\${d}.log`);
      paths.push(`${b}\\Logs\\${d}.log`);
      paths.push(`${b}\\MQL5\\Logs\\${d}.log`);
    }
  }
  return [...new Set(paths)];
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
  if (st !== 'failed') return null;
  if (!canRecoverFailedAttemptAsConnected(attempt, 'port_health_recovery')) {
    if (st !== 'failed') return null;
    if (!attemptHasLivePortProof(attempt, accountRow)) return null;
    const failMsg = clean(attempt?.last_error || attempt?.last_message).toLowerCase();
    if (!/ไม่สามารถยืนยัน login จาก mt5 ได้ทันเวลา|timed out|timeout|attempt_timeout/.test(failMsg)) {
      return null;
    }
  }

  const expected = clean(attempt.mt5_login);
  const bal = moneyMetric(attempt.balance) ?? moneyMetric(accountRow?.last_balance);
  const eq = moneyMetric(attempt.equity) ?? moneyMetric(accountRow?.last_equity);
  const observed = clean(attempt.observed_login) || expected;

  if (!(bal || eq)) {
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

async function ensureMt5ConnectAttemptTablesCore() {
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
  await query(`
    ALTER TABLE vps_system.mt5_connect_attempts
    ADD COLUMN IF NOT EXISTS purpose_type TEXT DEFAULT 'login_only'
  `).catch(() => {});
}

function ensureMt5ConnectAttemptTables() {
  return runSchemaOnce('mt5-connect-attempt-tables', ensureMt5ConnectAttemptTablesCore);
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
  commandId = null,
  purposeType = 'login_only'
}) {
  await ensureMt5ConnectAttemptTables();
  const attemptId = crypto.randomUUID();
  const purpose = clean(purposeType) || 'login_only';
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
    commandId ? Number(commandId) : null,
    purpose
  ];
  await query(
    `
    INSERT INTO vps_system.mt5_connect_attempts
    (attempt_id, account_id, user_id, vps_id, port_id, port_slot, assigned_port_no, folder_path,
     mt5_login, server_name, command_id, purpose_type, status, terminal, login_verified, metrics_ready,
     last_message, created_at, updated_at)
    VALUES
    ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',FALSE,FALSE,FALSE,'กำลังส่งคำสั่งเปิด MT5...',NOW(),NOW())
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
    SELECT at.*, a.current_attempt_id, a.mt5_password, a.mt5_login AS account_mt5_login
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

async function shouldProcessAttemptCommand(attempt) {
  if (!attempt?.account_id || !attempt?.attempt_id) return false;
  const acc = await query(
    `
    SELECT LOWER(COALESCE(status, '')) AS status, current_attempt_id
    FROM vps_system.mt5_accounts
    WHERE id = $1
    LIMIT 1
  `,
    [Number(attempt.account_id)]
  ).catch(() => ({ rows: [] }));
  const row = acc.rows?.[0];
  if (!row) return false;
  const accountStatus = String(row.status || '').trim();
  if (['deleted', 'cancelled', 'expired'].includes(accountStatus)) return false;
  const currentId = clean(row.current_attempt_id);
  if (currentId && currentId !== String(attempt.attempt_id)) return false;
  if (!currentId && isAttemptTerminal(attempt.status)) return false;
  if (['failed', 'cancelled', 'expired'].includes(normalizeAttemptStatus(attempt.status))) return false;
  return true;
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
  if (!(await shouldProcessAttemptCommand(attempt))) return false;
  const dedupMs =
    String(purpose || '').includes('login_equity_fetch')
      ? Math.max(COMMAND_DEDUP_MS, LOGIN_EQUITY_FETCH_MIN_GAP_MS)
      : COMMAND_DEDUP_MS;
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
    [Number(attempt.vps_id), String(commandType), String(attempt.attempt_id), String(purpose), String(dedupMs)]
  ).catch(() => ({ rows: [] }));
  if (recent.rows?.[0]) return false;

  const ins = await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1,$1,$2,$3,$4::jsonb,'pending',NOW(),NOW())
    RETURNING id
  `,
    [Number(attempt.vps_id), attempt.port_id ? Number(attempt.port_id) : null, commandType, JSON.stringify(payload)]
  ).catch(() => ({ rows: [] }));
  const cmdId = Number(ins.rows?.[0]?.id || 0);
  if (cmdId) {
    const { notifyVpsAgentCommandQueued } = require('./vpsAgentCommandNotify');
    notifyVpsAgentCommandQueued({
      vpsId: Number(attempt.vps_id),
      commandId: cmdId,
      commandType
    }).catch(() => {});
  }
  return cmdId > 0;
}

async function cancelPendingVerifyForAttempt(attempt) {
  if (!attempt?.vps_id) return;
  const attemptId = String(attempt.attempt_id || '');
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        finished_at=NOW(),
        updated_at=NOW(),
        result_message='cancelled_after_connected'
    WHERE (vps_id=$1 OR node_id=$1)
      AND LOWER(COALESCE(status, '')) = 'pending'
      AND command_type IN ('account_snapshot', 'port_read_file', 'sync_mt5_account', 'read_account_metrics')
      AND (
        COALESCE(payload->>'attemptId', '') = $2
        OR ($3::int > 0 AND port_id=$3)
      )
  `,
    [Number(attempt.vps_id), attemptId, attempt.port_id ? Number(attempt.port_id) : 0]
  ).catch(() => {});
}

async function hasInflightMismatchLoginRetry(attempt) {
  if (!attempt?.vps_id || !attempt?.attempt_id) return false;
  const r = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND COALESCE(payload->>'attemptId', '') = $2
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND COALESCE(payload->>'purpose', '') LIKE 'title_mismatch_retry%'
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running', 'in_progress')
    LIMIT 1
    `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [] }));
  return Boolean(r.rows?.[0]);
}

async function queueLoginRetryAfterMismatch(attempt, wrongLogin = '') {
  if (!attempt?.vps_id || !attempt?.assigned_port_no || !attempt?.account_id) return false;
  if (!clean(attempt.mt5_password)) return false;

  const metrics = resolveAttemptMetrics(attempt);
  if (normalizeAttemptStatus(attempt.status) === 'connected' && metrics.ready) {
    return false;
  }

  const recent = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND COALESCE(payload->>'attemptId', '') = $2
      AND COALESCE(payload->>'purpose', '') LIKE 'title_mismatch_retry%'
      AND created_at > NOW() - INTERVAL '15 minutes'
    LIMIT 1
    `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [] }));
  if (recent.rows?.[0]) return false;

  const common = {
    attemptId: String(attempt.attempt_id),
    accountId: Number(attempt.account_id),
    userId: attempt.user_id ? Number(attempt.user_id) : undefined,
    mt5Login: clean(attempt.mt5_login),
    mt5Password: clean(attempt.mt5_password),
    password: clean(attempt.mt5_password),
    serverName: clean(attempt.server_name) || undefined,
    botCode: 'LOGIN_ONLY',
    portId: attempt.port_id ? Number(attempt.port_id) : undefined,
    portSlot: attempt.port_slot ? Number(attempt.port_slot) : undefined,
    port: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    portNo: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    portNumber: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    port_no: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    vpsFolderPath: clean(attempt.folder_path) || undefined,
    folder_path: clean(attempt.folder_path) || undefined,
    folderPath: clean(attempt.folder_path) || undefined,
    purpose: 'title_mismatch_retry',
    forceKill: true,
    closeMt5: true,
    clearSession: true,
    wrongLogin: clean(wrongLogin) || undefined
  };

  await cancelPendingVerifyForAttempt(attempt);

  await queueAttemptCommand(
    attempt,
    'stop_mt5',
    { ...common, reason: 'title_mismatch_retry' },
    'title_mismatch_retry_stop'
  );
  await queueAttemptCommand(
    attempt,
    'login_mt5',
    { ...common, action: 'login_mt5', commandType: 'login_mt5' },
    'title_mismatch_retry'
  );
  return true;
}

async function handleTitleMismatchRetry(attempt, titleMismatch, mt5Login, windowTitle) {
  const metrics = resolveAttemptMetrics(attempt);
  const attemptConnected =
    normalizeAttemptStatus(attempt.status) === 'connected'
    || (attempt.terminal && normalizeAttemptStatus(attempt.status) === 'connected');
  if (attemptConnected && metrics.ready) {
    await syncAccountFromTerminalConnectedAttempt(attempt, {
      message: attempt.last_message || MT5_SUCCESS_MSG,
      balance: metrics.balance,
      equity: metrics.equity
    }).catch(() => {});
    return { ok: true, status: 'connected', attemptId: attempt.attempt_id };
  }

  if (await hasInflightMismatchLoginRetry(attempt)) {
    await markAttemptProgress(attempt, {
      status: 'checking',
      message: `กำลัง login ${mt5Login} ใหม่หลังล้าง session เก่า (${titleMismatch})...`,
      windowTitle: windowTitle || undefined,
      lastError: null
    }).catch(() => {});
    return { ok: true, pending: true, status: 'checking', attemptId: attempt.attempt_id, retry: true };
  }

  const retried = await queueLoginRetryAfterMismatch(attempt, titleMismatch);
  if (!retried) {
    return finalizeAttemptFailed(
      attempt,
      `บัญชีบน MT5 ไม่ตรง (เห็น ${titleMismatch} แต่กรอก ${mt5Login})`,
      {
        evidenceSource: 'window_title_mismatch',
        windowTitle: windowTitle || undefined
      }
    );
  }
  await markAttemptProgress(attempt, {
    status: 'checking',
    message: `พบ session เก่า (${titleMismatch}) — กำลังล้าง PORT และ login ${mt5Login} ใหม่...`,
    windowTitle: windowTitle || undefined,
    lastError: null
  }).catch(() => {});
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='checking',
        last_error=NULL,
        last_login_message=$2,
        updated_at=NOW()
    WHERE id=$1
  `,
    [Number(attempt.account_id), `กำลังล้าง session เก่าและ login ${mt5Login} ใหม่...`]
  ).catch(() => {});
  return { ok: true, pending: true, status: 'checking', attemptId: attempt.attempt_id, retry: true };
}

async function queueForceStopMt5ForAttempt(attempt, reason = 'post_connect_exit') {
  if (!attempt?.vps_id || !attempt?.assigned_port_no) return false;
  const payload = {
    port: Number(attempt.assigned_port_no),
    portNumber: Number(attempt.assigned_port_no),
    portSlot: attempt.port_slot ? Number(attempt.port_slot) : undefined,
    folder_path: clean(attempt.folder_path) || undefined,
    vpsFolderPath: clean(attempt.folder_path) || undefined,
    forceKill: true,
    closeMt5: true,
    reason,
    attemptId: String(attempt.attempt_id),
    accountId: Number(attempt.account_id),
    mt5Login: clean(attempt.mt5_login)
  };
  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1,$1,$2,'stop_mt5',$3::jsonb,'pending',NOW(),NOW())
  `,
    [Number(attempt.vps_id), attempt.port_id ? Number(attempt.port_id) : null, JSON.stringify(payload)]
  ).catch(() => {});
  return true;
}

async function queueLoginExitMt5(attempt) {
  if (!attempt?.vps_id || !attempt?.assigned_port_no) return false;
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
    folderPath: clean(attempt.folder_path) || undefined,
    purpose: 'post_connect_exit'
  };
  return queueAttemptCommand(attempt, 'login_exit_mt5', common, 'post_connect_exit');
}

/** หลัง connected: คิวปิด MT5 เสมอ (กัน insert เงียบ + unique pending ชนกัน) */
async function queuePostConnectExitCommands(attempt) {
  const purpose = clean(attempt?.purpose_type || 'login_only').toLowerCase();
  if (purpose === 'bot_run') {
    return { ok: true, skipped: true, reason: 'bot_run_keep_open' };
  }
  const metrics = resolveAttemptMetrics(attempt);
  if (!metrics.ready) {
    return { ok: false, skipped: true, reason: 'METRICS_NOT_READY' };
  }
  const equityProof =
    attempt?.journal_verified
    || attempt?.snapshot_verified
    || FINALIZE_EQUITY_SOURCES.has(clean(attempt?.evidence_source).toLowerCase())
    || (await hasSuccessfulLoginEquityFetch(attempt).catch(() => false))
    || (
      (await hasSuccessfulLoginCommand(attempt).catch(() => false))
      && resolveAttemptMetrics(attempt).ready
      && attemptHasVerifiedLoginProof(attempt)
    );
  if (!equityProof) {
    return { ok: false, skipped: true, reason: 'EQUITY_FETCH_REQUIRED' };
  }
  const vpsId = Number(attempt?.vps_id || 0);
  const portId = attempt?.port_id ? Number(attempt.port_id) : 0;
  const portNo = Number(attempt?.assigned_port_no || 0);
  if (!vpsId || !portNo) return { ok: false, reason: 'NO_PORT' };

  const attemptId = clean(attempt?.attempt_id);
  if (attemptId) {
    const existing = await query(
      `
      SELECT id
      FROM vps_system.vps_agent_commands
      WHERE (vps_id=$1 OR node_id=$1)
        AND command_type IN ('login_exit_mt5', 'stop_mt5')
        AND COALESCE(payload->>'attemptId', '') = $2
        AND COALESCE(payload->>'purpose', '') = 'post_connect_exit'
        AND (
          LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running')
          OR (
            LOWER(COALESCE(status, '')) = 'success'
            AND updated_at > NOW() - INTERVAL '10 minutes'
          )
        )
      LIMIT 1
    `,
      [vpsId, attemptId]
    ).catch(() => ({ rows: [] }));
    if (existing.rows?.[0]) {
      return { ok: true, skipped: true, reason: 'ALREADY_QUEUED', id: existing.rows[0].id };
    }
  }

  await cancelPendingVerifyForAttempt(attempt).catch(() => {});

  if (portId) {
    await query(
      `
      UPDATE vps_system.vps_agent_commands
      SET status='cancelled',
          finished_at=NOW(),
          updated_at=NOW(),
          result_message='replaced_post_connect_exit'
      WHERE (vps_id=$1 OR node_id=$1)
        AND port_id=$2
        AND LOWER(COALESCE(status, '')) = 'pending'
        AND command_type IN ('login_exit_mt5', 'stop_mt5')
    `,
      [vpsId, portId]
    ).catch(() => {});
  }

  const folderPath = clean(attempt.folder_path) || undefined;
  const base = {
    attemptId: String(attempt.attempt_id || ''),
    accountId: Number(attempt.account_id || 0),
    userId: attempt.user_id ? Number(attempt.user_id) : undefined,
    mt5Login: clean(attempt.mt5_login),
    portId: portId || undefined,
    portSlot: attempt.port_slot ? Number(attempt.port_slot) : undefined,
    port: portNo,
    portNo,
    portNumber: portNo,
    port_no: portNo,
    folder_path: folderPath,
    folderPath,
    vpsFolderPath: folderPath,
    purpose: 'post_connect_exit'
  };

  const queued = { login_exit_mt5: null, stop_mt5: null };

  try {
    const exitRes = await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1,$1,$2,'login_exit_mt5',$3::jsonb,'pending',NOW(),NOW())
      RETURNING id
    `,
      [vpsId, portId || null, JSON.stringify({ ...base, purpose: 'post_connect_exit' })]
    );
    queued.login_exit_mt5 = exitRes.rows?.[0]?.id || null;
  } catch (e) {
    console.error('[POST_CONNECT_EXIT] login_exit_mt5', e.message);
  }

  try {
    const stopRes = await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1,$1,$2,'stop_mt5',$3::jsonb,'pending',NOW(),NOW())
      RETURNING id
    `,
      [
        vpsId,
        portId || null,
        JSON.stringify({
          ...base,
          forceKill: true,
          closeMt5: true,
          reason: 'post_connect_exit'
        })
      ]
    );
    queued.stop_mt5 = stopRes.rows?.[0]?.id || null;
  } catch (e) {
    console.error('[POST_CONNECT_EXIT] stop_mt5', e.message);
  }

  if (queued.login_exit_mt5 || queued.stop_mt5) {
    console.log('[POST_CONNECT_EXIT] queued', {
      attemptId: attempt.attempt_id,
      portNo,
      ...queued
    });
  }
  return { ok: Boolean(queued.login_exit_mt5 || queued.stop_mt5), ...queued };
}

function attemptHasWindowLoginProof(attempt) {
  const expected = clean(attempt?.mt5_login);
  if (!expected) return false;
  if (attempt?.snapshot_verified) return true;
  if (isExactLoginMatch(expected, attempt?.observed_login)) return true;
  const title = clean(attempt?.window_title);
  return Boolean(title && title.includes(expected));
}

function snapshotLoginMatches(expectedLogin, observedLogin, portProofOk = false) {
  const expected = clean(expectedLogin);
  const observed = clean(observedLogin);
  if (!expected) return false;
  if (observed && !isExactLoginMatch(expected, observed)) return false;
  if (isExactLoginMatch(expected, observed)) return true;
  return Boolean(portProofOk && !observed);
}

async function countLoginEquityFetchCommands(attempt) {
  if (!attempt?.vps_id || !attempt?.attempt_id) return 0;
  const r = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='account_snapshot'
      AND COALESCE(payload->>'attemptId', '')=$2
      AND COALESCE(payload->>'purpose', '')='login_equity_fetch'
      AND created_at > NOW() - INTERVAL '8 minutes'
  `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  return Number(r.rows?.[0]?.c || 0);
}

async function hasInflightLoginEquityFetch(attempt) {
  if (!attempt?.vps_id || !attempt?.attempt_id) return false;
  const r = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='account_snapshot'
      AND COALESCE(payload->>'attemptId', '')=$2
      AND COALESCE(payload->>'purpose', '')='login_equity_fetch'
      AND LOWER(COALESCE(status, '')) IN ('pending','queued','picked','processing','running')
    LIMIT 1
  `,
    [Number(attempt.vps_id), String(attempt.attempt_id)]
  ).catch(() => ({ rows: [] }));
  return Boolean(r.rows?.[0]);
}

async function queueLoginEquityFetch(attempt) {
  if (!attempt?.vps_id || !attempt?.account_id) return false;
  if (!(await shouldProcessAttemptCommand(attempt))) return false;
  if (await hasSuccessfulLoginEquityFetch(attempt)) return false;

  const metrics = resolveAttemptMetrics(attempt);
  if (metrics.ready && (await hasSuccessfulLoginCommand(attempt))) {
    const promoted = await tryPromoteVerifiedLoginAttempt(attempt).catch(() => false);
    if (promoted) return false;
  }

  if (
    await hasInflightLoginCommand(attempt)
    && !attempt.journal_verified
    && !attemptHasWindowLoginProof(attempt)
  ) {
    console.warn('[LOGIN_EQUITY_FETCH] login still in progress', attempt.attempt_id);
    return false;
  }

  if (await hasInflightLoginEquityFetch(attempt)) return false;

  const recentCount = await countLoginEquityFetchCommands(attempt);
  if (recentCount >= LOGIN_EQUITY_FETCH_MAX) {
    console.warn('[LOGIN_EQUITY_FETCH] max attempts', attempt.attempt_id, recentCount);
    return false;
  }

  const portProof =
    attempt.vps_id && attempt.assigned_port_no && attempt.mt5_login
      ? await verifyPortRunningForEquityFetch(
          Number(attempt.vps_id),
          Number(attempt.assigned_port_no),
          clean(attempt.mt5_login),
          attempt
        ).catch(() => ({ ok: false }))
      : { ok: false };
  if (!portProof.ok) {
    console.warn('[LOGIN_EQUITY_FETCH] port not ready', attempt.attempt_id, portProof.reason);
    return false;
  }

  await cancelPendingVerifyForAttempt(attempt).catch(() => {});

  const common = {
    attemptId: String(attempt.attempt_id),
    accountId: Number(attempt.account_id),
    userId: attempt.user_id ? Number(attempt.user_id) : undefined,
    mt5Login: clean(attempt.mt5_login),
    mt5Password: clean(attempt.mt5_password) || undefined,
    password: clean(attempt.mt5_password) || undefined,
    botCode: 'LOGIN_ONLY',
    portId: attempt.port_id ? Number(attempt.port_id) : undefined,
    portSlot: attempt.port_slot ? Number(attempt.port_slot) : undefined,
    port: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    portNo: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    portNumber: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    port_no: attempt.assigned_port_no ? Number(attempt.assigned_port_no) : undefined,
    vpsFolderPath: clean(attempt.folder_path) || undefined,
    folder_path: clean(attempt.folder_path) || undefined,
    folderPath: clean(attempt.folder_path) || undefined,
    purposeType: clean(attempt.purpose_type || 'login_only'),
    keepMt5Open: true
  };

  return queueAttemptCommand(
    attempt,
    'account_snapshot',
    { ...common, purpose: 'login_equity_fetch' },
    'login_equity_fetch'
  );
}

/** บัญชีค้าง checking ทั้งที่ attempt จบ connected แล้ว — sync เมื่อมี Equity จริง */
async function syncAccountFromTerminalConnectedAttempt(attempt, opts = {}) {
  if (!attempt?.account_id || !attempt?.attempt_id) return false;
  const attemptIsCurrent =
    !attempt.current_attempt_id || String(attempt.current_attempt_id) === String(attempt.attempt_id);
  if (!attemptIsCurrent) return false;

  const finalMsg = clean(opts.message) || clean(attempt.last_message) || MT5_SUCCESS_MSG;
  const metrics = resolveAttemptMetrics(attempt, opts.balance, opts.equity);
  if (!metrics.ready) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='checking',
          last_error=NULL,
          last_login_message='กำลังดึง Equity จาก MT5...',
          updated_at=NOW()
      WHERE id=$1
        AND LOWER(COALESCE(status, '')) IN ('connected', 'checking', 'connecting', 'starting')
    `,
      [Number(attempt.account_id)]
    ).catch(() => {});
    await queueLoginEquityFetch(attempt).catch(() => {});
    return false;
  }

  const accRow = await query(
    `SELECT status, login_verified, last_equity, last_balance FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
    [Number(attempt.account_id)]
  ).catch(() => ({ rows: [] }));
  const accStatus = normalizeAttemptStatus(accRow.rows?.[0]?.status);
  if (
    accStatus === 'connected'
    && accRow.rows?.[0]?.login_verified
    && (moneyMetric(accRow.rows?.[0]?.last_equity) !== null || moneyMetric(accRow.rows?.[0]?.last_balance) !== null)
  ) {
    return false;
  }

  await promoteAccountConnected({
    accountId: Number(attempt.account_id),
    portId: attempt.port_id ? Number(attempt.port_id) : null,
    mt5Login: clean(attempt.mt5_login),
    message: finalMsg,
    lockPortAfterLogin: true,
    userId: attempt.user_id ? Number(attempt.user_id) : null,
    balance: metrics.balance,
    equity: metrics.equity,
    requireMetrics: true
  }).catch(() => {});

  await updateAccountForAttempt(attempt, {
    status: 'connected',
    lastError: null,
    lastMessage: finalMsg,
    loginVerified: true,
    metricsReady: true,
    balance: metrics.balance !== null ? metrics.balance : undefined,
    equity: metrics.equity !== null ? metrics.equity : undefined
  }).catch(() => {});

  return true;
}

async function reopenAttemptForMetrics(attempt) {
  if (!attempt?.attempt_id) return false;
  const metrics = resolveAttemptMetrics(attempt);
  if (metrics.ready) return false;
  if (attempt.terminal && attemptLoginComplete(attempt)) {
    return queueLoginEquityFetch(attempt);
  }

  await updateAttemptRow(attempt.attempt_id, {
    status: 'checking',
    terminal: false,
    lastMessage: 'กำลังดึง Equity จาก MT5...',
    lastError: null
  }).catch(() => {});

  const attemptIsCurrent =
    !attempt.current_attempt_id || String(attempt.current_attempt_id) === String(attempt.attempt_id);
  if (attemptIsCurrent) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='checking',
          last_error=NULL,
          last_login_message='กำลังดึง Equity จาก MT5...',
          metrics_ready=FALSE,
          updated_at=NOW()
      WHERE id=$1
        AND LOWER(COALESCE(status, '')) IN ('connected', 'checking', 'connecting', 'starting')
    `,
      [Number(attempt.account_id)]
    ).catch(() => {});
  }

  return queueLoginEquityFetch(attempt);
}

async function repairIncompleteConnectAttempt(row) {
  if (!row?.attempt_id) return row;
  const metrics = resolveAttemptMetrics(row, row.attempt_balance, row.attempt_equity);
  const accountEquity = moneyMetric(row.last_equity) ?? moneyMetric(row.last_balance);
  if (metrics.ready && accountEquity !== null) {
    const accountStatus = normalizeAttemptStatus(row.status);
    const attemptStatus = normalizeAttemptStatus(row.attempt_status || '');
    if (
      row.attempt_terminal
      && attemptStatus === 'connected'
      && accountStatus !== 'connected'
    ) {
      const attempt = await getAttemptById(row.attempt_id).catch(() => null);
      if (attempt) {
        await syncAccountFromTerminalConnectedAttempt(attempt, {
          message: row.attempt_message || row.last_login_message || MT5_SUCCESS_MSG,
          balance: row.attempt_balance ?? row.last_balance,
          equity: row.attempt_equity ?? row.last_equity
        }).catch(() => {});
      }
    }
    return row;
  }
  if (row.attempt_terminal && normalizeAttemptStatus(row.attempt_status || '') === 'connected') {
    const attempt = await getAttemptById(row.attempt_id).catch(() => null);
    if (attempt) {
      await syncAccountFromTerminalConnectedAttempt(attempt, {
        message: row.attempt_message || row.last_login_message,
        balance: row.attempt_balance,
        equity: row.attempt_equity
      }).catch(() => {});
    }
    return row;
  }
  if (attemptLoginComplete(row, row)) return row;

  const accountStatus = normalizeAttemptStatus(row.status);
  const attemptStatus = normalizeAttemptStatus(row.attempt_status || '');
  const needsRepair =
    (attemptStatus === 'connected' && row.attempt_terminal && !attemptLoginComplete(row, row)) ||
    (accountEquity === null && ['checking', 'connecting', 'starting'].includes(accountStatus));
  if (!needsRepair) return row;

  const attempt = await getAttemptById(row.attempt_id).catch(() => null);
  if (!attempt) return row;

  await reopenAttemptForMetrics(attempt).catch(() => {});
  await queueLoginEquityFetch(attempt).catch(() => {});
  return row;
}

async function ensureAttemptVerificationCommands(attempt) {
  if (!attempt) return false;
  const accSt = await query(
    `
    SELECT LOWER(COALESCE(status, '')) AS status
    FROM vps_system.mt5_accounts
    WHERE id = $1
    LIMIT 1
  `,
    [Number(attempt.account_id || 0)]
  ).catch(() => ({ rows: [] }));
  const accountStatus = String(accSt.rows?.[0]?.status || '').trim();
  if (['deleted', 'cancelled', 'expired'].includes(accountStatus)) return false;

  if (normalizeAttemptStatus(attempt.status) === 'checking') {
    if (await tryPromoteVerifiedLoginAttempt(attempt).catch(() => false)) {
      return true;
    }
  }

  const metrics = resolveAttemptMetrics(attempt);
  if (normalizeAttemptStatus(attempt.status) === 'connected') {
    if (!metrics.ready) {
      if (attempt.terminal && attemptLoginComplete(attempt)) {
        return queueLoginEquityFetch(attempt);
      }
      return (await reopenAttemptForMetrics(attempt)) || false;
    }
    const exit = await queuePostConnectExitCommands(attempt).catch(() => ({ ok: false }));
    return Boolean(exit?.ok);
  }
  if (isAttemptTerminal(attempt.status)) return false;
  const ageMs = Date.now() - new Date(attempt.created_at || attempt.updated_at || Date.now()).getTime();
  if (ageMs > ATTEMPT_TIMEOUT_MS) return false;

  const loginCmdDone = await hasSuccessfulLoginCommand(attempt).catch(() => false);
  if (
    loginCmdDone
    && (attemptHasWindowLoginProof(attempt) || attempt.snapshot_verified || attempt.port_health_verified)
  ) {
    return queueLoginEquityFetch(attempt);
  }

  const portProof =
    attempt.vps_id && attempt.assigned_port_no && attempt.mt5_login
      ? await verifyPortRunningForEquityFetch(
          Number(attempt.vps_id),
          Number(attempt.assigned_port_no),
          clean(attempt.mt5_login),
          attempt
        ).catch(() => ({ ok: false }))
      : { ok: false };

  if (portProof.ok || attemptHasWindowLoginProof(attempt) || attempt.journal_verified) {
    if (portProof.ok) {
      await markAttemptProgress(attempt, {
        status: 'checking',
        message: 'เห็น MT5 รันบน VPS แล้ว — กำลังดึง Equity...',
        observedLogin: clean(attempt.mt5_login),
        snapshotVerified: true,
        portHealthVerified: true,
        portHealthLogin: clean(attempt.mt5_login)
      }).catch(() => {});
    }
    return queueLoginEquityFetch(attempt);
  }

  let queued = false;
  const common = {
    attemptId: String(attempt.attempt_id),
    accountId: Number(attempt.account_id),
    userId: attempt.user_id ? Number(attempt.user_id) : undefined,
    mt5Login: clean(attempt.mt5_login),
    mt5Password: clean(attempt.mt5_password) || undefined,
    password: clean(attempt.mt5_password) || undefined,
    botCode: 'LOGIN_ONLY',
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
    queued = await queueAttemptCommand(
      attempt,
      'port_read_file',
      {
        ...common,
        purpose: 'attempt_verify_journal',
        use_latest_journal: true
      },
      'attempt_verify_journal'
    ) || queued;
  }

  queued = await queueLoginEquityFetch(attempt) || queued;

  return queued;
}

async function finalizeAttemptConnected(attempt, {
  message,
  evidenceSource,
  observedLogin,
  balance,
  equity,
  processId
} = {}) {
  if (!attempt?.attempt_id) return { ok: false, reason: 'NO_ATTEMPT' };
  const fresh = await getAttemptById(attempt.attempt_id).catch(() => null);
  if (!fresh) return { ok: false, reason: 'ATTEMPT_NOT_FOUND' };
  const recoverTimedOutFailure = canRecoverFailedAttemptAsConnected(fresh, evidenceSource);
  if (isAttemptTerminal(fresh.status) && !recoverTimedOutFailure) {
    const metrics = resolveAttemptMetrics(fresh, balance, equity);
    if (normalizeAttemptStatus(fresh.status) === 'connected') {
      if (metrics.ready) {
        await syncAccountFromTerminalConnectedAttempt(fresh, { message, balance, equity }).catch(() => {});
        await queuePostConnectExitCommands(fresh).catch(() => {});
      } else {
        await queueLoginEquityFetch(fresh).catch(() => {});
      }
    }
    return {
      ok: true,
      status: metrics.ready ? 'connected' : 'checking',
      attemptId: fresh.attempt_id,
      attempt: fresh
    };
  }

  const metrics = resolveAttemptMetrics(fresh, balance, equity);
  const bal = metrics.balance;
  const eq = metrics.equity;
  if (!metrics.ready) {
    await markAttemptProgress(fresh, {
      status: 'checking',
      message: clean(message) || 'กำลังดึง Equity จาก MT5...',
      observedLogin: observedLogin !== undefined ? exactObservedLogin(observedLogin) : fresh.observed_login,
      balance: bal,
      equity: eq,
      processId: processId !== undefined ? processId : fresh.process_id,
      evidenceSource: clean(evidenceSource) || fresh.evidence_source,
      journalVerified: fresh.journal_verified ? true : undefined,
      snapshotVerified: fresh.snapshot_verified ? true : undefined,
      portHealthVerified: fresh.port_health_verified ? true : undefined
    }).catch(() => {});
    await ensureAttemptVerificationCommands(fresh).catch(() => {});
    return { ok: true, pending: true, reason: 'METRICS_REQUIRED', status: 'checking', attemptId: fresh.attempt_id };
  }
  if (!(await canFinalizeAttemptWithMetrics(fresh, evidenceSource, balance, equity))) {
    await markAttemptProgress(fresh, {
      status: 'checking',
      message: 'Login สำเร็จ — กำลังดึง Equity จาก MT5...',
      observedLogin: observedLogin !== undefined ? exactObservedLogin(observedLogin) : fresh.observed_login,
      balance: bal,
      equity: eq,
      processId: processId !== undefined ? processId : fresh.process_id,
      evidenceSource: clean(evidenceSource) || fresh.evidence_source,
      journalVerified: fresh.journal_verified ? true : undefined,
      snapshotVerified: fresh.snapshot_verified ? true : undefined,
      portHealthVerified: fresh.port_health_verified ? true : undefined
    }).catch(() => {});
    await queueLoginEquityFetch(fresh).catch(() => {});
    return { ok: true, pending: true, reason: 'EQUITY_PROOF_REQUIRED', status: 'checking', attemptId: fresh.attempt_id };
  }
  const metricsReady = metrics.ready;
  const finalMsg = clean(message) || MT5_SUCCESS_MSG;
  const attemptIsCurrent = !fresh.current_attempt_id || String(fresh.current_attempt_id) == String(fresh.attempt_id);

  if (attemptIsCurrent) {
    await promoteAccountConnected({
      accountId: Number(fresh.account_id),
      portId: fresh.port_id ? Number(fresh.port_id) : null,
      mt5Login: clean(fresh.mt5_login),
      message: finalMsg,
      lockPortAfterLogin: true,
      userId: fresh.user_id ? Number(fresh.user_id) : null,
      balance: bal,
      equity: eq,
      requireMetrics: true
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
  }).catch((e) => {
    console.error('[FINALIZE CONNECTED] updateAttemptRow', e.message);
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
    }).catch((e) => {
      console.error('[FINALIZE CONNECTED] updateAccountForAttempt', e.message);
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

  if (metrics.ready) {
    const shouldAutoExit = clean(fresh.purpose_type || 'login_only').toLowerCase() !== 'bot_run';
    if (shouldAutoExit) {
      await queuePostConnectExitCommands(fresh).catch((e) => {
        console.error('[FINALIZE CONNECTED] queuePostConnectExitCommands', e.message);
      });
    } else {
      console.log('[BOT_RUN] keeping MT5 running after connect', {
        accountId: fresh.account_id,
        attemptId: fresh.attempt_id
      });
    }
  } else {
    await queueLoginEquityFetch(fresh).catch(() => {});
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
  if (!attempt) return null;
  if (isAttemptTerminal(attempt.status)) {
    if (normalizeAttemptStatus(attempt.status) === 'connected') {
      const terminalMetrics = resolveAttemptMetrics(attempt);
      if (terminalMetrics.ready) {
        await queuePostConnectExitCommands(attempt).catch(() => {});
      } else if (attemptLoginComplete(attempt)) {
        await queueLoginEquityFetch(attempt).catch(() => {});
      }
    }
    return attempt;
  }

  const expectedLogin = clean(attempt.mt5_login);
  const attemptMetrics = resolveAttemptMetrics(attempt);

  const titleLogin = loginFromWindowTitle(attempt.window_title, expectedLogin);
  if (
    titleLogin
    && isExactLoginMatch(expectedLogin, titleLogin)
    && attemptMetrics.ready
    && (attempt.snapshot_verified || attempt.journal_verified)
  ) {
    await finalizeAttemptConnected(attempt, {
      message: attempt.last_message || MT5_SUCCESS_MSG,
      evidenceSource: 'window_title_recovery',
      observedLogin: titleLogin,
      balance: attempt.balance,
      equity: attempt.equity,
      processId: attempt.process_id
    }).catch(() => {});
    return getAttemptById(attemptId).catch(() => null);
  }

  if (
    attempt.snapshot_verified
    && attemptMetrics.ready
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

  const createdAtMs = attempt.created_at ? new Date(attempt.created_at).getTime() : 0;
  if (
    (attempt.journal_verified || attempt.snapshot_verified || attempt.port_health_verified)
    && !attemptMetrics.ready
  ) {
    await ensureAttemptVerificationCommands(attempt).catch(() => {});
  }

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
  const bal = moneyMetric(balance);
  const eq = moneyMetric(equity);
  const metricsReady = Boolean(bal !== null || eq !== null || base.metrics_ready);
  let nextStatus = normalizeAttemptStatus(status || base.status);
  if (nextStatus === 'connected' && bal === null && eq === null) {
    nextStatus = 'checking';
  }
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
  const windowTitle = clean(body.windowTitle || body.mt5WindowTitle);
  const titleMismatch = detectWindowTitleLoginMismatch(windowTitle, mt5Login);
  if (titleMismatch) {
    return handleTitleMismatchRetry(attempt, titleMismatch, mt5Login, windowTitle);
  }
  const observedLogin =
    clean(body.observedLogin || body.observed_login || body.accountLogin || body.account_login)
    || loginFromWindowTitle(windowTitle, mt5Login);
  if (mt5Login && observedLogin && !isExactLoginMatch(mt5Login, observedLogin)) {
    return handleTitleMismatchRetry(attempt, observedLogin, mt5Login, windowTitle);
  }
  const previewB64 = clean(body.previewImage || body.mt5PreviewImage);
  const pid = body.process_id || body.pid || null;
  const journalEvidence = clean(
    body.journalEvidence || body.journal_evidence || body.journal || body.latestLog || body.logText
  );
  const verdict = journalEvidence && mt5Login ? parseMt5JournalOutcome(journalEvidence, mt5Login) : null;
  const bal = moneyMetric(body.balance);
  const eq = moneyMetric(body.equity);
  const hasMetrics = bal !== null || eq !== null;
  const terminalFailLike = rawStatus === 'failed_auth' || (status === 'failed' && !/timeout|ทันเวลา|รอสักครู่|worker/i.test(message));
  const windowOk =
    (body.windowVerified === true || body.window_verified === true)
    && observedLogin
    && isExactLoginMatch(mt5Login, observedLogin);
  const provenConnected =
    status === 'connected' &&
    (verdict === 'success' ||
      body.loginVerified === true ||
      body.login_verified === true ||
      hasMetrics ||
      windowOk);
  const progressStatus = terminalFailLike
    ? 'failed'
    : status === 'failed' && /timeout|ทันเวลา|รอสักครู่|worker/i.test(message)
      ? 'checking'
      : provenConnected
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

  if (
    hasMetrics
    && observedLogin
    && isExactLoginMatch(mt5Login, observedLogin)
    && (status === 'checking' || status === 'starting' || rawStatus === 'checking')
  ) {
    await markAttemptProgress(mergedAttempt || attempt, {
      status: 'checking',
      message: message || `เห็นบัญชี ${observedLogin} — กำลังดึง Equity...`,
      observedLogin: observedLogin || mt5Login,
      balance: bal,
      equity: eq,
      snapshotVerified: true,
      evidenceSource: 'connect_result_equity_pending',
      rawLastEvent: body
    }).catch(() => {});
    await queueLoginEquityFetch(mergedAttempt || attempt).catch(() => {});
    return { ok: true, pending: true, status: 'checking', attemptId: attempt.attempt_id };
  }

  if (provenConnected) {
    if (!hasMetrics || !(await hasSuccessfulLoginCommand(mergedAttempt || attempt))) {
      await ensureAttemptVerificationCommands(mergedAttempt || attempt).catch(() => {});
      return { ok: true, pending: true, status: 'checking', attemptId: attempt.attempt_id };
    }
    if (await tryPromoteVerifiedLoginAttempt(mergedAttempt || attempt, {
      message: hasMetrics ? 'ยืนยันการเชื่อมต่อจาก MT5 API แล้ว' : message || MT5_SUCCESS_MSG,
      evidenceSource: hasMetrics ? 'connect_result_equity' : verdict === 'success' ? 'journal' : 'connect_result',
      observedLogin: observedLogin || mt5Login,
      balance: bal,
      equity: eq,
      processId: pid || undefined
    }).catch(() => false)) {
      return { ok: true, status: 'connected', attemptId: attempt.attempt_id };
    }
    return finalizeAttemptConnected(mergedAttempt || attempt, {
      message: hasMetrics ? 'ยืนยันการเชื่อมต่อจาก MT5 API แล้ว' : message || MT5_SUCCESS_MSG,
      evidenceSource: hasMetrics ? 'connect_result_equity' : verdict === 'success' ? 'journal' : 'connect_result',
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

  if (
    observedLogin
    && isExactLoginMatch(mt5Login, observedLogin)
    && (status === 'checking' || status === 'starting')
  ) {
    await markAttemptProgress(mergedAttempt || attempt, {
      status: 'checking',
      observedLogin,
      snapshotVerified: true,
      evidenceSource: 'window_title',
      message: message || `เห็นบัญชี ${observedLogin} บนหน้าต่าง MT5 แล้ว — กำลังดึง Equity...`
    }).catch(() => {});
    if (hasMetrics) {
      await markAttemptProgress(mergedAttempt || attempt, {
        status: 'checking',
        observedLogin,
        snapshotVerified: true,
        balance: bal,
        equity: eq,
        evidenceSource: 'connect_result_equity_pending',
        message: message || `เห็นบัญชี ${observedLogin} — กำลังดึง Equity...`
      }).catch(() => {});
      await queueLoginEquityFetch(mergedAttempt || attempt).catch(() => {});
      return { ok: true, pending: true, status: 'checking', attemptId: attempt.attempt_id };
    }
    await queueLoginEquityFetch(mergedAttempt || attempt).catch(() => {});
    const finalized = await maybeFinalizeAttempt(attempt.attempt_id).catch(() => null);
    if (finalized && normalizeAttemptStatus(finalized.status) === 'connected') {
      const finMetrics = resolveAttemptMetrics(finalized);
      if (finMetrics.ready) {
        return { ok: true, status: 'connected', attemptId: attempt.attempt_id };
      }
    }
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
  if (!(await shouldProcessAttemptCommand(attempt))) {
    return { ok: true, ignored: true, reason: 'ACCOUNT_OR_ATTEMPT_INACTIVE' };
  }

  const ctype = clean(commandType).toLowerCase();
  const msg = clean(message || result?.message || result?.status || error);
  const mt5Login = clean(result?.login || payload?.mt5Login || payload?.mt5_login || attempt.mt5_login);

  if (ctype === 'login_mt5') {
    if (!ok) {
      if (/stuck_login|requeued_stuck_login/i.test(msg)) {
        await markAttemptProgress(attempt, {
          status: 'checking',
          message: 'กำลัง Login MT5 บน VPS...',
          rawLastEvent: { ok, result, error, commandId, commandType: ctype }
        }).catch(() => {});
        await ensureAttemptVerificationCommands(attempt).catch(() => {});
        return { ok: true, pending: true, attemptId: attempt.attempt_id };
      }
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
    if (
      result?.verificationPending === true
      || result?.windowVerified === true
      || result?.window_verified === true
    ) {
      await markAttemptProgress(attempt, {
        status: 'checking',
        message: msg || `ยืนยัน ${mt5Login} แล้ว — กำลังดึง Equity...`,
        observedLogin: mt5Login,
        snapshotVerified: true,
        evidenceSource: 'login_command_window_pending',
        processId: result?.process_id || result?.pid || undefined,
        rawLastEvent: { ok, result, commandId, commandType: ctype }
      }).catch(() => {});
      await queueLoginEquityFetch(attempt).catch(() => {});
      await ensureAttemptVerificationCommands(attempt).catch(() => {});
      return { ok: true, pending: true, attemptId: attempt.attempt_id };
    }
    const cmdJournalOk =
      verdict === 'success'
      || result?.journalVerified === true
      || result?.journal_verified === true
      || loginCommandJournalVerified(result, mt5Login);
    await markAttemptProgress(attempt, {
      status: cmdJournalOk || result?.loginVerified === true || result?.login_verified === true ? 'checking' : 'starting',
      message: msg || 'MT5 เริ่มทำงานแล้ว กำลังรอ verifier...',
      processId: result?.process_id || result?.pid || undefined,
      evidenceSource: cmdJournalOk ? 'journal' : 'login_command',
      journalVerified: cmdJournalOk ? true : undefined,
      snapshotVerified: cmdJournalOk ? true : undefined,
      observedLogin: cmdJournalOk ? mt5Login : undefined,
      rawLastEvent: { ok, result, commandId, commandType: ctype }
    }).catch(() => {});

    const loginOk = result?.loginVerified === true || result?.login_verified === true;
    if (loginOk || cmdJournalOk) {
      const loginMetrics = resolveExplicitMetrics(result?.balance, result?.equity);
      if (loginMetrics.ready) {
        return finalizeAttemptConnected(attempt, {
          message: msg || MT5_SUCCESS_MSG,
          evidenceSource: loginOk ? 'login_command_metrics' : 'journal',
          observedLogin: clean(result?.observedLogin || result?.observed_login) || mt5Login,
          balance: loginMetrics.balance,
          equity: loginMetrics.equity,
          processId: result?.process_id || result?.pid || undefined
        });
      }
      await queueLoginEquityFetch(attempt).catch(() => {});
      if (await tryPromoteVerifiedLoginAttempt(attempt, {
        message: msg || MT5_SUCCESS_MSG,
        evidenceSource: 'login_command_post_metrics',
        observedLogin: clean(result?.observedLogin || result?.observed_login) || mt5Login,
        processId: result?.process_id || result?.pid || undefined
      }).catch(() => false)) {
        return { ok: true, status: 'connected', attemptId: attempt.attempt_id };
      }
      return { ok: true, pending: true, attemptId: attempt.attempt_id };
    }

    if (result?.windowVerified === true || result?.window_verified === true) {
      const titleLogin =
        loginFromWindowTitle(clean(result?.windowTitle || result?.window_title || attempt.window_title), mt5Login)
        || mt5Login;
      await markAttemptProgress(attempt, {
        status: 'checking',
        message: msg || `เห็นบัญชี ${mt5Login} บนหน้าต่าง MT5 แล้ว — กำลังดึง Equity...`,
        observedLogin: titleLogin,
        snapshotVerified: true,
        evidenceSource: 'login_command_window',
        processId: result?.process_id || result?.pid || undefined,
        rawLastEvent: { ok, result, commandId, commandType: ctype }
      }).catch(() => {});
      await queueLoginEquityFetch(attempt).catch(() => {});
      return { ok: true, pending: true, attemptId: attempt.attempt_id };
    }

    await queueLoginEquityFetch(attempt).catch(() => {});
    return { ok: true, pending: true, attemptId: attempt.attempt_id };
  }

  if (
    (ctype === 'port_read_file' || ctype === 'read_file')
    && /verify_journal|attempt_verify_journal/i.test(clean(payload?.purpose))
  ) {
    if (!ok && (result?.journalMissing || /file not found/i.test(msg))) {
      await queueLoginEquityFetch(attempt).catch(() => {});
      return { ok: true, pending: true, attemptId: attempt.attempt_id };
    }
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
    const portProofJournal =
      attempt.vps_id && attempt.assigned_port_no
        ? await verifyPortRunningForEquityFetch(
            Number(attempt.vps_id),
            Number(attempt.assigned_port_no),
            mt5Login,
            attempt
          ).catch(() => ({ ok: false }))
        : { ok: false };
    if (!verdict && portProofJournal.ok) {
      await markAttemptProgress(attempt, {
        status: 'checking',
        message: 'Journal ยังไม่ชัด — ใช้ port health ยืนยันแล้ว กำลังดึง Equity...',
        observedLogin: mt5Login,
        snapshotVerified: true,
        portHealthVerified: true,
        portHealthLogin: mt5Login
      }).catch(() => {});
      await queueLoginEquityFetch(attempt).catch(() => {});
      return { ok: true, pending: true, attemptId: attempt.attempt_id };
    }
    if (verdict === 'success') {
      await queueLoginEquityFetch(attempt).catch(() => {});
      return { ok: true, pending: true, attemptId: attempt.attempt_id };
    }
    return { ok: true, pending: true, attemptId: attempt.attempt_id };
  }

  if (['account_snapshot', 'sync_mt5_account', 'read_account_metrics'].includes(ctype)) {
    const snap = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : result || {};
    const apiMismatch = snap.loginMismatch === true || result?.loginMismatch === true;
    const observed =
      clean(
        result?.observedLogin
          || snap.observedLogin
          || snap.observed_login
          || snap.login
          || snap.accountLogin
          || snap.account_login
      )
      || loginFromWindowTitle(clean(attempt.window_title), mt5Login);
    const balance = moneyMetric(snap.balance ?? result?.balance);
    const equity = moneyMetric(snap.equity ?? result?.equity);
    const portProof =
      attempt.vps_id && attempt.assigned_port_no
        ? await verifyPortRunningLogin(
            Number(attempt.vps_id),
            Number(attempt.assigned_port_no),
            mt5Login
          ).catch(() => ({ ok: false }))
        : { ok: false };
    const loginMatch = snapshotLoginMatches(mt5Login, observed, portProof.ok);
    const observedFromHealth = loginMatch && portProof.ok ? mt5Login : observed;
    const hasMetrics = balance !== null || equity !== null;
    const purpose = clean(payload?.purpose).toLowerCase();
    const equityFetch = purpose.includes('login_equity');
    const mismatchLogin = clean(snap.observedLogin || result?.observedLogin || observed);

    if (apiMismatch && mismatchLogin && mt5Login && !isExactLoginMatch(mt5Login, mismatchLogin)) {
      if (await hasInflightMismatchLoginRetry(attempt)) {
        return { ok: true, pending: true, attemptId: attempt.attempt_id, retry: true };
      }
      return handleTitleMismatchRetry(attempt, mismatchLogin, mt5Login, attempt.window_title);
    }

    await markAttemptProgress(attempt, {
      status: 'checking',
      message: hasMetrics
        ? `ยืนยัน Equity แล้ว (${observedFromHealth || observed || mt5Login})`
        : loginMatch
          ? `Snapshot ยืนยันเลขบัญชี ${observedFromHealth || observed || mt5Login} — กำลังดึง Equity...`
          : msg || 'ได้รับ snapshot จาก MT5 แล้ว',
      observedLogin: observedFromHealth || observed || undefined,
      balance,
      equity,
      snapshotVerified: loginMatch ? true : undefined,
      portHealthVerified: portProof.ok ? true : undefined,
      portHealthLogin: portProof.ok ? mt5Login : undefined,
      evidenceSource: hasMetrics ? 'snapshot' : 'snapshot_pending_metrics',
      rawLastEvent: { ok, result, commandId, commandType: ctype }
    }).catch(() => {});

    if (loginMatch && hasMetrics) {
      const fin = await finalizeAttemptConnected(attempt, {
        message: 'ยืนยันการเชื่อมต่อจาก MT5 API แล้ว',
        evidenceSource: equityFetch ? 'login_equity_fetch' : 'snapshot',
        observedLogin: observedFromHealth || observed || mt5Login,
        balance,
        equity
      });
      if (fin?.status === 'connected' || normalizeAttemptStatus(fin?.status) === 'connected') {
        return { ok: true, status: 'connected', attemptId: attempt.attempt_id };
      }
    }

    if (loginMatch && !hasMetrics) {
      await queueLoginEquityFetch(attempt).catch(() => false);
      const fetchCount = await countLoginEquityFetchCommands(attempt).catch(() => 0);
      if (fetchCount >= LOGIN_EQUITY_FETCH_MAX) {
        if (portProof.reason === 'LOGIN_MISMATCH' && portProof.reported) {
          return handleTitleMismatchRetry(attempt, portProof.reported, mt5Login, attempt.window_title);
        }
        return finalizeAttemptFailed(
          attempt,
          'ดึง Equity จาก MT5 ไม่สำเร็จหลังหลายครั้ง — ตรวจสอบว่า MT5 เปิดอยู่และ login ถูกบัญชี แล้วลองใหม่',
          { evidenceSource: 'equity_fetch_exhausted' }
        );
      }
    } else if (observed && !loginMatch) {
      if (portProof.reason === 'LOGIN_MISMATCH' && portProof.reported) {
        return handleTitleMismatchRetry(attempt, portProof.reported, mt5Login, attempt.window_title);
      }
      await markAttemptProgress(attempt, {
        status: 'checking',
        message: `ตรวจพบเลขบัญชี ${observed} ไม่ตรงกับ ${mt5Login} — กำลังลองใหม่...`,
        lastError: `เลขบัญชีบน MT5 (${observed}) ไม่ตรงกับที่กรอก (${mt5Login})`
      }).catch(() => {});
    }

    await maybeFinalizeAttempt(attempt.attempt_id).catch(() => {});
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
      AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'cancelled', 'expired')
    ORDER BY at.created_at DESC, at.id DESC
  `,
    [Number(node.id), portNo]
  ).catch(() => ({ rows: [] }));

  for (const attempt of r.rows || []) {
    const expected = clean(attempt.mt5_login);
    const conflict = running && reportedLogin && expected && !isExactLoginMatch(expected, reportedLogin);
    const exact = running && isExactLoginMatch(expected, reportedLogin);
    const runningOk = running && expected && !conflict;
    await markAttemptProgress(attempt, {
      status: running ? 'checking' : undefined,
      processId: pid || undefined,
      portHealthVerified: exact || runningOk ? true : undefined,
      portHealthLogin: reportedLogin || (runningOk ? expected : undefined),
      evidenceSource: exact ? 'port_health' : runningOk ? 'port_running' : undefined,
      rawLastEvent: { portHealth: portData }
    }).catch(() => {});

    if (folderPath && !attempt.folder_path) {
      await updateAttemptRow(attempt.attempt_id, { folderPath });
    }

    if (exact || runningOk) {
      const metrics = resolveAttemptMetrics(attempt);
      if (!metrics.ready) {
        await markAttemptProgress(attempt, {
          status: 'checking',
          snapshotVerified: true,
          observedLogin: expected,
          evidenceSource: 'port_health'
        }).catch(() => {});
        await ensureAttemptVerificationCommands(attempt).catch(() => {});
      }
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

async function repairUserMt5AccountStatuses(userId) {
  const uid = Number(userId || 0);
  if (!uid) return 0;
  const r = await query(
    `
    SELECT
      a.id,
      a.status,
      a.last_balance,
      a.last_equity,
      a.metrics_ready AS account_metrics_ready,
      a.last_login_message,
      at.attempt_id,
      at.status AS attempt_status,
      at.terminal AS attempt_terminal,
      at.balance AS attempt_balance,
      at.equity AS attempt_equity,
      at.last_message AS attempt_message
    FROM vps_system.mt5_accounts a
    JOIN vps_system.mt5_connect_attempts at ON at.attempt_id = a.current_attempt_id
    WHERE a.user_id = $1
      AND LOWER(COALESCE(a.status, '')) IN ('checking', 'connecting', 'starting')
      AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'cancelled', 'expired')
      AND at.terminal = TRUE
      AND LOWER(COALESCE(at.status, '')) = 'connected'
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  let repaired = 0;
  for (const row of r.rows || []) {
    await repairIncompleteConnectAttempt(row).catch(() => {});
    repaired += 1;
  }
  return repaired;
}

async function getConnectStatusForUser(userId, accountId = 0) {
  await ensureMt5ConnectAttemptTables();
  await expireStaleConnectAttempts().catch(() => {});

  if (accountId) {
    const removed = await query(
      `
      SELECT id, LOWER(COALESCE(status, '')) AS status
      FROM vps_system.mt5_accounts
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
      [Number(accountId), Number(userId)]
    ).catch(() => ({ rows: [] }));
    const removedStatus = String(removed.rows?.[0]?.status || '').trim();
    if (['deleted', 'cancelled', 'expired'].includes(removedStatus)) {
      return {
        ok: true,
        connected: false,
        status: removedStatus,
        message: removedStatus === 'deleted' ? 'ลบ PORT แล้ว' : 'ยกเลิก PORT แล้ว',
        account: { id: Number(accountId), status: removedStatus }
      };
    }
  }

  await repairUserMt5AccountStatuses(userId).catch(() => {});
  const params = [Number(userId)];
  let where = `a.user_id=$1 AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'cancelled', 'expired')`;
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
      at.purpose_type,
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

  const rowAccountStatus = String(row.status || '').trim().toLowerCase();
  if (['deleted', 'cancelled', 'expired'].includes(rowAccountStatus)) {
    return {
      ok: true,
      connected: false,
      status: rowAccountStatus,
      message: rowAccountStatus === 'deleted' ? 'ลบ PORT แล้ว' : 'ยกเลิก PORT แล้ว',
      account: { id: Number(row.id), status: rowAccountStatus }
    };
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
          at.purpose_type,
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
      await repairIncompleteConnectAttempt(row).catch(() => {});
      const repaired = await query(
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
          at.purpose_type,
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
      if (repaired.rows?.[0]) {
        Object.assign(row, repaired.rows[0]);
      }
    }
  }

  const balance = moneyMetric(row.attempt_balance) ?? moneyMetric(row.last_balance);
  const equity = moneyMetric(row.attempt_equity) ?? moneyMetric(row.last_equity);
  const hasNumericMetrics = balance !== null || equity !== null;
  const metricsReady = hasNumericMetrics;

  let status = row.attempt_id ? attemptDisplayStatus(row.attempt_status || row.status) : normalizeAttemptStatus(row.status);
  const accountStatus = normalizeAttemptStatus(row.status);
  if (['connected', 'ready'].includes(accountStatus) && metricsReady) {
    status = 'connected';
  } else if (['connected', 'ready'].includes(accountStatus) && !metricsReady) {
    status = 'checking';
  }
  const terminalFailedProof = Boolean(
    row.attempt_terminal && normalizeAttemptStatus(row.attempt_status || '') === 'failed'
  );
  if (
    row.attempt_terminal
    && normalizeAttemptStatus(row.attempt_status || '') === 'connected'
    && metricsReady
  ) {
    status = 'connected';
  }
  if (terminalFailedProof) status = 'failed';
  const connected = status === 'connected' && metricsReady;
  const failed = status === 'failed';
  const pending =
    ['starting', 'checking'].includes(status)
    || (normalizeAttemptStatus(row.attempt_status || '') === 'connected' && !metricsReady);
  const balanceOut = balance;
  const equityOut = equity;
  const purposeType = clean(row.purpose_type || 'login_only').toLowerCase();
  const message = connected
    ? (purposeType === 'bot_run'
      ? clean(row.attempt_message || row.last_login_message) || 'Phase 2: Login สำเร็จ — กำลังรัน BOT'
      : clean(row.attempt_message || row.last_login_message) || 'Phase 1: Equity OK — MT5 ปิดแล้ว พร้อม Run BOT')
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
    loginVerified: Boolean(row.login_verified || row.account_login_verified) && metricsReady,
    metricsReady,
    message,
    windowTitle: title,
    previewUrl: previewPath ? `${previewPath}?t=${Date.now()}` : '',
    elapsedSec,
    remainingSec,
    timeoutSec,
    step,
    purposeType,
    phase: purposeType === 'bot_run' ? 'bot_run' : 'login_only',
    observedLogin: clean(row.observed_login),
    balance: balanceOut,
    equity: equityOut
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
  repairUserMt5AccountStatuses,
  ingestCommandResultEvent,
  ingestConnectResultEvent,
  ingestPortHealthEvent,
  maybeFinalizeAttempt,
  queuePostConnectExitCommands,
  resolveAttempt
};
