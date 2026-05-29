'use strict';

const { createVpsCommandGate } = require('./mt5VpsCommandGate');

const gate = createVpsCommandGate({
  commandTypes: ['login_mt5', 'connect_mt5'],
  lockKeySuffix: 'login_mt5',
  staggerEnv: 'MT5_LOGIN_STAGGER_MS',
  pollEnv: 'MT5_LOGIN_GATE_POLL_MS',
  maxWaitEnv: 'MT5_LOGIN_GATE_MAX_WAIT_MS',
  defaultStaggerMs: 4000,
  busyMessage:
    '⏳ VPS กำลัง Login MT5 อยู่ — ระบบจะส่งคำสั่งให้อัตโนมัติเมื่อว่าง (ลองใหม่ใน 1–2 นาที)'
});

module.exports = {
  acquireVpsLoginSlot: gate.acquire,
  releaseVpsLoginSlot: gate.release,
  countVpsLoginInFlight: gate.countInFlight
};
