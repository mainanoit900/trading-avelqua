'use strict';

const { createVpsCommandGate } = require('./mt5VpsCommandGate');

const gate = createVpsCommandGate({
  commandTypes: ['run_mt5_bot', 'run_mt5'],
  lockKeySuffix: 'run_mt5_bot',
  staggerEnv: 'MT5_RUN_BOT_STAGGER_MS',
  pollEnv: 'MT5_RUN_BOT_GATE_POLL_MS',
  maxWaitEnv: 'MT5_RUN_BOT_GATE_MAX_WAIT_MS',
  defaultStaggerMs: 3000,
  busyMessage:
    '⏳ VPS กำลังเปิดบอทอยู่ — ระบบจะส่งคำสั่งให้อัตโนมัติเมื่อว่าง (ลองใหม่ใน 1–2 นาที)'
});

module.exports = {
  acquireVpsRunBotSlot: gate.acquire,
  releaseVpsRunBotSlot: gate.release,
  countVpsRunBotInFlight: gate.countInFlight
};
