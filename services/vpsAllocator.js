const { query, getClient } = require('../config/database');

function n(value, fallback = 0) {
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function text(value, fallback = '') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function presetLot(customPreset, manualLot, bot) {
  if (n(manualLot) > 0) return n(manualLot);
  if (customPreset && n(customPreset.lot_size) > 0) return n(customPreset.lot_size);
  return n(bot.default_lot, 0.01);
}

function tradeSettingFromPreset(preset, tradeLevel = 'safe') {
  if (!preset) return {};
  const level = text(tradeLevel, 'safe');
  if (level === 'fast') {
    return { trade_level: level, t_start: n(preset.fast_t_start), t_stop: n(preset.fast_t_stop) };
  }
  if (level === 'medium') {
    return { trade_level: level, t_start: n(preset.medium_t_start), t_stop: n(preset.medium_t_stop) };
  }
  return { trade_level: 'safe', t_start: n(preset.t_start), t_stop: n(preset.t_stop) };
}

async function getPackageLimits(userId) {
  const res = await query(`
    SELECT p.*, us.end_at, us.status AS subscription_status
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id = $1
      AND COALESCE(us.status,'active') = 'active'
      AND (us.end_at IS NULL OR us.end_at > NOW())
    ORDER BY us.end_at DESC NULLS LAST, us.id DESC
    LIMIT 1
  `, [userId]).catch(() => ({ rows: [] }));

  const pkg = res.rows[0] || {};
  const name = String(pkg.name || pkg.name_th || pkg.name_en || '').toLowerCase();

  let maxBots = n(pkg.max_bots || pkg.bot_limit || 0);
  let basePorts = n(pkg.ports_max || pkg.max_ports || pkg.port_limit || 0);
  let maxLot = n(pkg.lot_max || pkg.max_lot || 0);

  if (!basePorts) {
    if (name.includes('pro')) basePorts = 2;
    else if (name.includes('premium') || name.includes('vip') || name.includes('enterprise')) basePorts = 5;
    else basePorts = 1;
  }

  const extraRes = await query(`SELECT COALESCE(SUM(qty),0)::int AS qty FROM vps_system.mt5_extra_ports WHERE user_id=$1`, [userId])
    .catch(() => ({ rows: [{ qty: 0 }] }));
  const extraPorts = n(extraRes.rows[0]?.qty || 0);
  const maxPorts = basePorts + extraPorts;

  if (!maxBots) maxBots = maxPorts;
  else maxBots += extraPorts;
  if (!maxLot) maxLot = maxPorts >= 5 ? 50 : maxPorts >= 2 ? 20 : 5;

  return { package: pkg, maxBots, maxPorts, basePorts, extraPorts, maxLot };
}

async function chooseNode(requiredPorts, requiredLot) {
  const result = await query(`
    SELECT *,
      (max_ports - used_ports) AS free_ports,
      (max_lot - used_lot) AS free_lot
    FROM vps_system.vps_nodes
    WHERE is_active = TRUE
      AND status IN ('online','available','busy')
      AND (max_ports - used_ports) >= $1
      AND (max_lot - used_lot) >= $2
      AND COALESCE(cpu_percent,0) <= COALESCE(max_cpu_percent,80)
      AND COALESCE(ram_percent,0) <= COALESCE(max_ram_percent,80)
      AND COALESCE(ping_ms,0) <= COALESCE(max_ping_ms,150)
    ORDER BY used_ports ASC, COALESCE(ping_ms,0) ASC, COALESCE(cpu_percent,0) ASC, id ASC
    LIMIT 1
  `, [requiredPorts, requiredLot]);

  return result.rows[0] || null;
}

async function findFreePortNo(client, nodeId, maxPorts) {
  await client.query(`
    ALTER TABLE vps_system.bot_instances
    ADD COLUMN IF NOT EXISTS assigned_port_no INTEGER
  `).catch(() => {});

  const usedRes = await client.query(`
    SELECT COALESCE(assigned_port_no, port_used) AS assigned_port_no
    FROM vps_system.bot_instances
    WHERE vps_id=$1
      AND status IN ('running','pending')
      AND COALESCE(assigned_port_no, port_used) IS NOT NULL
    ORDER BY COALESCE(assigned_port_no, port_used) ASC
  `, [nodeId]);

  const used = new Set(usedRes.rows.map((r) => n(r.assigned_port_no)));

  for (let i = 1; i <= n(maxPorts); i += 1) {
    if (!used.has(i)) return i;
  }

  return null;
}

async function allocateAndRun({ userId, mt5AccountId, botId, presetId = null, customPreset = null, capitalUsed = null, manualLot = 0, tradeLevel = 'safe', expireAt = null }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const limits = await getPackageLimits(userId);
    const running = await client.query(`
      SELECT COALESCE(SUM(port_used),0) AS ports, COALESCE(SUM(lot_used),0) AS lot, COUNT(*) AS bots
      FROM vps_system.bot_instances
      WHERE user_id = $1 AND status IN ('running','pending')
    `, [userId]);

    const usage = running.rows[0] || {};
    const botRes = await client.query(`SELECT * FROM vps_system.bot_catalog WHERE id=$1 AND is_active=TRUE`, [botId]);
    const bot = botRes.rows[0];
    if (!bot) throw new Error('ไม่พบบอทที่เลือก');

    let preset = customPreset || null;
    if (!preset && presetId) {
      const presetRes = await client.query(`SELECT * FROM vps_system.lot_presets WHERE id=$1`, [presetId]);
      preset = presetRes.rows[0] || null;
    }

    const requiredPorts = Math.max(1, n(bot.required_ports || 1, 1));
    const requiredLot = presetLot(preset, manualLot, bot);

    if (n(usage.bots) + 1 > limits.maxBots) throw new Error(`แพ็กเกจนี้รันบอทได้สูงสุด ${limits.maxBots} ตัว`);
    if (n(usage.ports) + requiredPorts > limits.maxPorts) throw new Error(`แพ็กเกจนี้ใช้ PORT ได้สูงสุด ${limits.maxPorts}`);
    if (n(usage.lot) + requiredLot > limits.maxLot) throw new Error(`แพ็กเกจนี้ใช้ Lot ได้สูงสุด ${limits.maxLot}`);

    const nodeRes = await client.query(`
      SELECT *,
        (max_ports - used_ports) AS free_ports,
        (max_lot - used_lot) AS free_lot
      FROM vps_system.vps_nodes
      WHERE is_active = TRUE
        AND status IN ('online','available','busy')
        AND (max_ports - used_ports) >= $1
        AND (max_lot - used_lot) >= $2
        AND COALESCE(cpu_percent,0) <= COALESCE(max_cpu_percent,80)
        AND COALESCE(ram_percent,0) <= COALESCE(max_ram_percent,80)
        AND COALESCE(ping_ms,0) <= COALESCE(max_ping_ms,150)
      ORDER BY used_ports ASC, COALESCE(ping_ms,0) ASC, COALESCE(cpu_percent,0) ASC, id ASC
      LIMIT 1
      FOR UPDATE
    `, [requiredPorts, requiredLot]);

    const node = nodeRes.rows[0];
    if (!node) throw new Error('ไม่มี Windows VPS ที่ออนไลน์และว่างตามเงื่อนไข CPU/RAM/PING/PORT');

    const assignedPortNo = await findFreePortNo(client, node.id, node.max_ports);
    if (!assignedPortNo) throw new Error('PORT ใน Windows VPS นี้เต็มแล้ว');

    const accountRes = await client.query(`SELECT * FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2`, [mt5AccountId, userId]);
    const account = accountRes.rows[0];
    if (!account) throw new Error('ไม่พบบัญชี MT5');

    const tradeSetting = tradeSettingFromPreset(preset, tradeLevel);
    const payload = {
      action: 'RUN_MT5_BOT',
      userId,
      mt5Login: account.mt5_login,
      mt5Password: account.mt5_password,
      broker: account.broker || 'MH Markets',
      serverName: account.server_name || 'MohicansMarkets-Live',
      botCode: bot.bot_code,
      botName: bot.bot_name,
      symbol: bot.symbol || 'XAUUSD',
      lot: requiredLot,
      port: assignedPortNo,
      portSlot: account.port_slot || 1,
      capital: n(capitalUsed || account.last_equity || account.last_balance || account.capital_override),
      tradeLevel: tradeSetting.trade_level || tradeLevel,
      tStart: tradeSetting.t_start,
      tStop: tradeSetting.t_stop,
      preset
    };

    const ins = await client.query(`
      INSERT INTO vps_system.bot_instances
      (user_id, mt5_account_id, bot_id, vps_id, status, lot_used, port_used, assigned_port_no, preset_id, run_payload, expire_at, started_at, trade_level, capital_used, updated_at)
      VALUES ($1,$2,$3,$4,'running',$5,$6,$7,$8,$9::jsonb,$10,NOW(),$11,$12,NOW())
      RETURNING *
    `, [userId, mt5AccountId, botId, node.id, requiredLot, requiredPorts, assignedPortNo, presetId || null, JSON.stringify(payload), expireAt, tradeSetting.trade_level || tradeLevel, payload.capital]);

    await client.query(`
      UPDATE vps_system.vps_nodes
      SET used_ports = used_ports + $1,
          used_lot = used_lot + $2,
          status = CASE WHEN used_ports + $1 >= max_ports OR used_lot + $2 >= max_lot THEN 'busy' ELSE 'online' END,
          updated_at = NOW()
      WHERE id = $3
    `, [requiredPorts, requiredLot, node.id]);

    await client.query('COMMIT');
    return { instance: ins.rows[0], node, payload, assignedPortNo };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function stopInstance(instanceId, userId = null) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const params = userId ? [instanceId, userId] : [instanceId];
    const where = userId ? 'id=$1 AND user_id=$2' : 'id=$1';
    const instRes = await client.query(`SELECT * FROM vps_system.bot_instances WHERE ${where} FOR UPDATE`, params);
    const inst = instRes.rows[0];
    if (!inst) throw new Error('ไม่พบรายการบอท');

    if (['stopped','expired','failed'].includes(inst.status)) {
      await client.query('COMMIT');
      return inst;
    }

    await client.query(`
      UPDATE vps_system.bot_instances
      SET status='stopped', stopped_at=NOW(), updated_at=NOW()
      WHERE id=$1
      RETURNING *
    `, [inst.id]);

    if (inst.vps_id) {
      await client.query(`
        UPDATE vps_system.vps_nodes
        SET used_ports = GREATEST(0, used_ports - $1),
            used_lot = GREATEST(0, used_lot - $2),
            status = CASE WHEN status='busy' THEN 'online' ELSE status END,
            updated_at=NOW()
        WHERE id=$3
      `, [n(inst.port_used, 1), n(inst.lot_used), inst.vps_id]);
    }

    await client.query('COMMIT');
    return inst;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markExpiredAndStop() {
  const res = await query(`
    SELECT id FROM vps_system.bot_instances
    WHERE status='running' AND expire_at IS NOT NULL AND expire_at <= NOW()
    LIMIT 200
  `);
  for (const row of res.rows) {
    await stopInstance(row.id);
    await query(`UPDATE vps_system.bot_instances SET status='expired', updated_at=NOW() WHERE id=$1`, [row.id]);
  }
  return res.rows.length;
}

async function markOfflineNodes() {
  const res = await query(`
    UPDATE vps_system.vps_nodes
    SET status='offline', last_error='Heartbeat timeout > 2 minutes', updated_at=NOW()
    WHERE is_active=TRUE
      AND last_heartbeat IS NOT NULL
      AND last_heartbeat < NOW() - INTERVAL '2 minutes'
      AND status <> 'offline'
    RETURNING *
  `).catch(() => ({ rows: [] }));
  return res.rows;
}

module.exports = {
  getPackageLimits,
  chooseNode,
  allocateAndRun,
  stopInstance,
  markExpiredAndStop,
  markOfflineNodes
};
