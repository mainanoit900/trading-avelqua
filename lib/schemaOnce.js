'use strict';

/** Run DDL/migrations once per process; concurrent callers share the same promise. */
const inflight = new Map();
const done = new Set();

function runSchemaOnce(key, fn) {
  if (done.has(key)) return Promise.resolve();
  let pending = inflight.get(key);
  if (pending) return pending;

  pending = Promise.resolve()
    .then(fn)
    .then(() => {
      done.add(key);
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    })
    .finally(() => {
      if (!done.has(key)) inflight.delete(key);
    });

  inflight.set(key, pending);
  return pending;
}

module.exports = { runSchemaOnce };
