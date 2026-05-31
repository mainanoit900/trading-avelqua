'use strict';

const { adminPortToSystemPortNo, parsePortNumber } = require('./adminVpsPortPicker');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * เลข FolderPort บน VPS (101+) จากผลจองจริง — ห้าม derive จาก package port_slot อย่างเดียว
 * (slot 1 ของ user A ≠ PORT-01 ถ้า user B ใช้ folder นั้นอยู่แล้ว)
 */
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
  systemPortNoFromReservedPort
};
