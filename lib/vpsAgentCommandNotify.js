'use strict';

const Redis = require('ioredis');

let redisClient = null;

function redis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || undefined);
  }
  return redisClient;
}

function wakeListKey(vpsId) {
  return `vps:cmd:wake:${Number(vpsId) || 0}`;
}

function wakeChannel(vpsId) {
  return `vps:cmd:${Number(vpsId) || 0}`;
}

function notifyEnabled() {
  return String(process.env.VPS_CMD_NOTIFY_ENABLED || '1').trim() !== '0';
}

async function notifyVpsAgentCommandQueued({ vpsId, nodeId, commandId, commandType } = {}) {
  const nid = Number(nodeId || vpsId || 0);
  if (!nid || !notifyEnabled()) return false;

  const payload = JSON.stringify({
    commandId: commandId ? Number(commandId) : null,
    commandType: commandType ? String(commandType) : null,
    ts: Date.now()
  });

  try {
    const r = redis();
    await Promise.all([
      r.publish(wakeChannel(nid), payload),
      r.lpush(wakeListKey(nid), '1'),
      r.expire(wakeListKey(nid), 120)
    ]);
    return true;
  } catch (e) {
    console.warn('[vpsCmdNotify] publish failed:', e.message || e);
    return false;
  }
}

async function waitForVpsCommandWake(vpsId, waitMs = 5000) {
  const ms = Math.max(0, Math.min(15000, Number(waitMs) || 0));
  if (!ms || !notifyEnabled()) return false;

  try {
    const sec = Math.max(1, Math.ceil(ms / 1000));
    const res = await redis().brpop(wakeListKey(vpsId), sec);
    return Array.isArray(res) && res.length >= 2;
  } catch (e) {
    console.warn('[vpsCmdNotify] wait failed:', e.message || e);
    return false;
  }
}

module.exports = {
  notifyVpsAgentCommandQueued,
  waitForVpsCommandWake,
  wakeChannel,
  wakeListKey
};
