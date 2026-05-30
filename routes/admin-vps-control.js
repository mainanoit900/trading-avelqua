const express = require('express');
const crypto = require('crypto');
const { query } = require('../config/database');
const requireAdmin = require('../middleware/admin');
const {
  resolveSystemVpsId,
  queueSystemAgentCommand,
  fetchLiveHealthMap,
  countLiveRunningPorts,
  countLiveUsedLot
} = require('../lib/adminVpsBridge');

const router = express.Router();
router.use(requireAdmin);

function flash(req) {
  const success = req.session.success || '';
  const error = req.session.error || '';
  req.session.success = '';
  req.session.error = '';
  return { success, error };
}

function view(req, extra = {}) {
  return {
    pageTitle: extra.pageTitle || 'Windows VPS Bot',
    currentPath: '/admin/vps',
    currentUrl: req.originalUrl,
    user: req.user || req.session.user || null,
    ...flash(req),
    ...extra
  };
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://trading.avelqua.com';
}

async function ensure() {

  await query(`CREATE SCHEMA IF NOT EXISTS vps_system`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.vps_port_health (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT NOT NULL,
      port_number INT NOT NULL,
      folder_path TEXT,
      terminal_exists BOOLEAN DEFAULT FALSE,
      running BOOLEAN DEFAULT FALSE,
      pid JSONB DEFAULT '[]'::jsonb,
      cpu_percent NUMERIC DEFAULT 0,
      ram_percent NUMERIC DEFAULT 0,
      ping_ms NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(node_id, port_number)
    )
  `).catch(() => {});

  await query(`
    CREATE INDEX IF NOT EXISTS idx_vps_port_health_pick
    ON vps_system.vps_port_health(node_id, port_number, running, terminal_exists, updated_at)
  `).catch(() => {});

  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS node_id VARCHAR(80)`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS agent_token TEXT UNIQUE`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS cpu_percent NUMERIC(8,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS ram_percent NUMERIC(8,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS net_down_mbps NUMERIC(18,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS net_up_mbps NUMERIC(18,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS ping_ms NUMERIC(10,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN DEFAULT TRUE`).catch(() => {});
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vps_nodes_node_id ON vps_nodes(node_id)`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_agent_commands (
      id BIGSERIAL PRIMARY KEY,
      vps_id BIGINT,
      node_id BIGINT,
      port_id BIGINT,
      command_type TEXT,
      payload JSONB DEFAULT '{}'::jsonb,
      status TEXT DEFAULT 'pending',
      result JSONB DEFAULT '{}'::jsonb,
      error TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      picked_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS vps_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS node_id BIGINT`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS command_type TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}'::jsonb`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS result JSONB DEFAULT '{}'::jsonb`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS error TEXT DEFAULT ''`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS picked_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE vps_agent_commands ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_vps_agent_commands_node_status ON vps_agent_commands(node_id,status,id)`).catch(() => {});
}

function calcSummary(nodes) {
  return {
    totalNodes: nodes.length,
    onlineNodes: nodes.filter(x => x.agent_enabled !== false && ['online', 'available'].includes(String(x.status || '').toLowerCase())).length,
    offlineNodes: nodes.filter(x => !['online', 'available'].includes(String(x.status || '').toLowerCase())).length,
    usedPorts: nodes.reduce((a, b) => a + Number(b.used_ports || 0), 0),
    totalPorts: nodes.reduce((a, b) => a + Number(b.max_ports || 0), 0),
    usedLot: nodes.reduce((a, b) => a + Number(b.used_lot || 0), 0),
    totalLot: nodes.reduce((a, b) => a + Number(b.max_lot || 0), 0),
    errorBots: nodes.filter(x => x.last_error || x.last_error_message).length
  };
}

function agentCode(node) {
  return `$env:AVELQUA_SERVER_URL="${publicBaseUrl()}"
$env:AVELQUA_AGENT_TOKEN="${node.agent_token || ''}"
$env:AVELQUA_VPS_NAME="${node.node_name || ''}"`;
}

async function getNodes() {
  const r = await query(`SELECT * FROM vps_nodes ORDER BY id DESC`);
  const nodes = r.rows || [];

  // เติมค่า Port ใช้งาน / Port ทั้งหมด / Lot ใช้งาน จากข้อมูลจริง โดยไม่ทำลายโครงสร้างเดิม
  for (const node of nodes) {
    try {
      const alloc = await query(`
        SELECT
          COUNT(*)::int AS total_ports,
          COALESCE(SUM(COALESCE(max_lot,0)),0)::numeric AS alloc_max_lot
        FROM vps_allocations
        WHERE node_id=$1
          AND LOWER(TRIM(COALESCE(status,''))) <> 'deleted'
      `, [node.id]).catch(() => ({ rows: [] }));

      const liveUsedPorts = await countLiveRunningPorts(node.id);
      const liveUsedLot = await countLiveUsedLot(node.id).catch(() => 0);
      const totalPortsFromAlloc = Number(alloc.rows[0]?.total_ports || 0);
      const maxPorts = totalPortsFromAlloc || Number(node.max_ports || 0);
      node.max_ports = maxPorts;
      node.used_ports = liveUsedPorts;
      node.active_ports = liveUsedPorts;
      node.used_lot = liveUsedLot;
      node.active_lot = liveUsedLot;
      node.max_lot = Number(node.max_lot || alloc.rows[0]?.alloc_max_lot || 0);

      const sys = await resolveSystemVpsId(node.id);
      const sysNode = await query(`
        SELECT cpu_percent, ram_percent, net_down_mbps, net_up_mbps, ping_ms, last_seen_at, status
        FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1
      `, [sys.systemVpsId]).catch(() => ({ rows: [] }));
      if (sysNode.rows[0]) {
        const sn = sysNode.rows[0];
        const seenMs = sn.last_seen_at ? new Date(sn.last_seen_at).getTime() : 0;
        const fresh = seenMs > 0 && Date.now() - seenMs < 3 * 60 * 1000;
        if (fresh) {
          node.cpu_percent = sn.cpu_percent ?? node.cpu_percent;
          node.ram_percent = sn.ram_percent ?? node.ram_percent;
          node.net_down_mbps = sn.net_down_mbps ?? 0;
          node.net_up_mbps = sn.net_up_mbps ?? 0;
          node.ping_ms = sn.ping_ms ?? node.ping_ms;
          node.last_seen_at = sn.last_seen_at;
          if (sn.status) node.status = sn.status;
        }
      }
    } catch (e) {
      // ถ้าตารางเสริมยังไม่พร้อม ให้ใช้ค่าจาก vps_nodes เดิมต่อไป
      node.used_ports = Number(node.used_ports || node.active_ports || 0);
      node.active_ports = node.used_ports;
      node.used_lot = Number(node.used_lot || node.active_lot || 0);
      node.active_lot = node.used_lot;
      node.max_ports = Number(node.max_ports || 0);
      node.max_lot = Number(node.max_lot || 0);
    }
  }

  return nodes;
}

async function insertCommand(nodeId, commandType, payload = {}) {
  const lockKey = `node:${nodeId}:${commandType}`;
  const { systemVpsId } = await resolveSystemVpsId(nodeId);

  const busy = await query(`
    SELECT id FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type=$2
      AND LOWER(COALESCE(status,'')) IN ('pending','processing','picked','running')
    ORDER BY id DESC
    LIMIT 1
  `, [systemVpsId, commandType]).catch(() => ({ rows: [] }));

  if (busy.rows.length) {
    return {
      id: busy.rows[0].id,
      command_type: commandType,
      status: 'pending',
      skipped: true
    };
  }

  const row = await queueSystemAgentCommand(systemVpsId, commandType, { ...payload, lockKey });
  return row || { command_type: commandType, status: 'pending' };
}

router.get('/vps', async (req, res) => {
  try {
    await ensure();
    const nodes = await getNodes();
    return res.render('admin/vps', view(req, {
      pageTitle: 'ตั้งค่า Windows VPS Bot',
      nodes,
      vpsSummary: calcSummary(nodes),
      pagination: { page: 1, totalPages: 1 },
      agentCode
    }));
  } catch (err) {
    console.error('ADMIN VPS CONTROL PAGE ERROR:', err);
    return res.status(500).send('ADMIN VPS CONTROL PAGE ERROR');
  }
});

router.post('/vps/port-health', async (req, res) => {
  try {
    await ensure();

    const token = req.headers['x-agent-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const nodeRes = await query(`
      SELECT id
      FROM vps_nodes
      WHERE agent_token=$1
      LIMIT 1
    `, [token]);

    const node = nodeRes.rows[0];
    if (!node) return res.status(401).json({ ok: false, error: 'invalid_agent_token' });

    const ports = Array.isArray(req.body.ports) ? req.body.ports : [];
    const m = req.body.metrics || {};

    for (const p of ports) {
      await query(`
        INSERT INTO vps_system.vps_port_health
          (node_id, port_number, folder_path, terminal_exists, running, pid,
           cpu_percent, ram_percent, ping_ms, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,NOW())
        ON CONFLICT (node_id, port_number) DO UPDATE SET
          folder_path=EXCLUDED.folder_path,
          terminal_exists=EXCLUDED.terminal_exists,
          running=EXCLUDED.running,
          pid=EXCLUDED.pid,
          cpu_percent=EXCLUDED.cpu_percent,
          ram_percent=EXCLUDED.ram_percent,
          ping_ms=EXCLUDED.ping_ms,
          updated_at=NOW()
      `, [
        node.id,
        Number(p.portNumber || p.port || 0),
        p.folderPath || p.folder_path || '',
        !!p.terminalExists,
        !!p.running,
        JSON.stringify(p.pid || []),
        Number(m.cpu_percent || 0),
        Number(m.ram_percent || 0),
        Number(m.ping_ms || 0)
      ]);
    }

    return res.json({ ok: true, saved: ports.length });
  } catch (e) {
    console.error('VPS PORT HEALTH ERROR:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/vps/api/nodes', async (req, res) => {
  try {
    await ensure();
    const nodes = await getNodes();
    return res.json({ ok: true, nodes, vpsSummary: calcSummary(nodes) });
  } catch (err) {
    console.error('ADMIN VPS API NODES ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/vps/nodes/:id/command', async (req, res) => {
  try {
    await ensure();
    const nodeId = req.params.id;
    const requested = String(req.body.command || '').trim();
    const allowed = new Set(['connect_agent', 'disconnect_agent', 'status', 'restart_agent', 'get_log', 'refresh_metrics']);
    if (!allowed.has(requested)) {
      return res.status(400).json({ ok: false, error: 'command_not_allowed' });
    }

    const nodeRes = await query(`SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1`, [nodeId]);
    if (!nodeRes.rows[0]) {
      return res.status(404).json({ ok: false, error: 'ไม่พบ VPS นี้' });
    }

    const command = await insertCommand(nodeId, requested, {
      source: 'admin_vps_page',
      requested_at: new Date().toISOString()
    });

    if (requested === 'connect_agent') {
      await query(`UPDATE vps_nodes SET status='online', agent_enabled=true, updated_at=NOW() WHERE id=$1`, [nodeId]).catch(() => {});
    }
    if (requested === 'disconnect_agent') {
      await query(`UPDATE vps_nodes SET status='offline', agent_enabled=false, updated_at=NOW() WHERE id=$1`, [nodeId]).catch(() => {});
    }

    const msgMap = {
      connect_agent: 'ส่งคำสั่งเชื่อมต่อไปที่ Windows VPS แล้ว',
      disconnect_agent: 'ส่งคำสั่งปิดการเชื่อมต่อไปที่ Windows VPS แล้ว',
      status: 'ส่งคำสั่งดูสถานะไปที่ Windows VPS แล้ว',
      restart_agent: 'ส่งคำสั่งรีสตาร์ท Agent ไปที่ Windows VPS แล้ว',
      get_log: 'ส่งคำสั่งดู Log ไปที่ Windows VPS แล้ว',
      refresh_metrics: 'ส่งคำสั่งรีเฟรชค่าไปที่ Windows VPS แล้ว'
    };

    return res.json({ ok: true, message: msgMap[requested] || 'ส่งคำสั่งแล้ว', command });
  } catch (err) {
    console.error('ADMIN VPS SEND COMMAND ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/vps/commands/:id', async (req, res) => {
  try {
    await ensure();
    const r = await query(`
      SELECT id, vps_id AS node_id, command_type, status, result, error, created_at, picked_at, finished_at
      FROM vps_system.vps_agent_commands
      WHERE id=$1
      LIMIT 1
    `, [req.params.id]).catch(() => query(`
      SELECT id, node_id, command_type, status, result, error, created_at, picked_at, finished_at
      FROM vps_agent_commands WHERE id=$1 LIMIT 1
    `, [req.params.id]));
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'ไม่พบคำสั่ง' });
    return res.json({ ok: true, command: r.rows[0] });
  } catch (err) {
    console.error('ADMIN VPS COMMAND STATUS ERROR:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/vps/:id/agent-code', async (req, res) => {
  try {
    await ensure();
    const r = await query(`SELECT * FROM vps_nodes WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).send('not found');
    return res.type('text/plain').send(agentCode(r.rows[0]));
  } catch (err) {
    return res.status(500).send(err.message);
  }
});

router.post('/vps/:id/regenerate-token', async (req, res) => {
  try {
    await ensure();
    const newToken = makeToken();
    await query(`UPDATE vps_nodes SET agent_token=$2, updated_at=NOW() WHERE id=$1`, [req.params.id, newToken]);
    req.session.success = 'สร้าง TOKEN ใหม่เรียบร้อยแล้ว';
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  } catch (err) {
    console.error('REGENERATE TOKEN ERROR:', err);
    req.session.error = 'สร้าง TOKEN ไม่สำเร็จ';
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
});

router.post('/vps/:id/update-powershell', async (req, res) => {
  try {
    await ensure();
    const psCode = req.body.powershell_code || '';
    if (!psCode.trim()) {
      req.session.error = 'PowerShell ว่าง ไม่สามารถอัปเดตได้';
      return res.redirect('/admin/vps/' + req.params.id + '/edit');
    }

    await insertCommand(req.params.id, 'update_agent_script', {
      agent_path: 'C:\\avelqua-windows-agent\\agent.ps1',
      content: psCode
    });

    req.session.success = 'ส่งคำสั่งอัปเดต PowerShell ไปที่ VPS แล้ว';
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  } catch (err) {
    console.error('UPDATE POWERSHELL ERROR:', err);
    req.session.error = 'อัปเดต PowerShell ไม่สำเร็จ';
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
});


router.get('/vps/nodes/:id/status-details', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await query(`SELECT * FROM vps_nodes WHERE id=$1 LIMIT 1`, [id]);
    const n = r.rows[0];
    if (!n) return res.status(404).json({ ok:false, error:'ไม่พบ VPS' });

    const sys = await resolveSystemVpsId(id);
    const sysNode = await query(`
      SELECT cpu_percent, ram_percent, net_down_mbps, net_up_mbps, ping_ms, last_seen_at, status, agent_enabled, last_error
      FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1
    `, [sys.systemVpsId]).catch(() => ({ rows: [] }));

    const livePorts = await countLiveRunningPorts(id).catch(() => 0);
    const liveLot = await countLiveUsedLot(id).catch(() => 0);

    const merged = { ...n, ...(sysNode.rows[0] || {}) };
    const lastSeen = merged.last_seen_at ? new Date(merged.last_seen_at) : null;
    const ageSec = lastSeen ? Math.floor((Date.now() - lastSeen.getTime()) / 1000) : null;

    let state = 'ไม่มีการเชื่อมต่อ';
    let detail = 'Agent ยังไม่เคยส่ง heartbeat เข้ามา';

    if (lastSeen && ageSec <= 90) {
      state = 'ยังทำงานอยู่';
      detail = 'VPS Online และ Agent ส่งค่าปกติ';
    } else if (lastSeen && ageSec <= 300) {
      state = 'สัญญาณขาดช่วง';
      detail = `Agent ไม่ส่งค่ามา ${ageSec} วินาที`;
    } else if (lastSeen) {
      state = 'Offline / ไม่มีการเชื่อมต่อ';
      detail = `ขาดการเชื่อมต่อ ${ageSec} วินาที`;
    }

    if (merged.last_error) {
      state = 'มี Error';
      detail = merged.last_error;
    }

    res.json({
      ok:true,
      node: {
        ...merged,
        active_ports: livePorts,
        used_ports: livePorts,
        active_lot: liveLot,
        used_lot: liveLot
      },
      state,
      detail,
      ageSec
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.get('/vps/nodes/:id/logs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await query(`
      SELECT *
      FROM vps_node_logs
      WHERE node_id=$1
        ORDER BY created_at DESC
      LIMIT 200
    `, [id]);

    res.json({ ok:true, logs:r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

router.post('/vps/:id/update-agent-file', async (req, res) => {
  try {
    await ensure();

    const sourceFile =
      process.env.PYTHON_AGENT_SOURCE ||
      path.join(process.cwd(), 'agent', 'python-mt5-agent', 'agent.py');

    if (!fs.existsSync(sourceFile)) {
      req.session.error = 'ไม่พบไฟล์กลาง agent.py: ' + sourceFile;
      return res.redirect('/admin/vps/' + req.params.id + '/edit');
    }

    const content = fs.readFileSync(sourceFile, 'utf8');

    await insertCommand(req.params.id, 'update_agent_script', {
      agent_path: 'C:\\avelqua-python-agent\\agent.py',
      service_name: 'AvelquaPythonAgent',
      content
    });

    req.session.success = 'ส่งคำสั่งอัปเดต Python Agent ไปที่ VPS แล้ว';
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  } catch (err) {
    console.error('UPDATE PYTHON AGENT ERROR:', err);
    req.session.error = 'อัปเดต Python Agent ไม่สำเร็จ: ' + err.message;
    return res.redirect('/admin/vps/' + req.params.id + '/edit');
  }
});

const fs = require('fs');
const path = require('path');

router.post('/vps/deploy-agent-all', async (req, res) => {
  try {
    await ensure();

    const sourceFile = '/root/trading-avelqua/public/agent/agent.py';

    if (!fs.existsSync(sourceFile)) {
      req.session.error = 'ไม่พบ agent.py กลาง';
      return res.redirect('/admin/vps');
    }

// save version ก่อน deploy
const versionName = 'agent-' + new Date().toISOString().replace(/[:.]/g,'-') + '.py';

const versionDir = '/root/trading-avelqua/public/agent/versions';
fs.mkdirSync(versionDir, { recursive: true });

const versionPath = `${versionDir}/${versionName}`;
fs.copyFileSync(sourceFile, versionPath);

const content = fs.readFileSync(sourceFile, 'utf8');

const nodes = await query(`SELECT id FROM vps_nodes WHERE agent_enabled=TRUE`);

for (const n of nodes.rows) {

  await insertCommand(n.id, 'update_agent_script', {
    agent_path: 'C:\\avelqua-python-agent\\agent.py',
    service_name: 'AvelquaPythonAgent',
    version: versionName,
    content
  });

  // ✅ ต้องอยู่ใน loop
  await insertCommand(n.id, 'health_check_mt5', {
    reason: 'after_deploy',
    version: versionName
  });

}

    req.session.success = `Deploy สำเร็จทุก VPS (${nodes.rows.length} เครื่อง)`;
    res.redirect('/admin/vps');

  } catch (err) {
    console.error(err);
    req.session.error = err.message;
    res.redirect('/admin/vps');
  }
});

router.post('/vps/deploy-agent-version', async (req, res) => {
  try {
    await ensure();

    const version = req.body.version;
    const file = `/root/trading-avelqua/public/agent/versions/${version}`;

    if (!fs.existsSync(file)) {
      req.session.error = 'ไม่พบ version';
      return res.redirect('/admin/vps');
    }

    const content = fs.readFileSync(file, 'utf8');
    const nodes = await query(`SELECT id FROM vps_nodes WHERE agent_enabled=TRUE`);

    for (const n of nodes.rows) {
      await insertCommand(n.id, 'update_agent_script', {
        agent_path: 'C:\\avelqua-python-agent\\agent.py',
        service_name: 'AvelquaPythonAgent',
        version,
        content
      });
    }

    req.session.success = `Rollback version ${version} สำเร็จ`;
    res.redirect('/admin/vps');

  } catch (err) {
    req.session.error = err.message;
    res.redirect('/admin/vps');
  }
});

router.get('/vps/agent-versions', async (req, res) => {
  try {
    const fs = require('fs');
    const dir = '/root/trading-avelqua/public/agent/versions';
    if (!fs.existsSync(dir)) return res.json({ ok: true, versions: [] });

    const versions = fs.readdirSync(dir)
      .filter(x => x.endsWith('.py'))
      .sort()
      .reverse();

    res.json({ ok: true, versions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;


/* ===== FIX: Save Windows VPS Edit Page ===== */
router.post('/vps/:id/edit', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    await query(`
      UPDATE vps_nodes
      SET
        node_name=$2,
        ip_address=$3,
        username=$4,
        password=$5,
        max_ports=$6,
        max_lots=$7,
        note=$8,
        updated_at=NOW()
      WHERE id=$1
    `, [
      id,
      b.node_name || b.name || '',
      b.ip_address || b.ip || '',
      b.username || '',
      b.password || '',
      Number(b.max_ports || b.ports || 0),
      Number(b.max_lots || b.lots || 0),
      b.note || b.description || ''
    ]);

    return res.redirect('/admin/vps/' + id + '/edit?saved=1');
  } catch (err) {
    console.error('SAVE VPS EDIT ERROR:', err);
    return res.status(500).send('Save VPS edit error: ' + err.message);
  }
});

router.post('/vps/:id/edit', async (req,res)=>{
  try{
    const id = Number(req.params.id);

    console.log('BODY:', req.body);

    await query(`
      UPDATE vps_nodes SET
        node_name=$2,
        ip_address=$3,
        max_ports=$4,
        max_lots=$5,
        cpu_alarm=$6,
        ram_alarm=$7,
        ping_alarm=$8,
        bot_folder=$9,
        agent_folder=$10,
        agent_url=$11,
        updated_at=NOW()
      WHERE id=$1
    `,[
      id,
      req.body.node_name,
      req.body.ip_address,
      req.body.max_ports,
      req.body.max_lots,
      req.body.cpu_alarm,
      req.body.ram_alarm,
      req.body.ping_alarm,
      req.body.bot_folder,
      req.body.agent_folder,
      req.body.agent_url
    ]);

    return res.redirect('/admin/vps/'+id+'/edit?saved=1');

  }catch(e){
    console.error(e);
    res.status(500).send(e.message);
  }
});
