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

/** รอ Journal — เพิ่มเล็กน้อยเมื่อมี login อื่นค้างบน VPS เดียวกัน (ไม่บวกตามเลข PORT ตายตัว) */
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

/** MT5 ที่รันอยู่บน VPS (จาก health) — ใช้ปรับ journal timeout ตอน login หลาย PORT */
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

/** มีคำสั่ง login ค้าง/กำลังรันบน VPS (ไม่รวมบัญชีปัจจุบัน) */
async function hasOtherLoginWorkOnVps(vpsId, accountId = 0) {
  const nid = num(vpsId);
  if (!nid) return false;
  const aid = num(accountId);
  const r = await query(
    `
    SELECT 1
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN ('login_mt5', 'connect_mt5')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND ($2::bigint = 0 OR COALESCE((payload->>'accountId')::bigint, 0) <> $2)
    LIMIT 1
  `,
    [nid, aid]
  ).catch(() => ({ rows: [] }));
  return !!(r.rows || []).length;
}

/**
 * ดีเลย์ก่อนเปิด MT5 — เฉพาะเมื่อมี login อื่นยังไม่จบ (Agent ประมวลผลทีละคำสั่งอยู่แล้ว)
 * ไม่หน่วงตามเลข PORT ตายตัว (เคยทำให้ PORT 2+ รอเปล่า ~28s ต่อช่อง)
 */
async function computeLoginQueueDelaySec(vpsId, accountId = 0) {
  const busy = await hasOtherLoginWorkOnVps(vpsId, accountId);
  if (!busy) return 0;
  return num(process.env.MT5_LOGIN_QUEUE_DELAY_SEC, 4);
}

/** @deprecated ใช้ computeLoginQueueDelaySec แทน */
function loginQueueDelaySec() {
  return 0;
}

function connectPollStaleLimitMs() {
  const cap = num(process.env.MT5_JOURNAL_TIMEOUT_MAX_SEC, 180);
  return (cap + 90) * 1000;
}

module.exports = {
  userPortLockKey,
  computeJournalTimeoutSec,
  countActiveLoginsOnVps,
  countRunningMt5OnVps,
  hasOtherLoginWorkOnVps,
  computeLoginQueueDelaySec,
  loginQueueDelaySec,
  connectPollStaleLimitMs
};
