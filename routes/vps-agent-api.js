const express = require('express');
const { query } = require('../config/database');
const { parseMt5JournalOutcome } = require('../lib/mt5JournalVerify');

const router = express.Router();
const OLD_TOKEN = 'avelqua-vps-2026';

async function ensure() {
  await query(`CREATE SCHEMA IF NOT EXISTS vps_system`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS node_code TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.vps_nodes ADD COLUMN IF NOT EXISTS node_code TEXT`).catch(() => {});

  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS agent_enabled BOOLEAN DEFAULT TRUE`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS cpu_percent NUMERIC(8,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS ram_percent NUMERIC(8,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS net_down_mbps NUMERIC(18,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS net_up_mbps NUMERIC(18,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS ping_ms NUMERIC(10,2) DEFAULT 0`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS last_error TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_nodes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS vps_node_logs (
      id BIGSERIAL PRIMARY KEY,
      node_id BIGINT,
      status TEXT,
      level TEXT DEFAULT 'normal',
      cpu_percent NUMERIC(8,2) DEFAULT 0,
      ram_percent NUMERIC(8,2) DEFAULT 0,
      net_down_mbps NUMERIC(18,2) DEFAULT 0,
      net_up_mbps NUMERIC(18,2) DEFAULT 0,
      ping_ms NUMERIC(10,2) DEFAULT 0,
      last_error TEXT DEFAULT '',
      payload JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

async function findNode(req) {
  const agentToken = String(
    req.headers['x-agent-token'] ||
    req.body?.agent_token ||
    req.query?.token ||
    ''
  ).trim();

  const oldToken = req.body?.token || req.query?.old_token;
  const nodeId = req.body?.node_id || req.query?.node_id;

  if (agentToken) {
    const r = await query(`
      SELECT *
      FROM vps_system.vps_nodes
      WHERE agent_token=$1 OR node_code=$1
      LIMIT 1
    `, [agentToken]);

    if (r.rows[0]) return r.rows[0];
  }

  if (oldToken === OLD_TOKEN && nodeId) {
    const r = await query(`
      SELECT *
      FROM vps_system.vps_nodes
      WHERE id=$1
      LIMIT 1
    `, [nodeId]);

    if (r.rows[0]) return r.rows[0];
  }

  return null;
}

router.post('/heartbeat', async (req, res) => {
  try {
    await ensure();

    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok:false, error:'Unauthorized agent' });

    const agentEnabled = node.agent_enabled !== false;
    const incomingStatus = req.body.status || 'online';
    const finalStatus = agentEnabled ? incomingStatus : 'offline';

    const cpu = Number(req.body.cpu_percent || 0);
    const ram = Number(req.body.ram_percent || 0);
    const down = Number(req.body.net_down_mbps || 0);
    const up = Number(req.body.net_up_mbps || 0);
    const ping = Number(req.body.ping_ms || 0);
    const lastError = req.body.last_error || '';

    const level = lastError
      ? 'error'
      : (cpu >= 90 || ram >= 90 || ping >= 300 ? 'alarm' : 'normal');

    await query(`
      UPDATE vps_system.vps_nodes
      SET status=$2,
          cpu_percent=$3,
          ram_percent=$4,
          net_down_mbps=$5,
          net_up_mbps=$6,
          ping_ms=$7,
          last_error=$8,
          last_heartbeat=NOW(),
          last_seen_at=NOW(),
          updated_at=NOW()
      WHERE id=$1
    `, [
      Number(node.id),
      finalStatus,
      cpu,
      ram,
      down,
      up,
      ping,
      lastError
    ]);

    
    await query(`DELETE FROM vps_system.vps_node_logs WHERE created_at < NOW() - INTERVAL '5 days'`).catch(() => {});

    await query(`
      INSERT INTO vps_system.vps_node_logs
      (node_id,status,level,cpu_percent,ram_percent,net_down_mbps,net_up_mbps,ping_ms,last_error,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [
      Number(node.id),
      finalStatus,
      level,
      cpu,
      ram,
      down,
      up,
      ping,
      lastError,
      JSON.stringify(req.body || {})
    ]);

    return res.json({
      ok:true,
      node_id:node.id,
      agent_enabled:agentEnabled,
      status:finalStatus
    });
  } catch (e) {
    console.error('[VPS HEARTBEAT ERROR]', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
});

router.post('/port-health', async (req, res) => {
  try {
    await ensure();

    const token =
      req.headers['x-agent-token'] ||
      req.body.agent_token ||
      '';

    const { ports } = req.body || {};

    if (!token) {
      return res.status(401).json({ ok: false, message: 'NO_TOKEN' });
    }

    const nodeRows = await query(`
      SELECT id
      FROM vps_system.vps_nodes
      WHERE agent_token=$1 OR node_code=$1
      LIMIT 1
    `, [token]);

    const node = nodeRows.rows?.[0] || nodeRows[0];

    if (!node) {
      return res.status(403).json({ ok: false, message: 'INVALID_AGENT' });
    }

    if (!Array.isArray(ports)) {
      return res.status(400).json({ ok: false, message: 'PORTS_MUST_BE_ARRAY' });
    }

    await query(`
      UPDATE vps_system.vps_nodes
      SET
        status='online',
        last_heartbeat=NOW(),
        updated_at=NOW()
      WHERE id=$1
    `, [node.id]);

    for (const p of ports) {
      const portNo = Number(p.port_no);
      if (!portNo) continue;

      const running = p.running === true;
      const processId = p.process_id ? Number(p.process_id) : null;
      const folderPath = String(p.folder_path || '');

      await query(`
        UPDATE vps_system.vps_ports
        SET
          folder_path = COALESCE(NULLIF($2,''), folder_path),
          process_id = $3,
          last_seen_at = NOW(),
          updated_at = NOW(),
          status = CASE
            WHEN disabled_at IS NOT NULL THEN 'disabled'
            WHEN $4::boolean = true AND status IN ('available','locked','running','error') THEN 'running'
            WHEN $4::boolean = false AND status IN ('running','error') THEN 'available'
            ELSE status
          END
        WHERE vps_id=$1
          AND port_no=$5
      `, [
        node.id,
        folderPath,
        processId,
        running,
        portNo
      ]);
    }

    return res.json({
      ok: true,
      count: ports.length
    });

  } catch (err) {
    console.error('[AGENT PORT HEALTH ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

router.get('/commands/next', async (req, res) => {
  try {
    await ensure();

    const node = await findNode(req);
    if (!node) {
      return res.status(401).json({ ok:false, error:'Unauthorized agent' });
    }

    const r = await query(`
      UPDATE vps_system.vps_agent_commands
      SET
        status='processing',
        picked_at=NOW(),
        locked_at=NOW(),
        started_at=NOW(),
        updated_at=NOW()
      WHERE id = (
        SELECT id
        FROM vps_system.vps_agent_commands
        WHERE vps_id=$1
          AND status='pending'
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, command_type, payload
    `, [node.id]);

    if (!r.rows[0]) {
      return res.json({ ok:true, command:null });
    }

    return res.json({
      ok:true,
      command:r.rows[0]
    });

  } catch (e) {
    console.error('[VPS COMMAND NEXT ERROR]', e);
    return res.status(500).json({ ok:false, error:e.message });
  }
});

async function saveResult(req, res) {
  try {
    await ensure();

    const node = await findNode(req);
    if (!node) return res.status(401).json({ ok:false, error:'Unauthorized agent' });

    const commandId = req.params.id || req.body.command_id || req.body.id;
    if (!commandId) return res.status(400).json({ ok:false, error:'missing command_id' });

    const ok = req.body.ok !== false;
    await query(`
      UPDATE vps_system.vps_agent_commands
      SET status=$3,
          result=$4::jsonb,
          error=$5,
          finished_at=NOW(),
          updated_at=NOW()
      WHERE id=$1::bigint AND vps_id=$2::bigint
    `, [
      commandId,
      node.id,
      ok ? 'success' : 'failed',
      JSON.stringify(req.body.result || {}),
      req.body.error || ''
    ]);

    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
}

router.get('/queue', async (req, res) => {

  try {

    await ensure();

    const token =
      req.headers['x-agent-token'] ||
      req.query.token ||
      '';

    if (!token) {
      return res.status(401).json({
        ok: false,
        message: 'NO_TOKEN'
      });
    }

    const nodeRows = await query(`
      SELECT *
      FROM vps_system.vps_nodes
      WHERE agent_token=$1 OR node_code=$1
      LIMIT 1
    `, [token]);

    const node = nodeRows.rows?.[0] || nodeRows[0];

    if (!node) {
      return res.status(403).json({
        ok: false,
        message: 'INVALID_AGENT'
      });
    }

    await query(`
      UPDATE vps_system.vps_nodes
      SET
        status='online',
        last_heartbeat=NOW(),
        last_seen_at=NOW(),
        updated_at=NOW()
      WHERE id=$1
    `, [node.id]);

    const cmdRows = await query(`
      WITH next_cmd AS (

        SELECT id
        FROM vps_system.vps_agent_commands
        WHERE vps_id=$1
          AND status='pending'
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1

      )

      UPDATE vps_system.vps_agent_commands c
      SET
        status='processing',
        locked_at=NOW(),
        started_at=NOW(),
        updated_at=NOW()
      FROM next_cmd
      WHERE c.id = next_cmd.id
      RETURNING c.*;
    `, [node.id]);

    const cmd = cmdRows.rows?.[0] || cmdRows[0];

    if (!cmd) {
      return res.json({
        ok: true,
        command: null
      });
    }

    return res.json({
      ok: true,
      command: cmd
    });

  } catch (err) {

    console.error('[AGENT QUEUE ERROR]', err);

    return res.status(500).json({
      ok: false,
      message: err.message
    });

  }

});

router.post('/command-result', async (req, res) => {
  try {
    await ensure();

    const token =
      req.headers['x-agent-token'] ||
      req.body.agent_token ||
      '';

    const {
      command_id,
      status,
      message,
      result
    } = req.body || {};

    if (!token) {
      return res.status(401).json({ ok: false, message: 'NO_TOKEN' });
    }

    const nodeRows = await query(`
      SELECT id
      FROM vps_system.vps_nodes
      WHERE agent_token=$1 OR node_code=$1
      LIMIT 1
    `, [token]);

    const node = nodeRows.rows?.[0] || nodeRows[0];

    if (!node) {
      return res.status(403).json({ ok: false, message: 'INVALID_AGENT' });
    }

    if (!command_id) {
      return res.status(400).json({ ok: false, message: 'NO_COMMAND_ID' });
    }

    await query(`
      UPDATE vps_system.vps_agent_commands
      SET
        status=$1,
        finished_at=NOW(),
        result_message=$2,
        result=$3::jsonb,
        updated_at=NOW()
      WHERE id=$4
        AND vps_id=$5
    `, [
      status === 'success' ? 'success' : 'failed',
      message || '',
      JSON.stringify(result || {}),
      command_id,
      node.id
    ]);

    return res.json({ ok: true });

  } catch (err) {
    console.error('[AGENT COMMAND RESULT ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

router.post('/commands/result', saveResult);
router.post('/commands/:id/result', saveResult);

// ===== AGENT CONNECT RESULT: รับผล Login MT5 จริงจาก Agent =====
router.post('/connect-result', async (req, res) => {
  try {
    await ensure();

    const token =
      req.headers['x-agent-token'] ||
      req.body.agent_token ||
      '';

    const {
      accountId,
      portId,
      status,
      message,
      process_id,
      mt5Login
    } = req.body || {};

    if (!token) {
      return res.status(401).json({ ok: false, message: 'NO_TOKEN' });
    }

    const nodeRows = await query(`
      SELECT id
      FROM vps_system.vps_nodes
      WHERE agent_token=$1 OR node_code=$1
      LIMIT 1
    `, [token]);

    const node = nodeRows.rows?.[0] || nodeRows[0];

    if (!node) {
      return res.status(403).json({ ok: false, message: 'INVALID_AGENT' });
    }

    if (!accountId || !portId) {
      return res.status(400).json({
        ok: false,
        message: 'NO_ACCOUNT_OR_PORT'
      });
    }

    if (status === 'starting') {
      await query(`
        UPDATE vps_system.mt5_accounts
        SET status = 'starting',
            last_error = NULL,
            updated_at = NOW()
        WHERE id = $1
      `, [accountId]);

      return res.json({ ok: true });
    }

    if (status === 'connected') {
      const loginVerified = req.body.loginVerified === true || req.body.login_verified === true;
      if (!loginVerified) {
        return res.json({ ok: true, ignored: true, reason: 'LOGIN_NOT_VERIFIED' });
      }

      let loginForJournal = String(mt5Login || '').trim();
      if (!loginForJournal) {
        const accRow = await query(
          `SELECT mt5_login FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
          [accountId]
        ).catch(() => ({ rows: [] }));
        loginForJournal = String(accRow.rows?.[0]?.mt5_login || '').trim();
      }
      const journalEvidence = String(
        req.body.journalEvidence || req.body.journal_evidence || ''
      ).trim();
      const journalVerdict = journalEvidence && loginForJournal
        ? parseMt5JournalOutcome(journalEvidence, loginForJournal)
        : null;
      if (!journalEvidence || journalVerdict !== 'success') {
        const failMsg = journalVerdict === 'failed'
          ? 'MT5 Login หรือ Password ไม่ถูกต้อง'
          : 'ไม่พบหลักฐาน authorized on ใน Journal';
        await query(`
          UPDATE vps_system.mt5_accounts
          SET status='failed', last_error=$2, updated_at=NOW()
          WHERE id=$1
        `, [accountId, failMsg]).catch(() => {});
        return res.json({ ok: true, rejected: true, reason: 'JOURNAL_NOT_VERIFIED' });
      }

      await query(`
        UPDATE vps_system.mt5_accounts
        SET
          status='connected',
          last_error=NULL,
          connected_at=NOW(),
          updated_at=NOW()
        WHERE id=$1
      `, [accountId]);

      await query(`
        UPDATE vps_system.vps_ports
        SET
          status='running',
          process_id=$2,
          mt5_login=$3,
          locked_until=NULL,
          updated_at=NOW()
        WHERE id=$1
      `, [
        portId,
        process_id || null,
        mt5Login || ''
      ]);

      return res.json({ ok: true });
    }

    if (status === 'failed') {
      await query(`
        UPDATE vps_system.mt5_accounts
        SET
          status='failed',
          last_error=$2,
          updated_at=NOW()
        WHERE id=$1
      `, [
        accountId,
        message || 'MT5 login failed'
      ]);

      await query(`
        UPDATE vps_system.vps_ports
        SET
          status='available',
          locked_by_user_id=NULL,
          locked_until=NULL,
          process_id=NULL,
          mt5_login=NULL,
          last_error=$2,
          updated_at=NOW()
        WHERE id=$1
      `, [
        portId,
        message || 'MT5 login failed'
      ]);

      return res.json({ ok: true });
    }

    return res.json({ ok: true, ignored: true, status });

  } catch (err) {
    console.error('[AGENT CONNECT RESULT ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

module.exports = router;
