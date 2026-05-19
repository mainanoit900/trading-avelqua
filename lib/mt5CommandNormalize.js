'use strict';

/** แปลง command_type เก่าที่ Agent บน VPS ไม่รู้จัก */
const COMMAND_TYPE_ALIASES = {
  run_bot: 'run_mt5_bot',
  restart_ea: 'restart_mt5_bot'
};

/** แปลงเมื่อส่งให้ Agent poll — เก็บ account_snapshot ใน DB ได้ */
function normalizeAgentCommandForPoll(ctype, agentVersion) {
  const t = normalizeAgentCommandType(ctype);
  const ver = String(agentVersion || '').trim();
  if (['account_snapshot', 'sync_mt5_account', 'read_account_metrics'].includes(t)) {
    if (!ver.includes('equity-dashboard') && !ver.includes('equity-push')) {
      return 'dashboard';
    }
  }
  return t;
}

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
  normalizeAgentCommandForPoll,
  normalizeRunBotPayloadAction
};
