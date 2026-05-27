/* eslint-disable no-console */
'use strict';

const { query } = require('../config/database');

function num(v, def = 0) {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : def;
}

function killPayload(portNo, folderPath, reason, extra = {}) {
  return {
    port: portNo,
    portNumber: portNo,
    portSlot: portNo,
    folder_path: folderPath || null,
    vpsFolderPath: folderPath || null,
    forceKill: true,
    closeMt5: true,
    reason,
    ...extra
  };
}

async function ensureExtraPortsUpdatedAtColumn() {
  await query(
    `ALTER TABLE vps_system.mt5_extra_ports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`
  ).catch(() => {});
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
      AND bi.updated_at > NOW() - INTERVAL '30 days'
    ORDER BY bi.updated_at DESC
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const row of inst.rows || []) {
    const folder = row.folder_path || row.run_folder || '';
    const isActive = ['running', 'pending', 'restarting'].includes(String(row.status || '').toLowerCase());
    add(row.vps_id, row.assigned_port_no, folder, row.port_id, {
      instanceId: String(row.id),
      botCode: row.bot_code || null,
      mt5Login: row.mt5_login || null,
      forBot: isActive
    });
  }

  const acc = await query(
    `
    SELECT a.id, a.vps_id, a.port_id, a.port_slot, a.assigned_port_no, a.windows_port_no,
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
    const portNo = num(a.assigned_port_no) || num(a.windows_port_no) || num(a.port_slot);
    add(a.vps_id, portNo, a.folder_path, a.port_id, {});
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
      botCode: t.extra.botCode || null,
      mt5Login: t.extra.mt5Login || null,
      instanceId: t.extra.instanceId || null
    });

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
      WHERE vps_id IS NOT NULL AND updated_at > NOW() - INTERVAL '30 days'
      UNION
      SELECT DISTINCT user_id FROM vps_system.mt5_accounts
      WHERE vps_id IS NOT NULL
        AND LOWER(TRIM(COALESCE(status,''))) IN ('ready','connected','checking','connecting','starting','failed')
      UNION
      SELECT DISTINCT locked_by_user_id AS user_id FROM vps_system.vps_ports
      WHERE locked_by_user_id IS NOT NULL
      UNION
      SELECT DISTINCT us.user_id
      FROM user_subscriptions us
      WHERE us.end_at IS NOT NULL
        AND us.end_at <= NOW()
        AND us.updated_at > NOW() - INTERVAL '7 days'
    )
    SELECT c.user_id
    FROM candidates c
    WHERE c.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM user_subscriptions us
        WHERE us.user_id = c.user_id
          AND COALESCE(us.status,'')='active'
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
    SELECT id, vps_id, port_id, port_slot, assigned_port_no, windows_port_no,
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
    const portNo = num(a.assigned_port_no) || num(a.windows_port_no) || num(a.port_slot);
    if (!vpsId || !portNo) continue;
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id,node_id,port_id,command_type,payload,status,created_at,updated_at)
      VALUES ($1,$1,$2,'stop_mt5',$3::jsonb,'pending',NOW(),NOW())
    `,
      [
        vpsId,
        a.port_id || null,
        JSON.stringify(killPayload(portNo, a.folder_path, 'port_entitlement_reduced_expiry', { portSlot: a.port_slot }))
      ]
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
  applyPackageExpiredSideEffects
};
