/* eslint-disable no-console */
'use strict';

const { query } = require('../config/database');

function num(v, def = 0) {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : def;
}

async function expireExtraPorts() {
  // Deactivate any extra ports that passed expires_at (temporary or purchased-with-expiry).
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

async function enqueueStopAllForUser(userId, reason = 'package_expired_auto_stop', closeMt5 = true) {
  const uid = num(userId);
  if (!uid) return { ok: false };

  // Stop running BOT instances (prefer stop_mt5_bot so EA is halted before close).
  const inst = await query(
    `
    SELECT bi.id, bi.vps_id, bi.port_id, bi.assigned_port_no,
           COALESCE(vp.folder_path,'') AS folder_path,
           COALESCE(bi.run_payload->>'botCode', bi.run_payload->>'eaName', '') AS bot_code,
           COALESCE(bi.run_payload->>'mt5Login', '') AS mt5_login
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.vps_ports vp ON vp.id = bi.port_id
    WHERE bi.user_id=$1
      AND bi.status IN ('running','pending','restarting')
      AND bi.vps_id IS NOT NULL
      AND COALESCE(bi.assigned_port_no,0) > 0
    ORDER BY bi.id DESC
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const row of inst.rows || []) {
    const vpsId = num(row.vps_id);
    const portNo = num(row.assigned_port_no);
    if (!vpsId || !portNo) continue;
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id,node_id,port_id,command_type,payload,status,created_at,updated_at)
      VALUES ($1,$1,$2,'stop_mt5_bot',$3::jsonb,'pending',NOW(),NOW())
    `,
      [
        vpsId,
        row.port_id || null,
        JSON.stringify({
          action: 'stop_bot_trading',
          commandType: 'stop_mt5_bot',
          instanceId: String(row.id),
          port: portNo,
          portNumber: portNo,
          portSlot: portNo,
          vpsFolderPath: row.folder_path || null,
          folder_path: row.folder_path || null,
          stopTradingOnly: !closeMt5,
          forceKill: !!closeMt5,
          closeMt5: !!closeMt5,
          botCode: row.bot_code || null,
          mt5Login: row.mt5_login || null,
          reason
        })
      ]
    ).catch(() => {});
  }

  // Stop any MT5 ports that are still marked as connected/connecting, even if no bot instance.
  const acc = await query(
    `
    SELECT a.id, a.vps_id, a.port_id, a.port_slot, a.assigned_port_no, a.windows_port_no,
           COALESCE(vp.folder_path,'') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports vp ON vp.id = a.port_id
    WHERE a.user_id=$1
      AND LOWER(TRIM(COALESCE(a.status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
      AND a.vps_id IS NOT NULL
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const a of acc.rows || []) {
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
        JSON.stringify({
          port: portNo,
          portSlot: a.port_slot,
          assignedPortNo: a.assigned_port_no,
          windowsPortNo: a.windows_port_no,
          folder_path: a.folder_path || null,
          vpsFolderPath: a.folder_path || null,
          reason
        })
      ]
    ).catch(() => {});
  }

  // Mark runtime as expired/stopped in DB.
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

  return { ok: true, stoppedInstances: (inst.rows || []).length, stoppedAccounts: (acc.rows || []).length };
}

async function findUsersWithoutActiveSubscription() {
  // Users that currently occupy MT5/BOT runtime but no active subscription (coupon/package expired).
  const r = await query(
    `
    WITH runtime_users AS (
      SELECT DISTINCT user_id
      FROM vps_system.bot_instances
      WHERE status IN ('running','pending','restarting')
      UNION
      SELECT DISTINCT user_id
      FROM vps_system.mt5_accounts
      WHERE LOWER(TRIM(COALESCE(status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
    )
    SELECT ru.user_id
    FROM runtime_users ru
    WHERE NOT EXISTS (
      SELECT 1
      FROM user_subscriptions us
      WHERE us.user_id = ru.user_id
        AND COALESCE(us.status,'')='active'
        AND (us.end_at IS NULL OR us.end_at > NOW())
    )
  `
  ).catch(() => ({ rows: [] }));
  return Array.from(new Set((r.rows || []).map((x) => num(x.user_id)).filter(Boolean)));
}

async function findUsersWithEntitlementChangeCandidates() {
  // If extra ports expired, entitlement may have reduced. We re-check users who have any expired extra ports.
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

  // Determine included max ports from current active subscription (if any).
  const sub = await query(
    `
    SELECT COALESCE(NULLIF(us.ports_max,0), NULLIF(us.ports_min,0), 0) AS max_ports
    FROM user_subscriptions us
    WHERE us.user_id=$1
      AND COALESCE(us.status,'')='active'
      AND (us.end_at IS NULL OR us.end_at > NOW())
    ORDER BY us.end_at DESC NULLS LAST, us.id DESC
    LIMIT 1
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  const included = num(sub.rows?.[0]?.max_ports);

  // Count active extra ports (temporary/permanent) that are not expired.
  const extra = await query(
    `
    SELECT COALESCE(SUM(qty),0) AS extra_ports
    FROM vps_system.mt5_extra_ports
    WHERE user_id=$1
      AND is_active=TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
  `,
    [uid]
  ).catch(() => ({ rows: [{ extra_ports: 0 }] }));
  const extraPorts = num(extra.rows?.[0]?.extra_ports);
  const totalAllowed = Math.max(0, included + extraPorts);

  // Stop any ports above entitlement by port_slot.
  const rows = await query(
    `
    SELECT id, vps_id, port_id, port_slot, assigned_port_no, windows_port_no
    FROM vps_system.mt5_accounts
    WHERE user_id=$1
      AND LOWER(TRIM(COALESCE(status,'ready'))) IN ('ready','connected','checking','connecting','starting','failed')
      AND COALESCE(port_slot,0) > $2
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
        JSON.stringify({ port: portNo, portSlot: a.port_slot, reason: 'port_entitlement_reduced_expiry' })
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
  const noSubUsers = await findUsersWithoutActiveSubscription();

  let stoppedUsers = 0;
  for (const uid of noSubUsers) {
    const r = await enqueueStopAllForUser(uid, 'package_expired_auto_stop', true).catch(() => null);
    if (r?.ok) stoppedUsers += 1;
  }

  // Entitlement reduction after extra port expiry (only for users we touched).
  const candidates = Array.from(new Set([...(touchedByPorts || []), ...(await findUsersWithEntitlementChangeCandidates())]));
  let entitlementFixed = 0;
  for (const uid of candidates) {
    const r = await enforceEntitlementForUser(uid).catch(() => null);
    if (r?.ok) entitlementFixed += 1;
  }

  return {
    ok: true,
    ms: Date.now() - startedAt,
    stoppedUsers,
    entitlementFixed
  };
}

module.exports = {
  runMt5ExpiryEnforcerOnce
};

