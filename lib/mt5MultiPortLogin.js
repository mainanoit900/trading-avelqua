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

/** รอ Journal นานขึ้นเมื่อมี MT5 หลายตัวบน VPS (ลด timeout ปลอมบน PORT 3+) */
function computeJournalTimeoutSec(opts = {}) {
  const base = num(process.env.MT5_JOURNAL_TIMEOUT_SEC, 150);
  const totalPorts = Math.max(1, num(opts.totalPorts, 1));
  const activeLogins = Math.max(0, num(opts.activeLoginCount, 0));
  const portSlot = num(opts.portSlot, 0);
  const slotIndex = portSlot > 0 ? portSlot - 1 : 0;
  const extra = Math.min(90, activeLogins * 15 + slotIndex * 10);
  const scaled = base + extra;
  const cap = num(process.env.MT5_JOURNAL_TIMEOUT_MAX_SEC, 240);
  return Math.max(120, Math.min(scaled, cap));
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

/** ดีเลย์คิวบน Agent ก่อนเปิด MT5 (ช่องที่ 2+ รอให้ช่องก่อนหน้าเริ่มก่อน) */
function loginQueueDelaySec(portSlot, staggerSec = 28) {
  const slot = num(portSlot, 0);
  if (slot <= 1) return 0;
  return Math.min(180, (slot - 1) * num(staggerSec, 28));
}

module.exports = {
  userPortLockKey,
  computeJournalTimeoutSec,
  countActiveLoginsOnVps,
  loginQueueDelaySec
};
