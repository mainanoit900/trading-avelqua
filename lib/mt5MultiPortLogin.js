'use strict';

const { query } = require('../config/database');

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
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

/**
 * รายการ login ที่ค้างบน VPS — เรียงตามเลข FolderPort (assigned_port / port_number) น้อยก่อน
 */
async function listLoginQueueByFolderPort(vpsId) {
  const nid = num(vpsId);
  if (!nid) return [];

  const cmdR = await query(
    `
    SELECT
      COALESCE((payload->>'accountId')::bigint, (payload->>'account_id')::bigint, 0) AS account_id,
      COALESCE(
        NULLIF(payload->>'port', '')::int,
        NULLIF(payload->>'portNumber', '')::int,
        NULLIF(payload->>'port_no', '')::int,
        NULLIF(payload->>'portNo', '')::int,
        0
      ) AS port_no
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(TRIM(COALESCE(status, ''))) IN ('pending', 'processing', 'picked', 'running')
  `,
    [nid]
  ).catch(() => ({ rows: [] }));

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

  const byKey = new Map();
  for (const row of [...(cmdR.rows || []), ...(accR.rows || [])]) {
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

/**
 * ดีเลย์ก่อนเปิด MT5 (เฉพาะ login) — FolderPort น้อยก่อน
 * Agent ส่ง login ทีละคำสั่งอยู่แล้ว → คนถัดไปรอคงที่ ~8s (ไม่คูณลำดับ)
 * ปรับได้: MT5_LOGIN_QUEUE_STAGGER_SEC (ขั้นต่ำ 5, ค่าเริ่มต้น 8)
 */
async function computeLoginQueueDelaySec(vpsId, accountId = 0, assignedPortNo = 0) {
  const myPort = num(assignedPortNo);
  const myAcc = num(accountId);
  if (!myPort) return 0;

  const stagger = Math.max(5, num(process.env.MT5_LOGIN_QUEUE_STAGGER_SEC, 8));
  let queue = await listLoginQueueByFolderPort(vpsId);

  if (!queue.some((e) => e.portNo === myPort || (myAcc > 0 && e.accountId === myAcc))) {
    queue = [...queue, { portNo: myPort, accountId: myAcc }].sort(
      (a, b) => a.portNo - b.portNo || a.accountId - b.accountId
    );
  }

  const idx = queue.findIndex((e) => e.portNo === myPort || (myAcc > 0 && e.accountId === myAcc));
  if (idx < 0) return 0;
  return idx > 0 ? stagger : 0;
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
  computeLoginQueueDelaySec,
  loginQueueDelaySec,
  connectPollStaleLimitMs
};
