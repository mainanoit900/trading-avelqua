/* eslint-disable no-console */
'use strict';

const { query } = require('../config/database');

function num(v, def = 0) {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : def;
}

function killPayload(portNo, folderPath, reason, extra = {}) {
  const folder = String(folderPath || '').trim();
  if (!folder) return null;
  return {
    port: portNo,
    portNumber: portNo,
    folder_path: folder,
    vpsFolderPath: folder,
    forceKill: true,
    closeMt5: true,
    reason,
    ...extra
  };
}

const forceStopCooldownUntil = new Map();

function portForceStopKey(nodeId, portNo) {
  return `${num(nodeId)}:${num(portNo)}`;
}

function isForceStopOnCooldown(nodeId, portNo) {
  return Date.now() < (forceStopCooldownUntil.get(portForceStopKey(nodeId, portNo)) || 0);
}

function touchForceStopCooldown(nodeId, portNo, sec = 90) {
  forceStopCooldownUntil.set(
    portForceStopKey(nodeId, portNo),
    Date.now() + Math.max(30, sec) * 1000
  );
}

async function hasRecentOrPendingStop(vpsId, portNo) {
  const vid = num(vpsId);
  const pno = num(portNo);
  if (!vid || !pno) return false;
  const r = await query(
    `
    SELECT 1
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN ('stop_mt5', 'stop_mt5_bot')
      AND (
        status IN ('pending', 'processing')
        OR (status = 'success' AND updated_at > NOW() - INTERVAL '3 minutes')
      )
      AND COALESCE(
        NULLIF(TRIM(payload->>'port'), '')::int,
        NULLIF(TRIM(payload->>'portNumber'), '')::int,
        NULLIF(TRIM(payload->>'assignedPortNo'), '')::int,
        0
      ) = $2
    LIMIT 1
  `,
    [vid, pno]
  ).catch(() => ({ rows: [] }));
  return !!(r.rows && r.rows.length);
}

async function markExpiredUserPortHealthStopped(userId, nodeId = null) {
  const uid = num(userId);
  if (!uid) return;
  const params = [uid];
  let nodeFilter = '';
  if (nodeId) {
    params.push(num(nodeId));
    nodeFilter = `AND h.node_id = $${params.length}`;
  }
  await query(
    `
    UPDATE vps_system.vps_port_health h
    SET running = FALSE, process_id = NULL, updated_at = NOW()
    WHERE h.running = TRUE
      ${nodeFilter}
      AND TRIM(COALESCE(h.mt5_login, '')) <> ''
      AND EXISTS (
        SELECT 1
        FROM vps_system.mt5_accounts a
        WHERE a.user_id = $1
          AND TRIM(COALESCE(a.mt5_login, '')) = TRIM(COALESCE(h.mt5_login, ''))
      )
  `,
    params
  ).catch(() => {});
}

async function ensureExtraPortsUpdatedAtColumn() {
  await query(
    `ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`
  ).catch(() => {});
}

async function userHasActivePackage(userId) {
  const uid = num(userId);
  if (!uid) return false;
  const r = await query(
    `
    SELECT 1
    FROM user_subscriptions s
    WHERE s.user_id = $1
      AND LOWER(TRIM(COALESCE(s.status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
      AND (s.end_at IS NULL OR s.end_at > NOW())
    LIMIT 1
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  return !!(r.rows && r.rows.length);
}

/** ทำ status=expired ทันทีเมื่อ end_at ถึง — ไม่รอ user เปิดหน้าเว็บ */
async function expireDueSubscriptions() {
  const res = await query(
    `
    UPDATE user_subscriptions
    SET status = 'expired',
        updated_at = NOW()
    WHERE end_at IS NOT NULL
      AND end_at <= NOW()
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
  `
  ).catch(() => ({ rowCount: 0 }));
  return res.rowCount || 0;
}

async function findExpiredPackageKillPorts(nodeId, ports) {
  const kills = [];
  const seen = new Set();
  for (const p of ports || []) {
    const running = !!(p.running ?? p.is_running ?? p.isRunning);
    if (!running) continue;
    const portNo = num(p.port_no || p.portNo || p.portNumber || p.port);
    if (!portNo) continue;
    const login = String(p.mt5_login || p.mt5Login || '').trim();
    const folderPath = String(p.folder_path || p.folderPath || '').trim();
    let userId = null;
    if (login) {
      const owner = await query(
        `
        SELECT user_id
        FROM vps_system.mt5_accounts
        WHERE mt5_login = $1
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 1
      `,
        [login]
      ).catch(() => ({ rows: [] }));
      userId = owner.rows?.[0]?.user_id || null;
    }
    if (!userId && nodeId) {
      const locked = await query(
        `
        SELECT locked_by_user_id
        FROM vps_system.vps_ports
        WHERE vps_id = $1 AND port_no = $2
        LIMIT 1
      `,
        [nodeId, portNo]
      ).catch(() => ({ rows: [] }));
      userId = locked.rows?.[0]?.locked_by_user_id || null;
    }
    if (!userId) continue;
    if (await userHasActivePackage(userId)) continue;
    if (await hasRecentOrPendingStop(nodeId, portNo)) continue;
    if (isForceStopOnCooldown(nodeId, portNo)) continue;
    const key = `${portNo}:${folderPath || login || userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    touchForceStopCooldown(nodeId, portNo);
    kills.push({
      port: portNo,
      port_no: portNo,
      portNumber: portNo,
      folder_path: folderPath,
      vpsFolderPath: folderPath,
      mt5_login: login || null,
      userId: num(userId),
      reason: 'package_expired',
      forceKill: true,
      closeMt5: true,
      killMt5: true
    });
  }
  return kills;
}

async function findExpiredKillPortsFromPortHealth(nodeId) {
  const nid = num(nodeId);
  if (!nid) return [];
  const rows = await query(
    `
    SELECT port_number AS port_no, folder_path, mt5_login, running
    FROM vps_system.vps_port_health
    WHERE node_id = $1 AND running = TRUE
  `,
    [nid]
  ).catch(() => ({ rows: [] }));
  return findExpiredPackageKillPorts(nid, rows.rows || []);
}

const nodeSweepAt = new Map();

/** เรียกจาก agent queue/port-health — ส่ง stop ทันทีไม่รอ user login */
async function sweepNodePackageExpiry(nodeId, livePorts) {
  const nid = num(nodeId);
  if (!nid) return [];

  const now = Date.now();
  const last = nodeSweepAt.get(nid) || 0;
  const throttleMs = Math.max(3000, Number(process.env.MT5_EXPIRY_NODE_SWEEP_MS || 5000));
  if (now - last >= throttleMs) {
    nodeSweepAt.set(nid, now);
    await expireDueSubscriptions();
  }

  if (Array.isArray(livePorts) && livePorts.length) {
    return findExpiredPackageKillPorts(nid, livePorts);
  }
  return findExpiredKillPortsFromPortHealth(nid);
}

async function deactivateTemporaryPortsForUser(userId) {
  const uid = num(userId);
  if (!uid) return { deactivated: 0 };
  await ensureExtraPortsUpdatedAtColumn();
  const r = await query(
    `
    UPDATE vps_system.mt5_extra_ports
    SET is_active=FALSE, updated_at=NOW()
    WHERE user_id=$1
      AND port_type='temporary'
      AND is_active=TRUE
    RETURNING id
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  return { deactivated: (r.rows || []).length };
}

/** แพ็กเกจหมดอายุ: ปิด MT5/BOT + ตัดสิทธิ์ PORT ชั่วคราวทั้งหมด (ไม่รอ expires_at ของแต่ละแถว) */
async function applyPackageExpiredSideEffects(userId, reason = 'package_expired_auto_stop') {
  const uid = num(userId);
  if (!uid) return { ok: false };
  const stop = await enqueueStopAllForUser(uid, reason, true).catch(() => null);
  await markExpiredUserPortHealthStopped(uid).catch(() => {});
  const tmp = await deactivateTemporaryPortsForUser(uid);
  return { ok: true, ...stop, deactivatedTemporary: tmp.deactivated };
}

async function expireExtraPorts() {
  await ensureExtraPortsUpdatedAtColumn();
  const r = await query(
    `
    UPDATE vps_system.mt5_extra_ports
    SET is_active=FALSE, updated_at=NOW()
    WHERE is_active=TRUE
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
    RETURNING user_id
  `
  ).catch(() => ({ rows: [] }));
  const userIds = Array.from(new Set((r.rows || []).map((x) => num(x.user_id)).filter(Boolean)));
  return { userIds, deactivated: userIds.length };
}

async function collectKillTargetsForUser(userId) {
  const uid = num(userId);
  if (!uid) return [];

  const targets = new Map();
  const key = (vpsId, portNo) => `${vpsId}:${portNo}`;

  const add = (vpsId, portNo, folderPath, portId, extra) => {
    const v = num(vpsId);
    const p = num(portNo);
    if (!v || !p) return;
    const k = key(v, p);
    if (!targets.has(k)) {
      targets.set(k, {
        vpsId: v,
        portNo: p,
        portId: portId || null,
        folderPath: String(folderPath || '').trim(),
        extra: extra || {}
      });
    } else if (!targets.get(k).folderPath && folderPath) {
      targets.get(k).folderPath = String(folderPath).trim();
    }
  };

  const inst = await query(
    `
    SELECT bi.id, bi.status, bi.vps_id, bi.port_id, bi.assigned_port_no,
           COALESCE(vp.folder_path,'') AS folder_path,
           COALESCE(bi.run_payload->>'botCode', bi.run_payload->>'eaName', '') AS bot_code,
           COALESCE(bi.run_payload->>'mt5Login', '') AS mt5_login,
           COALESCE(bi.run_payload->>'vpsFolderPath', bi.run_payload->>'folder_path', bi.run_payload->>'folderPath', '') AS run_folder
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.vps_ports vp ON vp.id = bi.port_id
    WHERE bi.user_id=$1
      AND bi.vps_id IS NOT NULL
      AND COALESCE(bi.assigned_port_no,0) > 0
      AND bi.status IN ('running','pending','restarting')
    ORDER BY bi.updated_at DESC
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const row of inst.rows || []) {
    const folder = row.folder_path || row.run_folder || '';
    add(row.vps_id, row.assigned_port_no, folder, row.port_id, {
      instanceId: String(row.id),
      botCode: row.bot_code || null,
      mt5Login: row.mt5_login || null,
      forBot: true
    });
  }

  const acc = await query(
    `
    SELECT a.id, a.mt5_login, a.vps_id, a.port_id, a.port_slot, a.assigned_port_no, a.windows_port_no,
           COALESCE(vp.folder_path,'') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports vp ON vp.id = a.port_id
    WHERE a.user_id=$1
      AND a.vps_id IS NOT NULL
      AND LOWER(TRIM(COALESCE(a.status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const a of acc.rows || []) {
    const portNo = num(a.assigned_port_no) || num(a.windows_port_no);
    if (!portNo) continue;
    add(a.vps_id, portNo, a.folder_path, a.port_id, {
      mt5Login: String(a.mt5_login || '').trim() || null,
      accountId: num(a.id) || null
    });
  }

  const locked = await query(
    `
    SELECT vp.vps_id, vp.port_no, vp.id AS port_id, COALESCE(vp.folder_path,'') AS folder_path
    FROM vps_system.vps_ports vp
    WHERE vp.locked_by_user_id=$1
      AND COALESCE(vp.vps_id,0) > 0
      AND COALESCE(vp.port_no,0) > 0
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const p of locked.rows || []) {
    add(p.vps_id, p.port_no, p.folder_path, p.port_id, {});
  }

  const healthRunning = await query(
    `
    SELECT vp.vps_id, vp.port_no, vp.id AS port_id, COALESCE(vp.folder_path, h.folder_path, '') AS folder_path,
           TRIM(COALESCE(h.mt5_login, '')) AS mt5_login
    FROM vps_system.vps_port_health h
    JOIN vps_system.mt5_accounts a ON TRIM(COALESCE(a.mt5_login, '')) = TRIM(COALESCE(h.mt5_login, ''))
    LEFT JOIN vps_system.vps_ports vp ON vp.vps_id = h.node_id AND vp.port_no = h.port_number
    WHERE a.user_id = $1 AND h.running = TRUE
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const p of healthRunning.rows || []) {
    add(p.vps_id || 0, p.port_no, p.folder_path, p.port_id, {
      mt5Login: String(p.mt5_login || '').trim() || null
    });
  }

  return Array.from(targets.values());
}

async function enqueueStopAllForUser(userId, reason = 'package_expired_auto_stop', closeMt5 = true) {
  const uid = num(userId);
  if (!uid) return { ok: false };

  const targets = await collectKillTargetsForUser(uid);
  let botStops = 0;
  let mt5Stops = 0;

  for (const t of targets) {
    const payload = killPayload(t.portNo, t.folderPath, reason, {
      assignedPortNo: t.portNo,
      userId: uid,
      accountId: t.extra.accountId || null,
      botCode: t.extra.botCode || null,
      mt5Login: t.extra.mt5Login || null,
      instanceId: t.extra.instanceId || null,
      expectedMt5Login: t.extra.mt5Login || null
    });
    if (!payload) continue;
    if (await hasRecentOrPendingStop(t.vpsId, t.portNo)) continue;

    if (t.extra.forBot) {
      await query(
        `
        INSERT INTO vps_system.vps_agent_commands
        (vps_id,node_id,port_id,command_type,payload,status,created_at,updated_at)
        VALUES ($1,$1,$2,'stop_mt5_bot',$3::jsonb,'pending',NOW(),NOW())
      `,
        [
          t.vpsId,
          t.portId,
          JSON.stringify({
            ...payload,
            action: 'stop_bot_trading',
            commandType: 'stop_mt5_bot',
            stopTradingOnly: !closeMt5,
            forceKill: !!closeMt5
          })
        ]
      ).catch(() => {});
      botStops += 1;
    }

    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id,node_id,port_id,command_type,payload,status,created_at,updated_at)
      VALUES ($1,$1,$2,'stop_mt5',$3::jsonb,'pending',NOW(),NOW())
    `,
      [t.vpsId, t.portId, JSON.stringify(payload)]
    ).catch(() => {});
    mt5Stops += 1;
  }

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='expired', assigned_port_no=NULL, windows_port_no=NULL, vps_id=NULL, port_id=NULL, updated_at=NOW()
    WHERE user_id=$1
      AND LOWER(TRIM(COALESCE(status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
  `,
    [uid]
  ).catch(() => {});

  await query(
    `
    UPDATE vps_system.bot_instances
    SET status='stopped', stopped_at=COALESCE(stopped_at,NOW()), updated_at=NOW(), last_error=$2, ea_status='stopped'
    WHERE user_id=$1
      AND status IN ('running','pending','restarting')
  `,
    [uid, reason]
  ).catch(() => {});

  await query(
    `
    UPDATE vps_system.vps_ports
    SET status='available', locked_by_user_id=NULL, locked_until=NULL, updated_at=NOW()
    WHERE locked_by_user_id=$1
  `,
    [uid]
  ).catch(() => {});

  return { ok: true, targets: targets.length, botStops, mt5Stops };
}

async function findUsersNeedingPackageExpiryKill() {
  const r = await query(
    `
    WITH candidates AS (
      SELECT DISTINCT user_id FROM vps_system.bot_instances
      WHERE vps_id IS NOT NULL
        AND status IN ('running','pending','restarting','starting','connecting')
      UNION
      SELECT DISTINCT user_id FROM vps_system.mt5_accounts
      WHERE vps_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(status,''))) IN ('ready','connected','checking','connecting','starting','failed')
      UNION
      SELECT DISTINCT locked_by_user_id AS user_id FROM vps_system.vps_ports
      WHERE locked_by_user_id IS NOT NULL
      UNION
      SELECT DISTINCT a.user_id
      FROM vps_system.vps_port_health h
      JOIN vps_system.mt5_accounts a ON TRIM(COALESCE(a.mt5_login, '')) = TRIM(COALESCE(h.mt5_login, ''))
      WHERE h.running = TRUE AND a.user_id IS NOT NULL
    )
    SELECT c.user_id
    FROM candidates c
    WHERE c.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM user_subscriptions us
        WHERE us.user_id = c.user_id
          AND LOWER(TRIM(COALESCE(us.status, ''))) NOT IN ('cancelled', 'deleted', 'expired')
          AND (us.end_at IS NULL OR us.end_at > NOW())
      )
  `
  ).catch(() => ({ rows: [] }));
  return Array.from(new Set((r.rows || []).map((x) => num(x.user_id)).filter(Boolean)));
}

async function findUsersWithEntitlementChangeCandidates() {
  const r = await query(
    `
    SELECT DISTINCT user_id
    FROM vps_system.mt5_extra_ports
    WHERE expires_at IS NOT NULL
      AND expires_at <= NOW()
  `
  ).catch(() => ({ rows: [] }));
  return Array.from(new Set((r.rows || []).map((x) => num(x.user_id)).filter(Boolean)));
}

async function enforceEntitlementForUser(userId) {
  const uid = num(userId);
  if (!uid) return { ok: false };

  const sub = await query(
    `
    SELECT COALESCE(NULLIF(us.ports_max,0), NULLIF(us.ports_min,0), 0) AS max_ports,
           UPPER(COALESCE(to_jsonb(p)->>'group_name', to_jsonb(p)->>'package_group', to_jsonb(p)->>'package_code', to_jsonb(us)->>'package_group_snapshot', '')) AS package_group
    FROM user_subscriptions us
    LEFT JOIN packages p ON p.id = us.package_id
    WHERE us.user_id=$1
      AND COALESCE(us.status,'')='active'
      AND (us.end_at IS NULL OR us.end_at > NOW())
    ORDER BY us.end_at DESC NULLS LAST, us.id DESC
    LIMIT 1
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  const included = num(sub.rows?.[0]?.max_ports);
  const groupUpper = String(sub.rows?.[0]?.package_group || '').toUpperCase().trim();

  const extra = await query(
    `
    SELECT COALESCE(SUM(qty),0) AS extra_ports
    FROM vps_system.mt5_extra_ports
    WHERE user_id=$1
      AND is_active=TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (
        port_type='temporary'
        OR (
          port_type='permanent'
          AND (
            $2 = ''
            OR TRIM(COALESCE(package_group,'')) = ''
            OR UPPER(COALESCE(package_group,'')) = $2
          )
        )
      )
  `,
    [uid, groupUpper]
  ).catch(() => ({ rows: [{ extra_ports: 0 }] }));
  const totalAllowed = Math.max(0, included + num(extra.rows?.[0]?.extra_ports));

  const rows = await query(
    `
    SELECT id, mt5_login, vps_id, port_id, port_slot, assigned_port_no, windows_port_no,
           COALESCE(vp.folder_path,'') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports vp ON vp.id = a.port_id
    WHERE a.user_id=$1
      AND a.vps_id IS NOT NULL
      AND LOWER(TRIM(COALESCE(a.status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
      AND COALESCE(a.port_slot,0) > $2
  `,
    [uid, totalAllowed]
  ).catch(() => ({ rows: [] }));

  for (const a of rows.rows || []) {
    const vpsId = num(a.vps_id);
    const portNo = num(a.assigned_port_no) || num(a.windows_port_no);
    const folder = String(a.folder_path || '').trim();
    if (!vpsId || !portNo || !folder) continue;
    const payload = killPayload(portNo, folder, 'port_entitlement_reduced_expiry', {
      portSlot: a.port_slot,
      userId: uid,
      accountId: num(a.id) || null,
      mt5Login: String(a.mt5_login || '').trim() || null,
      expectedMt5Login: String(a.mt5_login || '').trim() || null
    });
    if (!payload) continue;
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id,node_id,port_id,command_type,payload,status,created_at,updated_at)
      VALUES ($1,$1,$2,'stop_mt5',$3::jsonb,'pending',NOW(),NOW())
    `,
      [vpsId, a.port_id || null, JSON.stringify(payload)]
    ).catch(() => {});
  }

  if ((rows.rows || []).length) {
    await query(
      `
      UPDATE vps_system.mt5_accounts
      SET status='expired', assigned_port_no=NULL, windows_port_no=NULL, vps_id=NULL, port_id=NULL, updated_at=NOW()
      WHERE user_id=$1
        AND LOWER(TRIM(COALESCE(status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
        AND COALESCE(port_slot,0) > $2
    `,
      [uid, totalAllowed]
    ).catch(() => {});

    await query(
      `
      UPDATE vps_system.bot_instances
      SET status='stopped', stopped_at=COALESCE(stopped_at,NOW()), updated_at=NOW(),
          last_error='port_entitlement_reduced_expiry', ea_status='stopped'
      WHERE user_id=$1
        AND status IN ('running','pending','restarting')
        AND COALESCE(port_used, assigned_port_no, 0) > $2
    `,
      [uid, totalAllowed]
    ).catch(() => {});
  }

  return { ok: true, totalAllowed, stoppedAccountsAbove: (rows.rows || []).length };
}

async function runMt5ExpiryEnforcerOnce() {
  const startedAt = Date.now();
  const expiredSubscriptions = await expireDueSubscriptions();
  const { userIds: touchedByPorts } = await expireExtraPorts();
  const expiredUsers = await findUsersNeedingPackageExpiryKill();

  let stoppedUsers = 0;
  let totalTargets = 0;
  for (const uid of expiredUsers) {
    const r = await applyPackageExpiredSideEffects(uid, 'package_expired_auto_stop').catch(() => null);
    if (r?.ok) {
      stoppedUsers += 1;
      totalTargets += num(r.targets);
    }
  }

  const candidates = Array.from(
    new Set([...(touchedByPorts || []), ...(await findUsersWithEntitlementChangeCandidates())])
  );
  let entitlementFixed = 0;
  for (const uid of candidates) {
    const r = await enforceEntitlementForUser(uid).catch(() => null);
    if (r?.ok) entitlementFixed += 1;
  }

  return {
    ok: true,
    ms: Date.now() - startedAt,
    expiredSubscriptions,
    expiredUsers: expiredUsers.length,
    stoppedUsers,
    totalTargets,
    entitlementFixed
  };
}

module.exports = {
  runMt5ExpiryEnforcerOnce,
  enqueueStopAllForUser,
  findUsersNeedingPackageExpiryKill,
  deactivateTemporaryPortsForUser,
  applyPackageExpiredSideEffects,
  userHasActivePackage,
  expireDueSubscriptions,
  findExpiredPackageKillPorts,
  findExpiredKillPortsFromPortHealth,
  sweepNodePackageExpiry
};
