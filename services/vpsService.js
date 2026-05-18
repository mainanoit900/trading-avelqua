
function ensureVpsCapacity(db) {
  db.vpsNodes = Array.isArray(db.vpsNodes) ? db.vpsNodes : [];
  db.mt5Assignments = Array.isArray(db.mt5Assignments) ? db.mt5Assignments : [];
}

function allocateVpsForUser(db, user) {
  ensureVpsCapacity(db);
  if (!user) return null;
  const assigned = db.mt5Assignments.find(x => String(x.userId) === String(user.id) && x.status === 'active');
  if (assigned) return assigned;
  const node = db.vpsNodes.find(v => v.enabled !== false && Number(v.usedPorts || 0) < Number(v.maxPorts || 0));
  if (!node) return null;
  const assignment = {
    id: Date.now(),
    userId: user.id,
    vpsId: node.id,
    vpsName: node.name,
    lotMax: user.lotMax || 0,
    portMax: user.portMax || 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };
  node.usedPorts = Number(node.usedPorts || 0) + Math.max(1, Number(user.portMax || 1));
  db.mt5Assignments.push(assignment);
  return assignment;
}

module.exports = { ensureVpsCapacity, allocateVpsForUser };
