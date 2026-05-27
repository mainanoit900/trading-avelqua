'use strict';

/** Default sessions aligned with AK-SNIPER-VIP-VER4.0.mq5 (Thailand UTC+7 in EA). */
const DEFAULT_EA_SESSIONS = [
  { use: true, start: '03:00', stop: '06:00' },
  { use: true, start: '11:00', stop: '14:00' },
  { use: true, start: '19:00', stop: '23:55' }
];

function buildEaTimeProfile(runTimeMode) {
  const mode = String(runTimeMode || 'auto').trim().toLowerCase();
  if (mode === '24h') {
    return {
      useTimeFilter: false,
      runTimeMode: '24h',
      label: 'เปิดเทรด 24 ชม. (ปิดตัวกรองเวลาใน EA)',
      sessions: DEFAULT_EA_SESSIONS.map((s) => ({ ...s, use: false }))
    };
  }
  return {
    useTimeFilter: true,
    runTimeMode: 'auto',
    label: 'Auto — ใช้ช่วงเวลา Session 1–3 ตามบอท',
    sessions: DEFAULT_EA_SESSIONS.map((s) => ({ ...s }))
  };
}

function timeProfileLabel(profile) {
  if (!profile) return '';
  return String(profile.label || '');
}

module.exports = {
  DEFAULT_EA_SESSIONS,
  buildEaTimeProfile,
  timeProfileLabel
};
