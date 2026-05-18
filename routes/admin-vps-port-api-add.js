/*
วางไฟล์นี้ไว้ใน /root/trading-avelqua/routes/admin-vps-port-api-add.js
แล้วเพิ่มใน routes/admin.js หลังประกาศ router/db/requireAdmin:

require('./admin-vps-port-api-add')(router, db, requireAdmin);

ถ้าไฟล์ routes/admin.js ใช้ middleware ชื่ออื่น ให้ส่ง middleware admin ของเดิมเข้ามาแทน requireAdmin
*/

module.exports = function mountVpsPortApi(router, db, requireAdmin) {
  const adminOnly = requireAdmin || ((req, res, next) => next());

  async function q(sql, params) {
    if (db.query) return db.query(sql, params);
    if (db.pool && db.pool.query) return db.pool.query(sql, params);
    throw new Error('DB query function not found');
  }

  function padPort(v) {
    const s = String(v || '').toUpperCase().replace(/^PORT/, '').replace(/[^0-9]/g, '');
    const n = Math.max(1, Math.min(20, parseInt(s || '1', 10)));
    return 'PORT' + String(n).padStart(2, '0');
  }

  function safePortName(v) {
    const p = padPort(v);
    return /^PORT(0[1-9]|1[0-9]|20)$/.test(p) ? p : 'PORT01';
  }

  function portRoot(portName) {
    return `C:\\MT5_PORTS\\${safePortName(portName)}`;
  }

  function expertsPath(portName) {
    return `${portRoot(portName)}\\MQL5\\Experts`;
  }

  async function ensureAdminPortTables() {
    await q(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS port_id BIGINT`).catch(()=>{});
    await q(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS lock_key TEXT`).catch(()=>{});
    await q(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`).catch(()=>{});
    await q(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`).catch(()=>{});
    await q(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS result JSONB DEFAULT '{}'::jsonb`).catch(()=>{});
    await q(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS error TEXT DEFAULT ''`).catch(()=>{});
    await q(`ALTER TABLE vps_ports ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`).catch(()=>{});
    await q(`ALTER TABLE vps_ports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'free'`).catch(()=>{});
    await q(`ALTER TABLE vps_ports ADD COLUMN IF NOT EXISTS display_name TEXT`).catch(()=>{});
    await q(`ALTER TABLE vps_ports ADD COLUMN IF NOT EXISTS folder_path TEXT`).catch(()=>{});
  }

  function portNumberFromName(v) {
    return Number(String(safePortName(v)).replace('PORT','')) || 1;
  }


  async function getNode(nodeId) {
    const r = await q('SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1', [nodeId]);
    return r.rows[0];
  }

  async function getPort(portId) {
    const r = await q(`SELECT p.*, n.node_name, n.ip_address, n.id AS node_id
                      FROM vps_ports p JOIN vps_nodes n ON n.id=p.node_id
                      WHERE p.id=$1 LIMIT 1`, [portId]);
    return r.rows[0];
  }

  async function queueCommand({ nodeId, portId = null, commandType, payload = {}, lockKey }) {
    await ensureAdminPortTables();
    const busy = await q(
      `SELECT id,status FROM vps_agent_commands
       WHERE lock_key=$1 AND status IN ('pending','running')
       ORDER BY id DESC LIMIT 1`,
      [lockKey]
    );
    if (busy.rows.length) {
      const err = new Error(`PORT นี้มีคำสั่งค้างอยู่ (#${busy.rows[0].id}) กรุณารอให้จบก่อน`);
      err.code = 'PORT_BUSY';
      throw err;
    }
    const ins = await q(
      `INSERT INTO vps_agent_commands(node_id, port_id, command_type, payload, status, lock_key)
       VALUES($1,$2,$3,$4::jsonb,'pending',$5) RETURNING *`,
      [nodeId, portId, commandType, JSON.stringify(payload), lockKey]
    );
    return ins.rows[0];
  }



  // ===== Production API: list/create/toggle/delete PORT =====
  router.get('/vps/:nodeId/ports/api/list', adminOnly, async (req, res) => {
    try {
      await ensureAdminPortTables();
      const nodeId = Number(req.params.nodeId);
      const portsRes = await q(`
        SELECT * FROM vps_ports
        WHERE node_id=$1
        ORDER BY COALESCE(port_number, 999), id ASC
      `, [nodeId]);

      const latest = await q(`
        SELECT result, COALESCE(completed_at, finished_at, created_at) AS at
        FROM vps_agent_commands
        WHERE node_id=$1 AND command_type IN ('dashboard','watchdog') AND status='done'
        ORDER BY COALESCE(completed_at, finished_at, created_at) DESC, id DESC
        LIMIT 1
      `, [nodeId]).catch(()=>({rows:[]}));

      const livePorts = latest.rows[0]?.result?.ports || [];
      const liveMap = new Map(livePorts.map(p => [safePortName(p.port || p.portName || p.name), p]));

      const ports = portsRes.rows.map(p => {
        const portName = safePortName(p.port_name || p.display_name || p.port_number);
        const live = liveMap.get(portName) || {};
        const running = !!(live.running || live.busy || live.pid);
        const adminActive = p.is_active !== false && !['off','disabled','inactive','deleted'].includes(String(p.status || '').toLowerCase());
        return {
          ...p,
          port_name: portName,
          port_number: p.port_number || portNumberFromName(portName),
          display_name: p.display_name || portName,
          base_path: p.folder_path || portRoot(portName),
          experts_path: expertsPath(portName),
          is_active: adminActive,
          live_running: running,
          live_pid: live.pid || null,
          live_lot: Number(live.lot || live.lot_used || 0),
          ui_status: !adminActive ? 'ปิด' : (running ? 'เต็ม' : 'ว่าง')
        };
      });

      const activePorts = ports.filter(p => p.is_active && p.live_running).length;
      const usedLot = ports.reduce((s,p)=>s + Number(p.live_lot || 0), 0);

      await q(`UPDATE vps_nodes SET active_ports=$2, active_lot=$3, used_ports=$2, used_lot=$3, updated_at=NOW() WHERE id=$1`, [nodeId, activePorts, usedLot]).catch(()=>{});
      await q(`UPDATE vps_system.vps_nodes SET used_ports=$2, used_lot=$3, updated_at=NOW() WHERE id=$1`, [nodeId, activePorts, usedLot]).catch(()=>{});

      res.json({ ok:true, ports, stats:{ total_ports: ports.length, active_ports: activePorts, used_lot: usedLot, dashboard_at: latest.rows[0]?.at || null } });
    } catch(e) { res.status(500).json({ok:false, error:e.message}); }
  });

  router.post('/vps/:nodeId/ports/api/create', adminOnly, async (req, res) => {
    try {
      await ensureAdminPortTables();
      const nodeId = Number(req.params.nodeId);
      const exists = await q(`SELECT COALESCE(MAX(port_number),0)::int AS max_no, COUNT(*)::int AS c FROM vps_ports WHERE node_id=$1`, [nodeId]);
      const nextNo = Math.min(20, Number(exists.rows[0]?.max_no || 0) + 1);
      if (!nextNo || nextNo > 20) throw new Error('PORT เต็มแล้ว สูงสุด 20 PORT');
      const portName = safePortName(nextNo);
      const ins = await q(`
        INSERT INTO vps_ports (node_id, port_name, display_name, port_number, folder_path, status, is_active, created_at, updated_at)
        VALUES ($1,$2,$2,$3,$4,'free',TRUE,NOW(),NOW())
        RETURNING *
      `, [nodeId, portName, nextNo, portRoot(portName)]);
      res.json({ok:true, port:ins.rows[0]});
    } catch(e) { res.status(500).json({ok:false, error:e.message}); }
  });

  router.post('/vps/ports/api/toggle/:portId', adminOnly, async (req, res) => {
    try {
      await ensureAdminPortTables();
      const port = await getPort(req.params.portId);
      if (!port) throw new Error('Port not found');
      const portName = safePortName(port.port_name || port.display_name || port.port_number);
      const currentActive = port.is_active !== false && !['off','disabled','inactive','deleted'].includes(String(port.status || '').toLowerCase());
      const nextActive = !currentActive;
      const nextStatus = nextActive ? 'free' : 'off';
      await q(`UPDATE vps_ports SET is_active=$2, status=$3, updated_at=NOW() WHERE id=$1`, [port.id, nextActive, nextStatus]).catch(async()=>{
        await q(`UPDATE vps_ports SET status=$2 WHERE id=$1`, [port.id, nextStatus]);
      });
      if (!nextActive) {
        await queueCommand({
          nodeId: port.node_id,
          portId: port.id,
          commandType: 'stop_mt5',
          payload: { port: portName, portName, portRoot: portRoot(portName), folder_path: portRoot(portName), reason: 'admin_disable_port' },
          lockKey: `node:${port.node_id}:${portName}`
        });
      }
      res.json({ok:true, is_active:nextActive, status:nextStatus});
    } catch(e) { res.status(e.code === 'PORT_BUSY' ? 409 : 500).json({ok:false, error:e.message}); }
  });

  router.post('/vps/ports/api/delete/:portId', adminOnly, async (req, res) => {
    try {
      await ensureAdminPortTables();
      const port = await getPort(req.params.portId);
      if (!port) throw new Error('Port not found');
      const portName = safePortName(port.port_name || port.display_name || port.port_number);
      await queueCommand({
        nodeId: port.node_id,
        portId: port.id,
        commandType: 'stop_mt5',
        payload: { port: portName, portName, portRoot: portRoot(portName), folder_path: portRoot(portName), reason: 'admin_delete_port' },
        lockKey: `node:${port.node_id}:${portName}`
      }).catch(()=>{});
      await q(`UPDATE vps_ports SET is_active=FALSE, status='deleted', updated_at=NOW() WHERE id=$1`, [port.id]).catch(async()=>{
        await q(`UPDATE vps_ports SET status='deleted' WHERE id=$1`, [port.id]);
      });
      res.json({ok:true});
    } catch(e) { res.status(500).json({ok:false, error:e.message}); }
  });

  // หน้า Dashboard Port Pro
  router.get('/vps/:nodeId/ports', adminOnly, async (req, res, next) => {
    try {
      const node = await getNode(req.params.nodeId);
      if (!node) return res.status(404).send('VPS not found');
      res.render('admin/vps-ports-pro', { pageTitle: 'VPS Port Dashboard Pro', node, vps: node, success: req.query.success, error: req.query.error });
    } catch (e) { next(e); }
  });

  // API live dashboard จาก cache/result ล่าสุด
  router.get('/vps/:nodeId/ports/api/dashboard', adminOnly, async (req, res) => {
    try {
      const nodeId = Number(req.params.nodeId);
      const latest = await q(
        `SELECT result, completed_at FROM vps_agent_commands
         WHERE node_id=$1 AND command_type IN ('dashboard','watchdog') AND status='done'
         ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1`, [nodeId]
      );
      let ports = [];
      if (latest.rows[0]?.result?.ports) ports = latest.rows[0].result.ports;
      if (!ports.length) {
        ports = Array.from({ length: 20 }, (_, i) => {
          const name = 'PORT' + String(i + 1).padStart(2, '0');
          return { port: name, status: 'unknown', pid: null, mq5_count: 0, busy: false, path: portRoot(name) };
        });
      }
      const cmds = await q(`SELECT id,command_type,payload,status,lock_key,created_at,error FROM vps_agent_commands WHERE node_id=$1 ORDER BY id DESC LIMIT 20`, [nodeId]);
      res.json({ ok: true, ports, commands: cmds.rows, dashboard_at: latest.rows[0]?.completed_at || null });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  router.get('/vps/:nodeId/ports/api/commands', adminOnly, async (req, res) => {
    try {
      const r = await q(`SELECT id,command_type,payload,status,lock_key,created_at,picked_at,completed_at,error,result FROM vps_agent_commands WHERE node_id=$1 ORDER BY id DESC LIMIT 50`, [req.params.nodeId]);
      res.json({ ok:true, commands:r.rows });
    } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  router.post('/vps/:nodeId/ports/api/action', adminOnly, async (req, res) => {
    try {
      const nodeId = Number(req.params.nodeId);
      const action = String(req.body.action || '').trim();
      const port = safePortName(req.body.port || req.body.port_name || 'PORT01');
      const payload = { ...req.body, port, portName: port, portRoot: portRoot(port), expertsPath: expertsPath(port) };
      const lockKey = ['dashboard','watchdog'].includes(action) ? `node:${nodeId}` : `node:${nodeId}:${port}`;
      const cmd = await queueCommand({ nodeId, commandType: action, payload, lockKey });
      res.json({ ok:true, command:cmd });
    } catch (e) { res.status(e.code === 'PORT_BUSY' ? 409 : 500).json({ ok:false, error:e.message }); }
  });

  // หน้า File Manager ของ PORT
  router.get('/vps/ports/:portId/files', adminOnly, async (req, res, next) => {
    try {
      const port = await getPort(req.params.portId);
      if (!port) return res.status(404).send('Port not found');
      const portName = safePortName(port.port_name || port.port_number);
      const folder = req.query.path || expertsPath(portName);
      const files = await q(`SELECT * FROM vps_port_files_cache WHERE node_id=$1 AND folder_path=$2 ORDER BY is_dir DESC, file_name ASC LIMIT 500`, [port.node_id, folder]);
      const logs = await q(`SELECT * FROM vps_agent_commands WHERE node_id=$1 AND (port_id=$2 OR payload->>'port'=$3) ORDER BY id DESC LIMIT 20`, [port.node_id, port.id, portName]);
      res.render('admin/vps-port-files', { pageTitle:'จัดการไฟล์ MT5 Port', port:{...port, port_name:portName}, folder, files:files.rows, logs:logs.rows, success:req.query.success, error:req.query.error });
    } catch (e) { next(e); }
  });

  router.post('/vps/ports/:portId/command', adminOnly, async (req, res) => {
    try {
      const port = await getPort(req.params.portId);
      if (!port) return res.status(404).send('Port not found');
      const portName = safePortName(port.port_name || port.port_number);
      const commandType = String(req.body.command || req.body.action || '').trim();
      const folderPath = req.body.folder_path || expertsPath(portName);
      const payload = { ...req.body, port: portName, portName, portRoot: portRoot(portName), expertsPath: expertsPath(portName), folder_path: folderPath };
      const cmd = await queueCommand({ nodeId: port.node_id, portId: port.id, commandType, payload, lockKey:`node:${port.node_id}:${portName}` });
      res.redirect(`/admin/vps/ports/${port.id}/files?path=${encodeURIComponent(folderPath)}&success=${encodeURIComponent('ส่งคำสั่งแล้ว #' + cmd.id)}`);
    } catch (e) {
      res.redirect(`/admin/vps/ports/${req.params.portId}/files?error=${encodeURIComponent(e.message)}`);
    }
  });
};
