const express = require('express');
const { requireLogin } = require('../middleware/requireAuth');
const { query, getClient } = require('../config/database');

const router = express.Router();
const DEFAULT_SERVER = process.env.MT5_DEFAULT_SERVER || 'MohicansMarkets-Live';
const RESERVE_SECONDS = Number(process.env.MT5_RESERVE_SECONDS || 120);

function userIdOf(req) {
  return Number(req.user?.id || req.session?.user?.id || req.session?.userId || 0);
}
function clean(v) { return String(v || '').trim(); }

async function ensureCore() {
  await query(`CREATE SCHEMA IF NOT EXISTS vps_system`);
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS server_name TEXT`).catch(()=>{});
  await query(`ALTER TABLE vps_system.vps_ports ADD COLUMN IF NOT EXISTS assigned_port_no INT`).catch(()=>{});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS assigned_port_no INT`).catch(()=>{});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS last_login_message TEXT DEFAULT ''`).catch(()=>{});
}

router.post('/mt5/connect', requireLogin, async (req, res) => {
  await ensureCore().catch(()=>{});
  const userId = userIdOf(req);
  const mt5Login = clean(req.body.mt5_login || req.body.login || req.body.mt5Login);
  const mt5Password = clean(req.body.mt5_password || req.body.password || req.body.mt5Password);
  const serverName = clean(req.body.server_name || req.body.serverName || DEFAULT_SERVER);

  if (!userId) return res.status(401).json({ ok:false, status:'error', message:'กรุณาเข้าสู่ระบบก่อน' });
  if (!mt5Login || !mt5Password) return res.json({ ok:false, status:'error', message:'กรุณากรอก MT5 Login และ Password' });

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // กัน login ซ้ำทุก VPS/Port แบบจริงใน DB
    const usedLogin = await client.query(`
      SELECT id, vps_id, port_slot, status
      FROM vps_system.mt5_accounts
      WHERE mt5_login=$1 AND server_name=$2 AND status IN ('connecting','connected')
      FOR UPDATE
      LIMIT 1
    `, [mt5Login, serverName]);
    if (usedLogin.rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ ok:false, status:'busy', message:`บัญชี MT5 ${mt5Login} มีผู้ใช้งานอยู่ในระบบแล้ว` });
    }

    // เคลียร์ port reserved ค้างเก่า
    await client.query(`
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
      WHERE status IN ('reserved','starting') AND locked_until < NOW()
    `);

    // เลือก VPS/PORT ว่างแบบ SELECT FOR UPDATE SKIP LOCKED ป้องกันกดพร้อมกันแล้วชนกัน
    const pick = await client.query(`
      SELECT p.id AS port_id, p.port_no, p.folder_path, n.id AS vps_id, n.name, n.node_code
      FROM vps_system.vps_ports p
      JOIN vps_system.vps_nodes n ON n.id=p.vps_id
      WHERE COALESCE(n.agent_enabled,true)=true
        AND p.disabled_at IS NULL
        AND COALESCE(n.status,'offline') <> 'disabled'
        AND p.status IN ('available','stopped','failed')
        AND NOT EXISTS (
          SELECT 1 FROM vps_system.mt5_accounts a
          WHERE a.port_id=p.id AND a.status IN ('connecting','connected')
        )
      ORDER BY
        CASE WHEN n.status='online' THEN 0 ELSE 1 END,
        COALESCE(n.cpu_percent,0),
        COALESCE(n.ram_percent,0),
        p.port_no
      FOR UPDATE OF p SKIP LOCKED
      LIMIT 1
    `);

    if (!pick.rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ ok:false, status:'full', message:'ไม่มี PORT ว่าง หรือ VPS ยังไม่ออนไลน์' });
    }

    const p = pick.rows[0];
    const lockedUntil = new Date(Date.now() + RESERVE_SECONDS * 1000);

    await client.query(`
      UPDATE vps_system.vps_ports
      SET status='reserved', locked_by_user_id=$1, locked_until=$2, mt5_login=$3, server_name=$4, last_error='', updated_at=NOW()
      WHERE id=$5
    `, [userId, lockedUntil, mt5Login, serverName, p.port_id]);

const acc = await client.query(`
  INSERT INTO vps_system.mt5_accounts
  (
    user_id,
    vps_id,
    port_id,
    port_slot,
    assigned_port_no,
    mt5_login,
    mt5_password,
    server_name,
    account_name,
    status,
    last_error,
    updated_at
  )
  VALUES
  (
    $1,$2,$3,$4,$4,$5,$6,$7,$8,
    'connecting',
    '',
    NOW()
  )

  ON CONFLICT (user_id, mt5_login, server_name)

  DO UPDATE SET
    mt5_password      = EXCLUDED.mt5_password,
    vps_id            = EXCLUDED.vps_id,
    port_id           = EXCLUDED.port_id,
    port_slot         = EXCLUDED.port_slot,
    assigned_port_no  = EXCLUDED.assigned_port_no,
    account_name      = EXCLUDED.account_name,
    status            = 'connecting',
    last_error        = '',
    updated_at        = NOW()

  RETURNING id
`, [userId, p.vps_id, p.port_id, p.port_no, mt5Login, mt5Password, serverName, `PORT ${p.port_no}`]);

    const cmd = await client.query(`
      INSERT INTO vps_system.vps_agent_commands (vps_id, port_id, command_type, payload, status)
      VALUES ($1,$2,'login_mt5',$3::jsonb,'pending')
      RETURNING id
    `, [p.vps_id, p.port_id, JSON.stringify({
      action: 'login_mt5',
      command: 'login_mt5',
      account_id: acc.rows[0].id,
      user_id: userId,
      userId,
      vps_id: p.vps_id,
      nodeId: p.vps_id,
      port_id: p.port_id,
      port: p.port_no,
      port_no: p.port_no,
      portNumber: p.port_no,
      portSlot: p.port_no,
      folder_path: p.folder_path,
      vpsFolderPath: p.folder_path,
      mt5_login: mt5Login,
      mt5Login,
      mt5_password: mt5Password,
      mt5Password,
      server_name: serverName,
      serverName
    })]);

    await client.query(`
      INSERT INTO vps_system.vps_port_locks (vps_id, port_no, port_id, user_id, mt5_login, server_name, status, command_id)
      VALUES ($1,$2,$3,$4,$5,$6,'locking',$7)
    `, [p.vps_id, p.port_no, p.port_id, userId, mt5Login, serverName, cmd.rows[0].id]);

    await client.query('COMMIT');
    return res.json({
      ok:true,
      status:'queued',
      connected:false,
      commandId: cmd.rows[0].id,
      accountId: acc.rows[0].id,
      vpsId: p.vps_id,
      portNo: p.port_no,
      portSlot: p.port_no,
      message:`ส่งคำสั่งไป VPS แล้ว: PORT ${p.port_no} กำลัง Login MT5 จริง`
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[PRO MT5 CONNECT ERROR]', e);
    return res.status(500).json({ ok:false, status:'error', message:e.message || 'connect error' });
  } finally {
    client.release();
  }
});

router.get('/mt5/connect-status', requireLogin, async (req, res) => {
  const userId = userIdOf(req);
  const r = await query(`
    SELECT a.id, a.status, a.mt5_login, a.server_name, a.port_slot, a.assigned_port_no,
           a.last_error, a.last_login_message, a.updated_at, n.name AS vps_name
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_nodes n ON n.id=a.vps_id
    WHERE a.user_id=$1
    ORDER BY a.updated_at DESC, a.id DESC
    LIMIT 1
  `, [userId]).catch(()=>({ rows: [] }));
  const row = r.rows[0];
  if (!row) return res.json({ ok:true, connected:false, status:'none', message:'ยังไม่มีรายการเชื่อมต่อ' });
  return res.json({
    ok:true,
    connected: row.status === 'connected',
    status: row.status,
    portSlot: row.port_slot || row.assigned_port_no,
    mt5Login: row.mt5_login,
    serverName: row.server_name,
    message: row.status === 'connected'
      ? `เชื่อมต่อ MT5 สำเร็จ PORT ${row.port_slot || row.assigned_port_no}`
      : (row.last_error || row.last_login_message || `สถานะ ${row.status}`),
    row
  });
});

module.exports = router;
