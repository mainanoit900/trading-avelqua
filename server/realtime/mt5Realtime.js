'use strict';

function makeMt5Realtime(io) {
  function userRoom(userId) {
    return `user:${userId}`;
  }
  function portRoom(vpsId, portNo) {
    return `vps:${vpsId}:port:${portNo}`;
  }
  function emitUser(userId, event, payload) {
    if (!io || !userId) return;
    io.to(userRoom(userId)).emit(event, payload);
  }
  function emitPort(vpsId, portNo, event, payload) {
    if (!io) return;
    io.to(portRoom(vpsId, portNo)).emit(event, payload);
    io.to('admin:vps').emit(event, payload);
  }
  function attachAuth() {
    if (!io) return;
    io.on('connection', (socket) => {
      const userId = socket.handshake.auth && socket.handshake.auth.userId;
      const isAdmin = socket.handshake.auth && socket.handshake.auth.isAdmin;
      if (userId) socket.join(userRoom(userId));
      if (isAdmin) socket.join('admin:vps');
      socket.on('join-port', ({ vpsId, portNo }) => socket.join(portRoom(vpsId, portNo)));
    });
  }
  return { attachAuth, emitUser, emitPort };
}

module.exports = { makeMt5Realtime };
