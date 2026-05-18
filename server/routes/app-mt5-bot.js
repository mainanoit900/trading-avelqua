'use strict';

const express = require('express');
const { makeMt5ProductionService } = require('../services/mt5ProductionService');

/**
 * ใช้งาน:
 * const mt5Routes = require('./server/routes/app-mt5-bot')({ db, realtime });
 * app.use('/', mt5Routes);
 */
module.exports = function buildMt5Routes({ db, realtime }) {
  const router = express.Router();
  const service = makeMt5ProductionService(db, realtime);

  function requireLogin(req, res, next) {
    if (!req.session || !req.session.user || !req.session.user.id) {
      return res.status(401).json({ ok: false, message: 'กรุณาเข้าสู่ระบบ' });
    }
    next();
  }

  router.post('/app/mt5/connect', requireLogin, async (req, res) => {
    const userId = req.session.user.id;
    const mt5Login = String(req.body.mt5_login || req.body.mt5Login || '').trim();
    const mt5Password = String(req.body.mt5_password || req.body.mt5Password || '').trim();
    const mt5Server = String(req.body.mt5_server || req.body.serverName || req.body.mt5Server || '').trim();

    if (!mt5Login || !mt5Password || !mt5Server) {
      return res.status(400).json({ ok: false, status: 'failed', message: 'กรุณากรอก Login / Password / Server ให้ครบ' });
    }

    const result = await service.connectMt5({ userId, mt5Login, mt5Password, mt5Server });
    return res.status(result.ok ? 200 : 409).json(result);
  });

  router.post('/app/mt5/stop', requireLogin, async (req, res) => {
    const userId = req.session.user.id;
    const result = await service.stopMt5({
      userId,
      accountId: req.body.accountId || req.body.account_id,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  });

  // Agent heartbeat: update status แบบ zero delay
  router.post('/api/vps-agent/heartbeat', async (req, res) => {
    const token = req.get('x-agent-token');
    const nodeCode = req.body.nodeCode || req.get('x-node-code');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const n = await client.query(`SELECT * FROM vps_system.vps_nodes WHERE node_code=$1 AND agent_token=$2 FOR UPDATE`, [nodeCode, token]);
      if (!n.rowCount) throw new Error('invalid agent token/node');
      const vps = n.rows[0];
      await client.query(`
        UPDATE vps_system.vps_nodes
        SET status='online', agent_version=$2, last_seen_at=NOW(), cpu_percent=$3, ram_percent=$4
        WHERE id=$1
      `, [vps.id, req.body.version, req.body.cpuPercent, req.body.ramPercent]);

      const ports = Array.isArray(req.body.ports) ? req.body.ports : [];
      for (const p of ports) {
        const portNo = Number(p.portNo || p.port_no || 0);
        if (!portNo) continue;
        await client.query(`
          INSERT INTO vps_system.mt5_port_health(vps_id,port_no,running,pid,mt5_login,folder_path,cpu_percent,ram_mb,terminal_age_sec,log_status,raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        `, [vps.id, portNo, !!p.running, p.pid || null, p.mt5Login || null, p.folderPath || null, p.cpuPercent || null, p.ramMb || null, p.terminalAgeSec || null, p.logStatus || null, JSON.stringify(p)]);

        await client.query(`
          UPDATE vps_system.vps_ports
          SET status = CASE
              WHEN enabled = FALSE THEN 'disabled'
              WHEN $3::boolean = TRUE THEN COALESCE(NULLIF(status,'reserved'),'connected')
              ELSE CASE WHEN status IN ('reserved','starting') THEN status ELSE 'free' END
            END,
            process_pid=$4,
            current_mt5_login=COALESCE($5,current_mt5_login),
            last_health_at=NOW()
          WHERE vps_id=$1 AND port_no=$2
        `, [vps.id, portNo, !!p.running, p.pid || null, p.mt5Login || null]);

        realtime.emitPort(vps.id, portNo, 'mt5:port-health', {
          vpsId: vps.id,
          portNo,
          running: !!p.running,
          status: !!p.running ? 'connected' : 'free',
          pid: p.pid || null,
          mt5Login: p.mt5Login || null,
        });
      }
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(401).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // Agent ดึง command ถัดไป
  router.post('/api/vps-agent/queue/next', async (req, res) => {
    const token = req.get('x-agent-token');
    const nodeCode = req.body.nodeCode || req.get('x-node-code');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const n = await client.query(`SELECT * FROM vps_system.vps_nodes WHERE node_code=$1 AND agent_token=$2`, [nodeCode, token]);
      if (!n.rowCount) throw new Error('invalid agent token/node');
      const vps = n.rows[0];
      const cmd = await client.query(`
        SELECT id, command_type AS "commandType", payload
        FROM vps_system.vps_agent_commands
        WHERE vps_id=$1
          AND status='pending'
          AND run_after <= NOW()
        ORDER BY priority ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `, [vps.id]);
      if (!cmd.rowCount) {
        await client.query('COMMIT');
        return res.json({ ok: true, command: null });
      }
      const row = cmd.rows[0];
      await client.query(`
        UPDATE vps_system.vps_agent_commands
        SET status='running', attempts=attempts+1, locked_at=NOW(), locked_by=$2
        WHERE id=$1
      `, [row.id, nodeCode]);
      await client.query('COMMIT');
      return res.json({ ok: true, command: row });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(401).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });

  router.post('/api/vps-agent/queue/finish', async (req, res) => {
    const token = req.get('x-agent-token');
    const nodeCode = req.body.nodeCode || req.get('x-node-code');
    const commandId = Number(req.body.commandId);
    const ok = !!req.body.ok;
    const result = req.body.result || {};
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const n = await client.query(`SELECT * FROM vps_system.vps_nodes WHERE node_code=$1 AND agent_token=$2`, [nodeCode, token]);
      if (!n.rowCount) throw new Error('invalid agent token/node');
      await client.query(`
        UPDATE vps_system.vps_agent_commands
        SET status=$2, result=$3::jsonb, error_message=$4
        WHERE id=$1
      `, [commandId, ok ? 'done' : 'failed', JSON.stringify(result), ok ? null : (result.message || 'failed')]);
      await client.query('COMMIT');
      return res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // Agent ส่งผล login จริง
  router.post('/api/vps-agent/connect-result', async (req, res) => {
    const token = req.get('x-agent-token');
    const nodeCode = req.body.nodeCode || req.get('x-node-code');
    const status = String(req.body.status || '').trim();
    const message = String(req.body.message || '').trim();
    const payload = req.body.payload || {};
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const n = await client.query(`SELECT * FROM vps_system.vps_nodes WHERE node_code=$1 AND agent_token=$2`, [nodeCode, token]);
      if (!n.rowCount) throw new Error('invalid agent token/node');
      const vps = n.rows[0];
      const userId = payload.userId || null;
      const portNo = Number(payload.portNo || payload.port_no || 0);
      const mt5Login = String(payload.mt5Login || payload.login || '');
      const accountId = payload.accountId || null;

      if (status === 'starting') {
        await client.query(`UPDATE vps_system.vps_ports SET status='starting', last_error=NULL WHERE vps_id=$1 AND port_no=$2`, [vps.id, portNo]);
        if (accountId) await client.query(`UPDATE vps_system.mt5_accounts SET status='starting', last_message=$2 WHERE id=$1`, [accountId, message]);
      }

      if (status === 'connected') {
        await client.query(`
          UPDATE vps_system.vps_ports
          SET status='connected', process_pid=$3, last_error=NULL, last_connected_at=NOW(), last_health_at=NOW()
          WHERE vps_id=$1 AND port_no=$2
        `, [vps.id, portNo, payload.pid || null]);
        await client.query(`
          UPDATE vps_system.mt5_accounts
          SET status='connected', process_pid=$2, connected_at=NOW(), last_message=$3, last_login_message=$3
          WHERE id=$1
        `, [accountId, payload.pid || null, message]);
        await client.query(`UPDATE vps_system.mt5_port_locks SET status='released' WHERE lock_key=$1`, [payload.lockKey]);
      }

      if (status === 'failed') {
        await client.query(`
          UPDATE vps_system.vps_ports
          SET status='free', current_user_id=NULL, current_mt5_login=NULL, current_server=NULL, process_pid=NULL, last_error=$3
          WHERE vps_id=$1 AND port_no=$2
        `, [vps.id, portNo, message]);
        if (accountId) await client.query(`UPDATE vps_system.mt5_accounts SET status='failed', last_message=$2, last_login_message=$2, disconnected_at=NOW() WHERE id=$1`, [accountId, message]);
        await client.query(`UPDATE vps_system.mt5_port_locks SET status='released' WHERE lock_key=$1`, [payload.lockKey]);
      }

      if (status === 'stopped') {
        await client.query(`
          UPDATE vps_system.vps_ports
          SET status='free', current_user_id=NULL, current_mt5_login=NULL, current_server=NULL, process_pid=NULL
          WHERE vps_id=$1 AND port_no=$2
        `, [vps.id, portNo]);
        if (accountId) await client.query(`UPDATE vps_system.mt5_accounts SET status='stopped', last_message=$2, disconnected_at=NOW() WHERE id=$1`, [accountId, message]);
        await client.query(`UPDATE vps_system.mt5_port_locks SET status='released' WHERE vps_id=$1 AND port_no=$2 AND status='locking'`, [vps.id, portNo]);
      }

      await client.query(`
        INSERT INTO vps_system.mt5_connect_events(user_id,vps_id,port_no,mt5_login,mt5_server,event_type,message,payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      `, [userId, vps.id, portNo, mt5Login, payload.serverName || null, status, message, JSON.stringify(payload)]);

      await client.query('COMMIT');

      if (userId) realtime.emitUser(userId, 'mt5:connect', { status, message, portNo, vpsId: vps.id, mt5Login });
      realtime.emitPort(vps.id, portNo, 'mt5:port-status', { status, message, portNo, vpsId: vps.id, mt5Login });

      return res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: e.message });
    } finally {
      client.release();
    }
  });

  // Admin: manual queue restart EA
  router.post('/admin/vps/:vpsId/ports/:portNo/restart-ea', async (req, res) => {
    const vpsId = Number(req.params.vpsId);
    const portNo = Number(req.params.portNo);
    const payload = { vpsId, portNo };
    const client = await db.connect();
    try {
      const cmd = await service.queueCommand(client, { vpsId, commandType: 'restart_ea', payload, priority: 5 });
      res.json({ ok: true, message: 'ส่งคำสั่ง restart EA แล้ว', commandId: cmd });
    } finally {
      client.release();
    }
  });

  return router;
};
