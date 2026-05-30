'use strict';

const { adminPortToSystemPortNo } = require('./adminVpsPortPicker');

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * เลข port บน VPS ที่ตรงกับ package slot — ไม่ใช้ assigned_port_no ค้างจาก PORT เก่า
 * (เช่น ลบ PORT 3 แล้วไม่ไป stop/reconcile ที่ 101 ของ PORT อื่น)
 */
function systemPortNosForPackageSlot(portSlot, assignedPortNo = 0, windowsPortNo = 0) {
  const slot = num(portSlot);
  const expected = slot > 0 ? adminPortToSystemPortNo(slot) : 0;
  const nos = new Set();
  if (expected > 0) nos.add(expected);
  const assigned = num(assignedPortNo);
  const windows = num(windowsPortNo);
  if (assigned > 0 && (assigned === expected || (slot > 0 && assigned === slot))) nos.add(assigned);
  if (windows > 0 && (windows === expected || (slot > 0 && windows === slot))) nos.add(windows);
  return [...nos];
}

function primarySystemPortForPackageSlot(portSlot, assignedPortNo = 0, windowsPortNo = 0) {
  const nos = systemPortNosForPackageSlot(portSlot, assignedPortNo, windowsPortNo);
  return nos[0] || 0;
}

/** Payload มาตรฐานเมื่อปล่อย FolderPort — kill MT5 + ล้าง session เก่า */
function buildStopMt5ReleasePayload({
  portNo,
  portSlot = null,
  assignedPortNo = null,
  windowsPortNo = null,
  folderPath = null,
  accountId = null,
  mt5Login = null,
  reason = 'release_folder_port'
} = {}) {
  const port = Number(portNo || 0);
  const folder = folderPath ? String(folderPath).trim() : null;
  return {
    port,
    portNumber: port,
    port_no: port,
    portSlot: portSlot ? Number(portSlot) : undefined,
    assignedPortNo: assignedPortNo ? Number(assignedPortNo) : undefined,
    windowsPortNo: windowsPortNo ? Number(windowsPortNo) : undefined,
    folder_path: folder,
    folderPath: folder,
    vpsFolderPath: folder,
    forceKill: true,
    closeMt5: true,
    clearSession: true,
    mt5Login: mt5Login ? String(mt5Login).trim() : null,
    accountId: accountId ? Number(accountId) : undefined,
    reason
  };
}

module.exports = {
  buildStopMt5ReleasePayload,
  systemPortNosForPackageSlot,
  primarySystemPortForPackageSlot
};
