const express = require('express');
const { query, getClient } = require('../config/database');

const router = express.Router();

function tokenOf(req) {
  return String(
    req.headers['x-agent-token'] ||
    req.body?.agent_token ||
    req.query?.token ||
    ''
  ).trim();
}

async function nodeByToken(token) {
  if (!token) return null;

  const r = await query(`
    SELECT *
    FROM vps_system.vps_nodes
    WHERE agent_token=$1
       OR node_code=$1
    LIMIT 1
  `, [token]);

  return r.rows[0] || null;
}

function pickPortNo(b, payload) {
  return Number(
    b.port_no ||
    b.portNo ||
    b.portNumber ||
    b.port ||
    payload.port_no ||
    payload.portNo ||
    payload.portNumber ||
    payload.port ||
    0
  );
}

function pickAccountId(b, payload) {
  return Number(
    b.account_id ||
    b.accountId ||
    payload.account_id ||
    payload.accountId ||
    0
  );
}

function pickMt5Login(b, payload) {
  return String(
    b.mt5_login ||
    b.mt5Login ||
    payload.mt5_login ||
    payload.mt5Login ||
    ''
  );
}

/**
 * POST /api/vps-agent/pro/heartbeat
 */
router.post('/pro/heartbeat', async (req, res) => {
  try {
    const token = tokenOf(req);
    const node = await nodeByToken(token);

    if (!node) {
      return res.status(401).json({
        ok: false,
        message: 'bad agent token'
      });
    }

    const b = req.body || {};

    await query(`
      UPDATE vps_system.vps_nodes
      SET
        status='online',
        agent_version=$2,
        cpu_percent=COALESCE($3, cpu_percent),
        ram_percent=COALESCE($4, ram_percent),
        ping_ms=COALESCE($5, ping_ms),
        net_down_mbps=COALESCE($6, net_down_mbps),
        net_up_mbps=COALESCE($7, net_up_mbps),
        last_seen_at=NOW(),
        last_heartbeat=NOW(),
        last_error='',
        updated_at=NOW()
      WHERE id=$1
    `, [
      node.id,
      b.agent_version || b.version || '',
      b.cpu_percent ?? null,
      b.ram_percent ?? null,
      b.ping_ms ?? null,
      b.net_down_mbps ?? null,
      b.net_up_mbps ?? null
    ]);

    const ports = Array.isArray(b.ports) ? b.ports : [];

    for (const p of ports) {
      const portNo = Number(p.port_no || p.portNo || p.portNumber || p.port || 0);
      if (!portNo) continue;

      const running = p.running === true;
      const pid = Number(p.process_id || p.pid || 0) || null;
      const login = p.mt5Login || p.mt5_login || p.login || null;

      await query(`
        UPDATE vps_system.vps_ports
        SET
          status = CASE
            WHEN disabled_at IS NOT NULL THEN 'disabled'
            WHEN $3::boolean = TRUE THEN 'running'
            WHEN status IN ('reserved','starting','locked') THEN status
            ELSE 'available'
          END,
          process_id=$4,
          mt5_login=$5,
          last_seen_at=NOW(),
          updated_at=NOW()
        WHERE vps_id=$1
          AND port_no=$2
      `, [
        node.id,
        portNo,
        running,
        pid,
        login
      ]).catch(() => {});
    }

    return res.json({
      ok: true,
      node_id: node.id
    });

  } catch (err) {
    console.error('[PRO HEARTBEAT ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

/**
 * POST /api/vps-agent/pro/queue/next
 */
router.post('/pro/queue/next', async (req, res) => {
  const token = tokenOf(req);
  const node = await nodeByToken(token);

  if (!node) {
    return res.status(401).json({
      ok: false,
      message: 'bad agent token'
    });
  }

  const client = await getClient();

  try {
    await client.query('BEGIN');

    const r = await client.query(`
      SELECT id, command_type, payload
      FROM vps_system.vps_agent_commands
      WHERE vps_id=$1
        AND node_id=$1
        AND status='pending'
      ORDER BY id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `, [node.id]);

    if (!r.rows[0]) {
      await client.query('COMMIT');
      return res.json({
        ok: true,
        command: null
      });
    }

    await client.query(`
      UPDATE vps_system.vps_agent_commands
      SET
        status='processing',
        picked_at=NOW(),
        locked_at=NOW(),
        started_at=NOW(),
        updated_at=NOW()
      WHERE id=$1
    `, [r.rows[0].id]);

    await client.query('COMMIT');

    return res.json({
      ok: true,
      command: {
        id: r.rows[0].id,
        command_type: r.rows[0].command_type,
        payload: r.rows[0].payload
      }
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}

    console.error('[PRO QUEUE NEXT ERROR]', err);

    return res.status(500).json({
      ok: false,
      message: err.message
    });

  } finally {
    client.release();
  }
});

/**
 * POST /api/vps-agent/pro/command-result
 */
router.post('/pro/command-result', async (req, res) => {
  try {
    const token = tokenOf(req);
    const node = await nodeByToken(token);

    if (!node) {
      return res.status(401).json({
        ok: false,
        message: 'bad agent token'
      });
    }

    const b = req.body || {};
    const payload = b.payload || b.result?.payload || {};

    const commandId = Number(b.command_id || b.commandId || b.id || 0);
    const rawStatus = String(b.status || '').toLowerCase();

    let status = 'failed';

    if (rawStatus === 'starting') {
      status = 'starting';
    } else if (
      rawStatus === 'connected' ||
      rawStatus === 'success' ||
      b.ok === true
    ) {
      status = 'connected';
    }

    const portNo = pickPortNo(b, payload);
    const accountId = pickAccountId(b, payload);
    const mt5Login = pickMt5Login(b, payload);

    const msg = String(
      b.message ||
      b.result_message ||
      payload.message ||
      (
        status === 'connected'
          ? 'MT5 connected'
          : status === 'starting'
            ? 'MT5 starting'
            : 'MT5 login failed'
      )
    );

    const pid = Number(
      b.pid ||
      b.process_id ||
      b.processId ||
      payload.pid ||
      payload.process_id ||
      0
    ) || null;

    /**
     * สำคัญ:
     * starting = ห้ามบันทึกเป็น failed
     */
    if (status === 'starting') {
      if (commandId) {
        await query(`
          UPDATE vps_system.vps_agent_commands
          SET
            status='processing',
            result_message=$2,
            result=$3::jsonb,
            updated_at=NOW()
          WHERE id=$1
        `, [
          commandId,
          msg,
          JSON.stringify(b)
        ]).catch(() => {});
      }

      if (portNo) {
        await query(`
          UPDATE vps_system.vps_ports
          SET
            status='starting',
            last_error='',
            updated_at=NOW()
          WHERE vps_id=$1
            AND port_no=$2
        `, [
          node.id,
          portNo
        ]).catch(() => {});
      }

      if (accountId) {
        await query(`
          UPDATE vps_system.mt5_accounts
          SET
            status='checking',
            last_error='',
            last_login_message=$2,
            updated_at=NOW()
          WHERE id=$1
        `, [
          accountId,
          msg
        ]).catch(() => {});
      } else if (portNo && mt5Login) {
        await query(`
          UPDATE vps_system.mt5_accounts
          SET
            status='checking',
            last_error='',
            last_login_message=$4,
            updated_at=NOW()
          WHERE vps_id=$1
            AND port_slot=$2
            AND mt5_login=$3
            AND status IN ('connecting','checking')
        `, [
          node.id,
          portNo,
          mt5Login,
          msg
        ]).catch(() => {});
      }

      return res.json({
        ok: true,
        status: 'starting'
      });
    }

    /**
     * connected / failed
     */
    if (commandId) {
      await query(`
        UPDATE vps_system.vps_agent_commands
        SET
          status=$2,
          finished_at=NOW(),
          result_message=$3,
          result=$4::jsonb,
          error=CASE WHEN $2='failed' THEN $3 ELSE '' END,
          updated_at=NOW()
        WHERE id=$1
      `, [
        commandId,
        status === 'connected' ? 'done' : 'failed',
        msg,
        JSON.stringify(b)
      ]).catch(() => {});
    }

    if (portNo) {
      await query(`
        UPDATE vps_system.vps_ports
        SET
          status=$3,
          process_id=$4,
          mt5_login=$5,
          last_error=CASE WHEN $3='failed' THEN $6 ELSE '' END,
          locked_by_user_id=CASE WHEN $3='failed' THEN NULL ELSE locked_by_user_id END,
          locked_until=CASE WHEN $3='failed' THEN NULL ELSE locked_until END,
          last_seen_at=NOW(),
          updated_at=NOW()
        WHERE vps_id=$1
          AND port_no=$2
      `, [
        node.id,
        portNo,
        status === 'connected' ? 'running' : 'failed',
        pid,
        mt5Login || null,
        msg
      ]).catch(() => {});

      if (commandId) {
        await query(`
          UPDATE vps_system.vps_port_locks
          SET
            status=$4,
            updated_at=NOW()
          WHERE vps_id=$1
            AND port_no=$2
            AND command_id=$3
        `, [
          node.id,
          portNo,
          commandId,
          status === 'connected' ? 'connected' : 'failed'
        ]).catch(() => {});
      }
    }

    if (accountId) {
      await query(`
        UPDATE vps_system.mt5_accounts
        SET
          status=$2,
          last_error=CASE WHEN $2='failed' THEN $3 ELSE '' END,
          last_login_message=$3,
          connected_at=CASE WHEN $2='connected' THEN NOW() ELSE connected_at END,
          updated_at=NOW()
        WHERE id=$1
      `, [
        accountId,
        status,
        msg
      ]).catch(() => {});
    } else if (portNo && mt5Login) {
      await query(`
        UPDATE vps_system.mt5_accounts
        SET
          status=$4,
          last_error=CASE WHEN $4='failed' THEN $5 ELSE '' END,
          last_login_message=$5,
          connected_at=CASE WHEN $4='connected' THEN NOW() ELSE connected_at END,
          updated_at=NOW()
        WHERE vps_id=$1
          AND port_slot=$2
          AND mt5_login=$3
          AND status IN ('connecting','checking')
      `, [
        node.id,
        portNo,
        mt5Login,
        status,
        msg
      ]).catch(() => {});
    }

    return res.json({
      ok: true,
      status
    });

  } catch (err) {
    console.error('[PRO COMMAND RESULT ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

module.exports = router;
