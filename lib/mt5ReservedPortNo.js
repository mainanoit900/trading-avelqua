'use strict';

const { parsePortNumber } = require('./adminVpsBridge');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** แมปเลข PORT จาก admin → vps_system.vps_ports.port_no (เช่น 1 → 101) */
function adminPortToSystemPortNo(portNo) {
  const n = num(portNo);
  if (n <= 0) return 0;
  if (n >= 100) return n;
  return 100 + n;
}

const FOLDER_POOL_MIN = 101;
const FOLDER_POOL_MAX = 120;

/** FolderPort บน VPS ต้องเป็นเลขระบบ 101+ — ห้ามใช้ package port_slot (1–4) แทน */
function normalizeSystemFolderPortNo(portNo) {
  const n = num(portNo);
  if (n <= 0) return 0;
  if (n >= 100) return n;
  return adminPortToSystemPortNo(n);
}

/** FolderPort ใน pool ร่วม VPS (101–120) — ไม่บังคับให้ตรง 100+package port_slot */
function isValidPoolFolderPort(portNo) {
  const n = normalizeSystemFolderPortNo(portNo);
  return n >= FOLDER_POOL_MIN && n <= FOLDER_POOL_MAX;
}

function systemPortNoFromReservedPort(reservedPort) {
  if (!reservedPort || typeof reservedPort !== 'object') return 0;

  const direct = num(reservedPort.port_no ?? reservedPort.port_number ?? reservedPort.portNo);
  if (direct >= 100) return direct;
  if (direct > 0 && direct <= 50) return adminPortToSystemPortNo(direct);

  const folder = String(reservedPort.folder_path || reservedPort.folderPath || '').trim();
  const m = folder.match(/PORT[-_ ]*0*(\d+)/i);
  if (m) return adminPortToSystemPortNo(num(m[1]));

  const parsed = num(parsePortNumber(reservedPort));
  if (parsed >= 100) return parsed;
  if (parsed > 0) return adminPortToSystemPortNo(parsed);

  return 0;
}

module.exports = {
  FOLDER_POOL_MIN,
  FOLDER_POOL_MAX,
  adminPortToSystemPortNo,
  normalizeSystemFolderPortNo,
  isValidPoolFolderPort,
  systemPortNoFromReservedPort
};
