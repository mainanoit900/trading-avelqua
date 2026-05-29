'use strict';

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
  buildStopMt5ReleasePayload
};
