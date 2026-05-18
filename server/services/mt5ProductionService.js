'use strict';

const crypto = require('crypto');

function makeMt5ProductionService(db, realtime) {
  const query = (...args) => db.query(...args);

  async function findAvailableVpsPort(client, { userId, mt5Login }) {
    // AI VPS scoring: CPU/RAM/PING ต่ำกว่าได้คะแนนดีกว่า และ port ต้อง free จริง
    const { rows } = await client.query(`
      SELECT
        n.id AS vps_id,
        n.node_code,
        n.display_name,
        n.cpu_percent,
        n.ram_percent,
        n.ping_ms,
        p.port_no,
        p.folder_path,
        (
          COALESCE(n.cpu_percent, 0) * 1.2 +
          COALESCE(n.ram_percent, 0) * 1.0 +
          COALESCE(n.ping_ms, 50) * 0.25 +
          p.port_no * 0.01
        ) AS score
      FROM vps_system.vps_nodes n
      JOIN vps_system.vps_ports p ON p.vps_id = n.id
      WHERE n.enabled = TRUE
        AND p.enabled = TRUE
        AND COALESCE(n.status, 'offline') <> 'disabled'
        AND COALESCE(p.status, 'free') IN ('free','failed','stopped')
        AND NOT EXISTS (
          SELECT 1 FROM vps_system.mt5_port_locks l
          WHERE l.vps_id = p.vps_id
            AND l.port_no = p.port_no
            AND l.status = 'locking'
            AND l.expires_at > NOW()
        )
        AND NOT EXISTS (
          SELECT 1 FROM vps_system.mt5_accounts a
          WHERE a.mt5_login = $2
            AND a.status IN ('pending','starting','connected','migrating')
        )
      ORDER BY score ASC, n.id ASC, p.port_no ASC
      LIMIT 1
      FOR UPDATE OF p SKIP LOCKED
    `, [userId, String(mt5Login)]);
    return rows[0] || null;
  }

  async function queueCommand(client, { vpsId, commandType, payload, priority = 100 }) {
    const { rows } = await client.query(`
      INSERT INTO vps_system.vps_agent_commands(vps_id, command_type, payload, priority)
      VALUES ($1,$2,$3::jsonb,$4)
      RETURNING id
    `, [vpsId, commandType, JSON.stringify(payload), priority]);
    return rows[0].id;
  }

  async function connectMt5({ userId, mt5Login, mt5Password, mt5Server }) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const active = await client.query(`
        SELECT id, status, vps_id, port_no
        FROM vps_system.mt5_accounts
        WHERE (user_id=$1 OR mt5_login=$2)
          AND status IN ('pending','starting','connected','migrating')
        LIMIT 1
        FOR UPDATE
      `, [userId, String(mt5Login)]);
      if (active.rowCount) {
        throw new Error('บัญชี MT5 นี้มีผู้ใช้งานอยู่ในระบบ หรือผู้ใช้นี้มี PORT ที่กำลังเชื่อมต่ออยู่');
      }

      const port = await findAvailableVpsPort(client, { userId, mt5Login });
      if (!port) throw new Error('ไม่มี VPS/PORT ว่าง หรือบัญชีนี้ถูกใช้งานอยู่');

      const lockKey = crypto.randomUUID();
      await client.query(`
        INSERT INTO vps_system.mt5_port_locks(vps_id, port_no, user_id, mt5_login, lock_key, status, expires_at)
        VALUES ($1,$2,$3,$4,$5,'locking',NOW()+INTERVAL '90 seconds')
      `, [port.vps_id, port.port_no, userId, String(mt5Login), lockKey]);

      await client.query(`
        UPDATE vps_system.vps_ports
        SET status='reserved', current_user_id=$3, current_mt5_login=$4, current_server=$5, last_error=NULL
        WHERE vps_id=$1 AND port_no=$2
      `, [port.vps_id, port.port_no, userId, String(mt5Login), mt5Server]);

      const account = await client.query(`
        INSERT INTO vps_system.mt5_accounts(user_id, vps_id, port_no, mt5_login, mt5_server, status, last_message)
        VALUES ($1,$2,$3,$4,$5,'pending','queued')
        RETURNING id
      `, [userId, port.vps_id, port.port_no, String(mt5Login), mt5Server]);

      const payload = {
        accountId: account.rows[0].id,
        userId,
        vpsId: port.vps_id,
        nodeCode: port.node_code,
        portNo: port.port_no,
        vpsFolderPath: port.folder_path,
        mt5Login: String(mt5Login),
        mt5Password: String(mt5Password),
        serverName: String(mt5Server),
        lockKey,
      };
      const commandId = await queueCommand(client, {
        vpsId: port.vps_id,
        commandType: 'login_mt5',
        payload,
        priority: 10,
      });

      await client.query(`
        INSERT INTO vps_system.mt5_connect_events(user_id,vps_id,port_no,mt5_login,mt5_server,event_type,message,payload)
        VALUES ($1,$2,$3,$4,$5,'queued','ส่งคำสั่งเชื่อมต่อไป Agent แล้ว',$6::jsonb)
      `, [userId, port.vps_id, port.port_no, String(mt5Login), mt5Server, JSON.stringify({ commandId })]);

      await client.query('COMMIT');

      realtime.emitUser(userId, 'mt5:connect', {
        status: 'queued',
        message: 'ส่งคำสั่งเชื่อมต่อไป Agent แล้ว',
        portNo: port.port_no,
        vpsId: port.vps_id,
      });

      return {
        ok: true,
        status: 'queued',
        message: 'กำลังเชื่อมต่อ MT5 กรุณารอสถานะจาก Agent',
        commandId,
        portNo: port.port_no,
        vpsId: port.vps_id,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, status: 'failed', message: e.message };
    } finally {
      client.release();
    }
  }

  async function stopMt5({ userId, accountId, vpsId, portNo }) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let acc;
      if (accountId) {
        const r = await client.query(`SELECT * FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 FOR UPDATE`, [accountId, userId]);
        acc = r.rows[0];
      } else {
        const r = await client.query(`SELECT * FROM vps_system.mt5_accounts WHERE user_id=$1 AND status IN ('pending','starting','connected','migrating') ORDER BY id DESC LIMIT 1 FOR UPDATE`, [userId]);
        acc = r.rows[0];
      }
      if (!acc) throw new Error('ไม่พบ MT5 account ที่กำลังใช้งาน');
      const payload = {
        accountId: acc.id,
        userId: acc.user_id,
        vpsId: acc.vps_id,
        portNo: acc.port_no,
        mt5Login: acc.mt5_login,
      };
      const commandId = await queueCommand(client, { vpsId: acc.vps_id, commandType: 'stop_mt5', payload, priority: 5 });
      await client.query(`UPDATE vps_system.mt5_accounts SET status='stopped', disconnected_at=NOW(), last_message='stop queued' WHERE id=$1`, [acc.id]);
      await client.query(`UPDATE vps_system.vps_ports SET status='stopping' WHERE vps_id=$1 AND port_no=$2`, [acc.vps_id, acc.port_no]);
      await client.query('COMMIT');
      return { ok: true, message: 'ส่งคำสั่งปิด MT5 แล้ว', commandId };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, message: e.message };
    } finally {
      client.release();
    }
  }

  async function autoReconnectAndMigrate() {
    // เรียกจาก cron ทุก 10-30 วิได้
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const stale = await client.query(`
        SELECT a.*
        FROM vps_system.mt5_accounts a
        JOIN vps_system.vps_ports p ON p.vps_id=a.vps_id AND p.port_no=a.port_no
        WHERE a.status='connected'
          AND (p.last_health_at IS NULL OR p.last_health_at < NOW() - INTERVAL '20 seconds')
        LIMIT 10
        FOR UPDATE SKIP LOCKED
      `);
      for (const a of stale.rows) {
        await queueCommand(client, {
          vpsId: a.vps_id,
          commandType: 'reconnect_mt5',
          payload: {
            accountId: a.id,
            userId: a.user_id,
            vpsId: a.vps_id,
            portNo: a.port_no,
            mt5Login: a.mt5_login,
            mt5Password: '',
            serverName: a.mt5_server,
            requirePasswordFromVault: true,
          },
          priority: 20,
        });
        await client.query(`UPDATE vps_system.mt5_accounts SET status='starting', last_message='auto reconnect queued' WHERE id=$1`, [a.id]);
      }
      await client.query('COMMIT');
      return { ok: true, queued: stale.rowCount };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, message: e.message };
    } finally {
      client.release();
    }
  }

  return { connectMt5, stopMt5, queueCommand, autoReconnectAndMigrate };
}

module.exports = { makeMt5ProductionService };
