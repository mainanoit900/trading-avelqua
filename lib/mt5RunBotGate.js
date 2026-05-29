'use strict';

const Redis = require('ioredis');

const RUN_TYPES_SQL = `'run_mt5_bot', 'run_mt5'`;
const IN_FLIGHT_STATUS_SQL = `'pending', 'processing', 'picked', 'running', 'in_progress'`;

let redisClient = null;

function redis() {
  if (!redisClient) redisClient = new Redis();
  return redisClient;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function staggerMs() {
  return Math.max(1500, num(process.env.MT5_RUN_BOT_STAGGER_MS, 3000));
}

function pollMs() {
  return Math.max(400, num(process.env.MT5_RUN_BOT_GATE_POLL_MS, 1000));
}

function maxWaitMs() {
  return Math.max(5000, num(process.env.MT5_RUN_BOT_GATE_MAX_WAIT_MS, 120000));
}

/**
 * คำสั่งเปิดบอทที่ยังไม่จบบน VPS เดียวกัน (รวม pending ในคิว)
 */
async function countVpsRunBotInFlight(vpsId, db = null) {
  const nid = num(vpsId, 0);
  if (!nid) return 0;
  const run = db?.query ? (sql, p) => db.query(sql, p) : require('../config/database').query;
  const r = await run(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND LOWER(TRIM(COALESCE(command_type, ''))) IN (${RUN_TYPES_SQL})
      AND LOWER(TRIM(COALESCE(status, ''))) IN (${IN_FLIGHT_STATUS_SQL})
      AND created_at > NOW() - INTERVAL '15 minutes'
    `,
    [nid]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  return num(r.rows?.[0]?.c, 0);
}

/**
 * รอจน VPS ว่าง แล้วล็อก Redis ชั่วคราว — กัน User A/B ส่ง run_mt5_bot พร้อมกัน
 * @returns {{ waitedMs: number, lockKey: string }}
 */
async function acquireVpsRunBotSlot(vpsId, db = null) {
  const nid = num(vpsId, 0);
  if (!nid) return { waitedMs: 0, lockKey: null };

  const lockKey = `lock:vps:${nid}:run_mt5_bot`;
  const start = Date.now();
  const maxWait = maxWaitMs();
  const poll = pollMs();

  while (Date.now() - start < maxWait) {
    const inFlight = await countVpsRunBotInFlight(nid, db);
    if (inFlight > 0) {
      await sleep(poll);
      continue;
    }

    let got = false;
    try {
      got = !!(await redis().set(lockKey, String(Date.now()), 'NX', 'EX', 120));
    } catch (e) {
      console.warn('[mt5RunBotGate] Redis unavailable, DB-only gate:', e.message || e);
      got = true;
    }

    if (!got) {
      await sleep(poll);
      continue;
    }

    const inFlight2 = await countVpsRunBotInFlight(nid, db);
    if (inFlight2 > 0) {
      await redis().del(lockKey).catch(() => {});
      await sleep(poll);
      continue;
    }

    return { waitedMs: Date.now() - start, lockKey };
  }

  throw new Error(
    '⏳ VPS กำลังเปิดบอทอยู่ — ระบบจะส่งคำสั่งให้อัตโนมัติเมื่อว่าง (ลองใหม่ใน 1–2 นาที)'
  );
}

/** หน่วงเล็กน้อยหลังส่งคำสั่ง แล้วปล่อยล็อกให้คิวถัดไป */
async function releaseVpsRunBotSlot(lockKey) {
  if (!lockKey) return;
  await sleep(staggerMs());
  try {
    await redis().del(lockKey);
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  acquireVpsRunBotSlot,
  releaseVpsRunBotSlot,
  countVpsRunBotInFlight
};
