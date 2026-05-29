'use strict';

const { query } = require('../config/database');

const LOGIN_COMMAND_TYPES = ['login_mt5', 'connect_mt5'];
const RUNBOT_COMMAND_TYPES = ['run_mt5_bot', 'run_mt5'];

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function queueStaggerSec(kind = 'login') {
  const loginDefault = Math.max(3, num(process.env.MT5_LOGIN_QUEUE_STAGGER_SEC, 5));
  if (kind === 'runbot') {
    return Math.max(5, num(process.env.MT5_RUN_BOT_QUEUE_STAGGER_SEC, loginDefault));
  }
  return loginDefault;
}

/** ล็อกต่อช่องแพ็กเกจ — กดเชื่อมต่อ PORT 3 ได้ขณะ PORT 1 ยังตรวจอยู่ */
function userPortLockKey(userId, portSlot) {
  const slot = num(portSlot, 0);
  const suffix = slot > 0 ? `:slot:${slot}` : ':auto';
  return `mt5:connect:user:${userId}${suffix}`;
}

/** รอ Journal — เพิ่มเล็กน้อยเมื่อมี login อื่นค้างบน VPS เดียวกัน */
function computeJournalTimeoutSec(opts = {}) {
  const base = num(process.env.MT5_JOURNAL_TIMEOUT_SEC, 120);
  const activeLogins = Math.max(0, num(opts.activeLoginCount, 0));
  const extra = Math.min(45, Math.max(0, activeLogins - 1) * 12);
  const scaled = base + extra;
  const cap = num(process.env.MT5_JOURNAL_TIMEOUT_MAX_SEC, 180);
  return Math.max(90, Math.min(scaled, cap));
}

/** จำนวนบัญชีที่กำลัง login บน VPS เดียวกัน */
async function countActiveLoginsOnVps(vpsId) {
  const nid = num(vpsId);
  if (!nid) return 0;
  const r = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.mt5_accounts
    WHERE vps_id = $1
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('connecting', 'checking', 'starting')
  `,
    [nid]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  return num(r.rows?.[0]?.c, 0);
}

/** MT5 ที่รันอยู่บน VPS (จาก health) */
async function countRunningMt5OnVps(vpsId) {
  const nid = num(vpsId);
  if (!nid) return 0;
  const r = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.vps_port_health
    WHERE node_id = $1
      AND running = TRUE
  `,
    [nid]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  return num(r.rows?.[0]?.c, 0);
}

function portFromCommandRow(row) {
  return num(
    row?.port_no
      ?? row?.port_number
      ?? row?.portno
      ?? row?.port
  );
}

function typesSql(types) {
  return types.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ');
}

/**
 * คิวคำสั่งบน VPS เรียง FolderPort น้อยก่อน (login / runbot)
 */
async function listCommandQueueByFolderPort(vpsId, opts = {}) {
  const nid = num(vpsId);
  if (!nid) return [];

  const commandTypes = opts.commandTypes || LOGIN_COMMAND_TYPES;
  const typesIn = typesSql(commandTypes);

  const cmdR = await query(
    `
    SELECT
      COALESCE((payload->>'accountId')::bigint, (payload->>'account_id')::bigint, 0) AS account_id,
      COALESCE(
        NULLIF(payload->>'port', '')::int,
        NULLIF(payload->>'portNumber', '')::int,
        NULLIF(payload->>'port_no', '')::int,
        NULLIF(payload->>'portNo', '')::int,
        NULLIF(payload->>'folderPort', '')::int,
        NULLIF(payload->>'vpsPortNumber', '')::int,
        0
      ) AS port_no
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN (${typesIn})
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('pending', 'processing', 'picked', 'running')
  `,
    [nid]
  ).catch(() => ({ rows: [] }));

  const rows = [...(cmdR.rows || [])];

  if (opts.includeConnectingAccounts) {
    const accR = await query(
      `
      SELECT
        a.id AS account_id,
        COALESCE(
          p.port_number,
          a.windows_port_no,
          NULLIF(a.assigned_port_no, 0),
          0
        ) AS port_no
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE a.vps_id = $1
        AND LOWER(TRIM(COALESCE(a.status, ''))) IN ('connecting', 'checking', 'starting')
    `,
      [nid]
    ).catch(() => ({ rows: [] }));
    rows.push(...(accR.rows || []));
  }

  if (opts.includePendingBots) {
    const botR = await query(
      `
      SELECT
        bi.mt5_account_id AS account_id,
        COALESCE(NULLIF(bi.assigned_port_no, 0), 0) AS port_no
      FROM vps_system.bot_instances bi
      WHERE bi.vps_id = $1
        AND LOWER(TRIM(COALESCE(bi.status, ''))) IN ('pending', 'restarting')
        AND bi.created_at > NOW() - INTERVAL '30 minutes'
    `,
      [nid]
    ).catch(() => ({ rows: [] }));
    rows.push(...(botR.rows || []));
  }

  const byKey = new Map();
  for (const row of rows) {
    const portNo = portFromCommandRow(row);
    const accountId = num(row.account_id);
    if (!portNo) continue;
    const key = accountId > 0 ? `a:${accountId}` : `p:${portNo}`;
    const prev = byKey.get(key);
    if (!prev || portNo < prev.portNo) {
      byKey.set(key, { portNo, accountId });
    }
  }

  return [...byKey.values()].sort((a, b) => a.portNo - b.portNo || a.accountId - b.accountId);
}

/** @deprecated alias */
async function listLoginQueueByFolderPort(vpsId) {
  return listCommandQueueByFolderPort(vpsId, {
    commandTypes: LOGIN_COMMAND_TYPES,
    includeConnectingAccounts: true
  });
}

async function computeFolderPortQueueDelaySec(vpsId, accountId = 0, assignedPortNo = 0, kind = 'login') {
  const myPort = num(assignedPortNo);
  const myAcc = num(accountId);
  if (!myPort) return 0;

  const stagger = queueStaggerSec(kind);
  const isRunBot = kind === 'runbot';

  let queue = await listCommandQueueByFolderPort(vpsId, {
    commandTypes: isRunBot ? RUNBOT_COMMAND_TYPES : LOGIN_COMMAND_TYPES,
    includeConnectingAccounts: !isRunBot,
    includePendingBots: isRunBot
  });

  if (!queue.some((e) => e.portNo === myPort || (myAcc > 0 && e.accountId === myAcc))) {
    queue = [...queue, { portNo: myPort, accountId: myAcc }].sort(
      (a, b) => a.portNo - b.portNo || a.accountId - b.accountId
    );
  }

  const idx = queue.findIndex((e) => e.portNo === myPort || (myAcc > 0 && e.accountId === myAcc));
  if (idx < 0) return 0;
  return idx > 0 ? stagger : 0;
}

async function computeLoginQueueDelaySec(vpsId, accountId = 0, assignedPortNo = 0) {
  return computeFolderPortQueueDelaySec(vpsId, accountId, assignedPortNo, 'login');
}

async function computeRunBotQueueDelaySec(vpsId, accountId = 0, assignedPortNo = 0) {
  return computeFolderPortQueueDelaySec(vpsId, accountId, assignedPortNo, 'runbot');
}

/** @deprecated */
function loginQueueDelaySec() {
  return 0;
}

function connectPollStaleLimitMs() {
  const cap = num(process.env.MT5_JOURNAL_TIMEOUT_MAX_SEC, 180);
  const minWaitSec = num(process.env.MT5_CONNECT_POLL_TIMEOUT_SEC, 180);
  return Math.max(minWaitSec, cap + 90) * 1000;
}

module.exports = {
  userPortLockKey,
  computeJournalTimeoutSec,
  countActiveLoginsOnVps,
  countRunningMt5OnVps,
  listLoginQueueByFolderPort,
  listCommandQueueByFolderPort,
  computeLoginQueueDelaySec,
  computeRunBotQueueDelaySec,
  computeFolderPortQueueDelaySec,
  loginQueueDelaySec,
  connectPollStaleLimitMs,
  LOGIN_COMMAND_TYPES,
  RUNBOT_COMMAND_TYPES
};
