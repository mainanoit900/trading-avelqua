'use strict';

const TTL_MS = Math.max(5000, Number(process.env.USER_CACHE_TTL_MS || 20000));
const cache = new Map();

function getCachedUser(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    cache.delete(key);
    return null;
  }
  return entry.user;
}

function setCachedUser(id, user) {
  const key = String(id || '').trim();
  if (!key || !user) return;
  cache.set(key, { user, exp: Date.now() + TTL_MS });
}

function invalidateUserCache(id) {
  const key = String(id || '').trim();
  if (key) cache.delete(key);
}

module.exports = {
  getCachedUser,
  setCachedUser,
  invalidateUserCache
};
