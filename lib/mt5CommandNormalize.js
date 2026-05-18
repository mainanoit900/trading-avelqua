'use strict';

/** แปลง command_type เก่าที่ Agent บน VPS ไม่รู้จัก */
const COMMAND_TYPE_ALIASES = {
  run_bot: 'run_mt5_bot',
  restart_ea: 'restart_mt5_bot',
  /** Agent เก่ารู้จัก dashboard (มี account_snapshot ในฟังก์ชันแต่ไม่มี handler แยก) */
  account_snapshot: 'dashboard',
  read_account_metrics: 'dashboard'
};

function normalizeAgentCommandType(ctype) {
  const t = String(ctype || '').toLowerCase().trim();
  return COMMAND_TYPE_ALIASES[t] || t;
}

function normalizeRunBotPayloadAction(payload, commandType) {
  const pl =
    payload && typeof payload === 'object' ? { ...payload } : {};
  const ct = normalizeAgentCommandType(commandType);
  if (ct === 'run_mt5_bot' || ct === 'restart_mt5_bot') {
    pl.action = ct;
    pl.commandType = ct;
  }
  return pl;
}

module.exports = {
  COMMAND_TYPE_ALIASES,
  normalizeAgentCommandType,
  normalizeRunBotPayloadAction
};
