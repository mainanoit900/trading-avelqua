const express = require('express');
const { query } = require('../config/database');
const requireAdmin = require('../middleware/admin');
const { loadAgentScript, buildDeployPayload } = require('../lib/agentDeploy');

const router = express.Router();
router.use(requireAdmin);

async function ensure() {
  await query(`
    CREATE TABLE IF NOT EXISTS vps_agent_commands (
      id BIGSERIAL PRIMARY KEY,
      vps_id BIGINT,
      node_id BIGINT,
      port_id BIGINT,
      command_type TEXT NOT NULL,
      payload JSONB DEFAULT '{}'::jsonb,
      status TEXT DEFAULT 'pending',
      result JSONB DEFAULT '{}'::jsonb,
      error TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      picked_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `).catch(()=>{});

  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS vps_id BIGINT`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS node_id BIGINT`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS port_id BIGINT`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS command_type TEXT`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}'::jsonb`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS result JSONB DEFAULT '{}'::jsonb`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS error TEXT DEFAULT ''`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`).catch(()=>{});

  await query(`ALTER TABLE vps_agent_commands ALTER COLUMN vps_id DROP NOT NULL`).catch(()=>{});
  await query(`ALTER TABLE vps_agent_commands ALTER COLUMN node_id DROP NOT NULL`).catch(()=>{});

  await query(`
    CREATE INDEX IF NOT EXISTS idx_vps_agent_commands_port_status
    ON vps_agent_commands(port_id,status,id)
  `).catch(()=>{});
}

async function getPort(id) {
  const r = await query(`
    SELECT p.*, n.node_name, n.ip_address, n.allowed_folder
    FROM vps_allocations p
    JOIN vps_nodes n ON n.id = p.node_id
    WHERE p.id=$1
  `, [id]);
  return r.rows[0];
}

function portRoot(port) {
  return port.folder_path || `C:\\MT5_PORTS\\${port.port_name || 'PORT01'}`;
}

async function queue(port, type, payload = {}) {
  await query(`
    INSERT INTO vps_agent_commands
      (vps_id, node_id, port_id, command_type, payload, status, created_at)
    VALUES ($1,$1,$2,$3,$4::jsonb,'pending',NOW())
  `, [port.node_id, port.id, type, JSON.stringify(payload)]);
}

router.get('/vps/ports/:id/files', async (req, res) => {
  await ensure();

  const port = await getPort(req.params.id);
  if (!port) return res.redirect('/admin/vps');

  const folder = req.query.path || portRoot(port);

  const logs = await query(`
    SELECT *
    FROM vps_agent_commands
    WHERE port_id=$1
    ORDER BY id DESC
    LIMIT 30
  `, [port.id]).catch(()=>({ rows: [] }));

  const latestList = logs.rows.find(x => x.command_type === 'list_files' && x.status === 'done');

  res.render('admin/vps-port-files', {
    pageTitle: 'จัดการไฟล์ MT5 Port',
    currentPath: '/admin/vps',
    user: req.user || req.session.user || null,
    success: req.session.success || '',
    error: req.session.error || '',
    port,
    folder,
    files: latestList?.result?.files || [],
    logs: logs.rows,
    portRoot: portRoot(port)
  });

  req.session.success = '';
  req.session.error = '';
});

router.post('/vps/ports/:id/command', async (req, res) => {
  await ensure();

  const port = await getPort(req.params.id);
  if (!port) return res.redirect('/admin/vps');

  const cmd = req.body.command;
  const folder = req.body.folder_path || req.query.path || portRoot(port);

  if (cmd === 'list_files') {
    await queue(port, 'list_files', { folder_path: folder });
  } else if (cmd === 'read_file') {
    await queue(port, 'read_file', { file_path: req.body.file_path });
  } else if (cmd === 'write_file') {
    await queue(port, 'write_file', {
      file_path: req.body.file_path,
      content: req.body.content || ''
    });
  } else if (cmd === 'delete_file') {
    await queue(port, 'delete_file', { file_path: req.body.file_path });
  } else if (cmd === 'create_folder') {
    await queue(port, 'create_folder', { folder_path: req.body.folder_path });
  } else if (cmd === 'reset_mt5') {
    await queue(port, 'reset_mt5', { folder_path: portRoot(port) });
  } else if (cmd === 'stop_mt5') {
    await queue(port, 'stop_mt5', { folder_path: portRoot(port) });
  } else if (cmd === 'read_parameters') {
    await queue(port, 'read_parameters', { folder_path: portRoot(port) });
  }

  req.session.success = 'ส่งคำสั่งไปที่ Windows VPS แล้ว';
  res.redirect('/admin/vps/ports/' + port.id + '/files?path=' + encodeURIComponent(folder));
});

router.post('/vps/ports/:id/force-stop', async (req, res) => {
  try {
    await ensure();

    const port = await getPort(req.params.id);
    if (!port) return res.redirect('/admin/vps');

    await queue(port, 'stop_mt5', {
      folder_path: portRoot(port),
      reason: 'admin_force_stop'
    });

    await query(`
      UPDATE vps_allocations
      SET status='free',
          assigned_user_id=NULL,
          updated_at=NOW()
      WHERE id=$1
    `, [port.id]).catch(() => {});

    req.session.success = 'ส่งคำสั่ง Force Stop ไปที่ Agent แล้ว';
    return res.redirect('/admin/vps/' + port.node_id + '/ports');

  } catch (e) {
    req.session.error = e.message;
    return res.redirect('/admin/vps');
  }
});

router.post('/vps/ports/:id/disable', async (req, res) => {
  try {
    await ensure();

    const port = await getPort(req.params.id);
    if (!port) return res.redirect('/admin/vps');

    await queue(port, 'stop_mt5', {
      folder_path: portRoot(port),
      reason: 'admin_disable_port'
    });

    await query(`
      UPDATE vps_allocations
      SET status='disabled',
          updated_at=NOW()
      WHERE id=$1
    `, [port.id]).catch(() => {});

    req.session.success = 'ปิดใช้งาน PORT แล้ว และส่งคำสั่ง kill terminal64.exe แล้ว';
    return res.redirect('/admin/vps/' + port.node_id + '/ports');

  } catch (e) {
    req.session.error = e.message;
    return res.redirect('/admin/vps');
  }
});

router.post('/vps/ports/:id/enable', async (req, res) => {
  try {
    await ensure();

    const port = await getPort(req.params.id);
    if (!port) return res.redirect('/admin/vps');

    await query(`
      UPDATE vps_allocations
      SET status='free',
          updated_at=NOW()
      WHERE id=$1
    `, [port.id]).catch(() => {});

    req.session.success = 'เปิดใช้งาน PORT แล้ว';
    return res.redirect('/admin/vps/' + port.node_id + '/ports');

  } catch (e) {
    req.session.error = e.message;
    return res.redirect('/admin/vps');
  }
});

const fs = require('fs');

router.post('/vps/deploy-agent-all', async (req, res) => {

  try {

    await ensure();

    const deployPayload = buildDeployPayload();

    const nodes = await query(`
      SELECT id
      FROM vps_system.vps_nodes
      WHERE COALESCE(agent_enabled, TRUE)=TRUE
    `).catch(() => query(`
      SELECT id FROM vps_nodes WHERE COALESCE(agent_enabled, TRUE)=TRUE
    `));

    for (const node of nodes.rows) {
      await query(`
        INSERT INTO vps_system.vps_agent_commands
        (vps_id, node_id, command_type, payload, status, created_at, updated_at)
        VALUES ($1, $1, 'deploy_agent', $2::jsonb, 'pending', NOW(), NOW())
      `, [node.id, JSON.stringify(deployPayload)]);
    }

    req.session.success =
      'ส่ง Deploy Agent ไปทุก VPS แล้ว';

    return res.redirect('/admin/vps');

  } catch (e) {

    req.session.error = e.message;

    return res.redirect('/admin/vps');

  }

});

router.get('/vps/:id/ports/live-json', async (req, res) => {
  try {
    const { fetchLiveHealthMap, parsePortNumber } = require('../lib/adminVpsBridge');
    const nodeId = Number(req.params.id);
    const liveMap = await fetchLiveHealthMap(nodeId);

    const alloc = await query(`
      SELECT id, port_name, port_number, folder_path
      FROM vps_allocations WHERE node_id=$1
      ORDER BY COALESCE(NULLIF(regexp_replace(port_number::text,'[^0-9]','','g'),'')::int, id)
    `, [nodeId]).catch(() => ({ rows: [] }));

    const ports = (alloc.rows || []).map((p) => {
      const portNo = parsePortNumber(p);
      const live = liveMap[portNo] || {};
      const running = live.running === true;
      return {
        port_no: portNo,
        port_number: portNo,
        folder_path: p.folder_path || live.folder_path,
        is_running: running,
        running,
        status: running ? 'running' : 'free',
        mt5_login: live.mt5_login || null,
        age_seconds: live.updated_at
          ? Math.max(0, (Date.now() - new Date(live.updated_at).getTime()) / 1000)
          : 999
      };
    });

    return res.json({ ok: true, ports });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
