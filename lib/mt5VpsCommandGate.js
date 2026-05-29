'use strict';

const Redis = require('ioredis');

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

/**
 * @param {object} opts
 * @param {string[]} opts.commandTypes - e.g. ['login_mt5','connect_mt5']
 * @param {string} opts.lockKeySuffix - e.g. 'login_mt5'
 * @param {string} opts.staggerEnv - env var for post-release delay ms
 * @param {string} opts.pollEnv
 * @param {string} opts.maxWaitEnv
 * @param {string} opts.busyMessage
 */
function createVpsCommandGate(opts) {
  const types = (opts.commandTypes || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const typesSql = types.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const lockSuffix = String(opts.lockKeySuffix || types[0] || 'cmd');
  const staggerEnv = opts.staggerEnv || 'MT5_VPS_STAGGER_MS';
  const pollEnv = opts.pollEnv || 'MT5_VPS_GATE_POLL_MS';
  const maxWaitEnv = opts.maxWaitEnv || 'MT5_VPS_GATE_MAX_WAIT_MS';
  const busyMessage =
    opts.busyMessage ||
    '⏳ VPS กำลังประมวลผลคำสั่งอยู่ — ลองใหม่ใน 1–2 นาที';

  function staggerMs() {
    const fallback = num(opts.defaultStaggerMs, 1500);
    return Math.max(500, num(process.env[staggerEnv], fallback));
  }

  function pollMs() {
    const fallback = num(opts.defaultPollMs, 1000);
    return Math.max(400, num(process.env[pollEnv], fallback));
  }

  function maxWaitMs() {
    const fallback = num(opts.defaultMaxWaitMs, 120000);
    return Math.max(5000, num(process.env[maxWaitEnv], fallback));
  }

  async function countInFlight(vpsId, db = null, portNo = null) {
    const nid = num(vpsId, 0);
    if (!nid || !types.length) return 0;
    const run = db?.query ? (sql, p) => db.query(sql, p) : require('../config/database').query;
    const pno = num(portNo, 0);
    const params = [nid];
    let portSql = '';
    if (pno > 0) {
      portSql = `
        AND COALESCE(
          NULLIF(payload->>'port', '')::int,
          NULLIF(payload->>'portNumber', '')::int,
          NULLIF(payload->>'port_no', '')::int,
          NULLIF(payload->>'portNo', '')::int,
          0
        ) = $2`;
      params.push(pno);
    }
    const r = await run(
      `
      SELECT COUNT(*)::int AS c
      FROM vps_system.vps_agent_commands
      WHERE (vps_id = $1 OR node_id = $1)
        AND LOWER(TRIM(COALESCE(command_type, ''))) IN (${typesSql})
        AND LOWER(TRIM(COALESCE(status, ''))) IN (${IN_FLIGHT_STATUS_SQL})
        AND created_at > NOW() - INTERVAL '15 minutes'
        ${portSql}
      `,
      params
    ).catch(() => ({ rows: [{ c: 0 }] }));
    return num(r.rows?.[0]?.c, 0);
  }

  async function acquire(vpsId, db = null, portNo = null) {
    const nid = num(vpsId, 0);
    if (!nid) return { waitedMs: 0, lockKey: null };

    const pno = num(portNo, 0);
    const portPart = pno > 0 ? `:port:${pno}` : '';
    const lockKey = `lock:vps:${nid}:${lockSuffix}${portPart}`;
    const start = Date.now();
    const maxWait = maxWaitMs();
    const poll = pollMs();

    while (Date.now() - start < maxWait) {
      if ((await countInFlight(nid, db, pno)) > 0) {
        await sleep(poll);
        continue;
      }

      let got = false;
      try {
        got = !!(await redis().set(lockKey, String(Date.now()), 'NX', 'EX', 120));
      } catch (e) {
        console.warn(`[mt5VpsGate:${lockSuffix}] Redis unavailable:`, e.message || e);
        got = true;
      }

      if (!got) {
        await sleep(poll);
        continue;
      }

      if ((await countInFlight(nid, db, pno)) > 0) {
        await redis().del(lockKey).catch(() => {});
        await sleep(poll);
        continue;
      }

      return { waitedMs: Date.now() - start, lockKey };
    }

    throw new Error(busyMessage);
  }

  async function release(lockKey) {
    if (!lockKey) return;
    await sleep(staggerMs());
    try {
      await redis().del(lockKey);
    } catch (_) {
      /* ignore */
    }
  }

  return { acquire, release, countInFlight };
}

module.exports = { createVpsCommandGate };
