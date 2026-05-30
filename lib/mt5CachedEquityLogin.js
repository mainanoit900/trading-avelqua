'use strict';

const { query } = require('../config/database');
const { promoteAccountConnected } = require('./mt5LoginCommandVerify');
const { createConnectAttempt, finalizeAttemptConnected } = require('./mt5ConnectAttempt');
const { clearOtherAccountsOnPortSlot, expireDuplicatePortSlotRows } = require('./mt5PortAccount');

const ACTIVE_BOUND_STATUSES = ['connected', 'connecting', 'checking', 'starting', 'ready'];

function clean(v) {
  return String(v || '').trim();
}

function moneyMetric(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function findMt5LoginBoundToOtherUser(mt5Login, serverName, userId) {
  const login = clean(mt5Login);
  const server = clean(serverName);
  const uid = Number(userId || 0);
  if (!login || !server || !uid) return null;
  const r = await query(
    `
    SELECT id, user_id
    FROM vps_system.mt5_accounts
    WHERE mt5_login = $1
      AND COALESCE(server_name, mt5_server, '') = $2
      AND user_id <> $3
      AND login_verified = TRUE
      AND LOWER(COALESCE(status, '')) = ANY($4::text[])
    LIMIT 1
  `,
    [login, server, uid, ACTIVE_BOUND_STATUSES]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function resolveCanonicalAccountId(userId, mt5Login, serverName, preferredId = 0) {
  const uid = Number(userId || 0);
  const login = clean(mt5Login);
  const server = clean(serverName);
  const prefer = Number(preferredId || 0);
  if (!uid || !login || !server) return 0;
  const r = await query(
    `
    SELECT id
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND mt5_login = $2
      AND COALESCE(server_name, mt5_server, '') = $3
    ORDER BY
      CASE LOWER(COALESCE(status, ''))
        WHEN 'connected' THEN 0
        WHEN 'connecting' THEN 1
        WHEN 'checking' THEN 2
        WHEN 'starting' THEN 3
        WHEN 'ready' THEN 4
        WHEN 'failed' THEN 5
        WHEN 'cancelled' THEN 6
        ELSE 7
      END,
      CASE WHEN $4::bigint > 0 AND id = $4 THEN 0 ELSE 1 END,
      CASE WHEN login_verified = TRUE THEN 0 ELSE 1 END,
      CASE WHEN port_slot IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN last_equity IS NOT NULL OR last_balance IS NOT NULL THEN 0 ELSE 1 END,
      id DESC
    LIMIT 1
  `,
    [uid, login, server, prefer]
  ).catch(() => ({ rows: [] }));
  return Number(r.rows?.[0]?.id || 0);
}

async function retireDuplicateLoginRows(userId, mt5Login, serverName, keepAccountId) {
  const uid = Number(userId || 0);
  const login = clean(mt5Login);
  const server = clean(serverName);
  const keepId = Number(keepAccountId || 0);
  if (!uid || !login || !server || !keepId) return;

  await query(
    `
    UPDATE vps_system.mt5_accounts keeper
    SET port_slot = COALESCE(keeper.port_slot, dup.port_slot),
        vps_id = COALESCE(keeper.vps_id, dup.vps_id),
        port_id = COALESCE(keeper.port_id, dup.port_id),
        assigned_port_no = COALESCE(keeper.assigned_port_no, dup.assigned_port_no),
        windows_port_no = COALESCE(keeper.windows_port_no, dup.windows_port_no),
        last_equity = COALESCE(keeper.last_equity, dup.last_equity),
        last_balance = COALESCE(keeper.last_balance, dup.last_balance),
        login_verified = COALESCE(keeper.login_verified, dup.login_verified),
        metrics_ready = COALESCE(keeper.metrics_ready, dup.metrics_ready),
        updated_at = NOW()
    FROM vps_system.mt5_accounts dup
    WHERE keeper.id = $4
      AND dup.user_id = $1
      AND dup.mt5_login = $2
      AND COALESCE(dup.server_name, dup.mt5_server, '') = $3
      AND dup.id <> $4
      AND LOWER(COALESCE(dup.status, '')) NOT IN ('deleted', 'expired')
  `,
    [uid, login, server, keepId]
  ).catch(() => {});

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status = 'deleted',
        port_slot = NULL,
        vps_id = NULL,
        port_id = NULL,
        assigned_port_no = NULL,
        windows_port_no = NULL,
        current_attempt_id = NULL,
        last_login_message = 'รวมบัญชี MT5 ซ้ำ — ใช้แถวหลักแทน',
        updated_at = NOW()
    WHERE user_id = $1
      AND mt5_login = $2
      AND COALESCE(server_name, mt5_server, '') = $3
      AND id <> $4
      AND LOWER(COALESCE(status, '')) NOT IN ('deleted', 'expired')
  `,
    [uid, login, server, keepId]
  ).catch(() => {});
}

async function getCachedEquityLoginRow(userId, mt5Login, serverName) {
  const uid = Number(userId || 0);
  const login = clean(mt5Login);
  const server = clean(serverName);
  if (!uid || !login || !server) return null;
  const canonicalId = await resolveCanonicalAccountId(uid, login, server);
  const r = await query(
    `
    SELECT id, mt5_password, last_equity, last_balance, login_verified, port_slot
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND mt5_login = $2
      AND COALESCE(server_name, mt5_server, '') = $3
      AND (last_equity IS NOT NULL OR last_balance IS NOT NULL)
      AND LOWER(COALESCE(status, '')) NOT IN ('deleted', 'expired')
    ORDER BY
      CASE WHEN $4::bigint > 0 AND id = $4 THEN 0 ELSE 1 END,
      CASE
        WHEN LOWER(COALESCE(status, '')) = ANY($5::text[]) THEN 0
        ELSE 1
      END,
      updated_at DESC,
      id DESC
    LIMIT 1
  `,
    [uid, login, server, canonicalId, ACTIVE_BOUND_STATUSES]
  ).catch(() => ({ rows: [] }));
  if (r.rows?.[0]) return r.rows[0];

  const hist = await query(
    `
    SELECT a.id, a.mt5_password, at.equity AS last_equity, at.balance AS last_balance,
           a.login_verified, a.port_slot
    FROM vps_system.mt5_connect_attempts at
    JOIN vps_system.mt5_accounts a ON a.id = at.account_id
    WHERE a.user_id = $1
      AND a.mt5_login = $2
      AND COALESCE(a.server_name, a.mt5_server, '') = $3
      AND at.metrics_ready = TRUE
      AND (at.equity IS NOT NULL OR at.balance IS NOT NULL)
      AND LOWER(COALESCE(a.status, '')) NOT IN ('deleted', 'expired')
    ORDER BY at.created_at DESC
    LIMIT 1
  `,
    [uid, login, server]
  ).catch(() => ({ rows: [] }));
  return hist.rows?.[0] || null;
}

function cachedEquityFastConnectMessage() {
  return 'ยืนยันบัญชีจากข้อมูลเดิม — ไม่ต้องเปิด MT5';
}

/**
 * User เก่าที่มี Equity ใน DB + รหัสผ่านตรง → connected ทันที ไม่เปิด MT5
 */
async function tryCachedEquityFastConnect({ userId, mt5Login, mt5Password, serverName, portSlot }) {
  const uid = Number(userId || 0);
  const login = clean(mt5Login);
  const server = clean(serverName);
  const password = clean(mt5Password);
  if (!uid || !login || !server || !password) {
    return { ok: false, reason: 'MISSING_PARAMS' };
  }

  const bound = await findMt5LoginBoundToOtherUser(login, server, uid);
  if (bound) {
    return { ok: false, reason: 'BOUND_OTHER_USER' };
  }

  const cached = await getCachedEquityLoginRow(uid, login, server);
  if (!cached) return { ok: false, reason: 'NO_CACHED_EQUITY' };
  if (clean(cached.mt5_password) !== password) {
    return { ok: false, reason: 'PASSWORD_MISMATCH' };
  }

  const balance = moneyMetric(cached.last_balance);
  const equity = moneyMetric(cached.last_equity);
  if (balance === null && equity === null) {
    return { ok: false, reason: 'NO_METRICS' };
  }

  const slot = Number(portSlot || 0) || null;
  if (!slot) return { ok: false, reason: 'MISSING_PORT_SLOT' };
  const msg = cachedEquityFastConnectMessage();
  const accountName = `PORT ${slot}`;
  const canonicalId = await resolveCanonicalAccountId(uid, login, server, cached.id);
  if (!canonicalId) return { ok: false, reason: 'ACCOUNT_UPSERT_FAILED' };

  let acc = await query(
    `
    UPDATE vps_system.mt5_accounts
    SET
      port_slot=$2,
      mt5_password=$3,
      broker='MH Markets',
      server_name=$4,
      mt5_server=$4,
      account_name=$5,
      status='connected',
      login_verified=TRUE,
      metrics_ready=TRUE,
      last_error=NULL,
      last_login_message=$6,
      vps_id=NULL,
      port_id=NULL,
      assigned_port_no=NULL,
      windows_port_no=NULL,
      last_balance=COALESCE($7, last_balance),
      last_equity=COALESCE($8, last_equity),
      connected_at=COALESCE(connected_at, NOW()),
      updated_at=NOW()
    WHERE id=$9
    RETURNING id, last_equity, last_balance
  `,
    [uid, slot, password, server, accountName, msg, balance, equity, canonicalId]
  ).catch(() => ({ rows: [] }));

  if (!acc.rows?.[0]) {
    acc = await query(
      `
      INSERT INTO vps_system.mt5_accounts
      (user_id, port_slot, mt5_login, mt5_password, broker, server_name, mt5_server, account_name,
       status, login_verified, metrics_ready, last_login_message, last_balance, last_equity,
       connect_started_at, connected_at, updated_at)
      VALUES
      ($1,$2,$3,$4,'MH Markets',$5,$5,$6,'connected',TRUE,TRUE,$7,$8,$9,NOW(),NOW(),NOW())
      RETURNING id, last_equity, last_balance
    `,
      [uid, slot, login, password, server, accountName, msg, balance, equity]
    ).catch(async (insErr) => {
      if (insErr?.code !== '23505') throw insErr;
      const reviveId = await resolveCanonicalAccountId(uid, login, server);
      if (!reviveId) return { rows: [] };
      return query(
        `
        UPDATE vps_system.mt5_accounts
        SET
          port_slot=$2,
          mt5_password=$3,
          status='connected',
          login_verified=TRUE,
          metrics_ready=TRUE,
          last_error=NULL,
          last_login_message=$4,
          vps_id=NULL,
          port_id=NULL,
          assigned_port_no=NULL,
          windows_port_no=NULL,
          last_balance=COALESCE($5, last_balance),
          last_equity=COALESCE($6, last_equity),
          connected_at=COALESCE(connected_at, NOW()),
          updated_at=NOW()
        WHERE id=$7
        RETURNING id, last_equity, last_balance
      `,
        [uid, slot, password, msg, balance, equity, reviveId]
      );
    });
  }
  const accountId = Number(acc.rows?.[0]?.id || canonicalId || 0);
  if (!accountId) return { ok: false, reason: 'ACCOUNT_UPSERT_FAILED' };

  await retireDuplicateLoginRows(uid, login, server, accountId).catch(() => {});
  if (slot) {
    await clearOtherAccountsOnPortSlot(query, uid, slot, accountId).catch(() => {});
    await expireDuplicatePortSlotRows(query, uid, slot, accountId, msg).catch(() => {});
  }

  await promoteAccountConnected({
    accountId,
    portId: null,
    mt5Login: login,
    message: msg,
    lockPortAfterLogin: false,
    userId: uid,
    balance,
    equity,
    requireMetrics: true,
    skipVpsRestore: true
  }).catch(() => {});

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET
      login_verified=TRUE,
      current_attempt_id=NULL,
      vps_id=NULL,
      port_id=NULL,
      assigned_port_no=NULL,
      windows_port_no=NULL
    WHERE id=$1
  `,
    [accountId]
  ).catch(() => {});

  const attemptId = await createConnectAttempt({
    accountId,
    userId: uid,
    portSlot: slot,
    mt5Login: login,
    serverName: server,
    purposeType: 'login_only'
  }).catch(() => null);

  if (attemptId) {
    await finalizeAttemptConnected(
      { attempt_id: attemptId, account_id: accountId, mt5_login: login },
      {
        message: msg,
        evidenceSource: 'cached_equity',
        observedLogin: login,
        balance,
        equity
      }
    ).catch(() => {});
  }

  await query(
    `
    INSERT INTO vps_system.mt5_login_history
    (user_id, account_id, mt5_login, server_name, status, message)
    VALUES ($1,$2,$3,$4,'connected',$5)
  `,
    [uid, accountId, login, server, msg]
  ).catch(() => {});

  return {
    ok: true,
    accountId,
    portSlot: slot,
    balance,
    equity,
    message: msg,
    fastPath: true
  };
}

function fastConnectErrorMessage(reason, mt5Login) {
  if (reason === 'PASSWORD_MISMATCH') return 'รหัสผ่าน MT5 ไม่ถูกต้อง';
  if (reason === 'BOUND_OTHER_USER') {
    return `บัญชี MT5 ${clean(mt5Login)} ถูกผูกกับผู้ใช้อื่นแล้ว — ใช้บัญชี MT5 ของคุณเอง`;
  }
  return null;
}

/** ซ่อม PORT ที่หลุดจาก fast-login ซ้ำแถว — เรียกตอนเปิดหน้า MT5 */
async function repairUserMt5PortBindings(userId) {
  const uid = Number(userId || 0);
  if (!uid) return 0;
  let repaired = 0;

  const dupes = await query(
    `
    SELECT mt5_login, COALESCE(server_name, mt5_server, '') AS server_name
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND LOWER(COALESCE(status, '')) NOT IN ('deleted', 'expired')
    GROUP BY mt5_login, COALESCE(server_name, mt5_server, '')
    HAVING COUNT(*) > 1
  `,
    [uid]
  ).catch(() => ({ rows: [] }));

  for (const row of dupes.rows || []) {
    const keepId = await resolveCanonicalAccountId(uid, row.mt5_login, row.server_name);
    if (!keepId) continue;
    await retireDuplicateLoginRows(uid, row.mt5_login, row.server_name, keepId);
    repaired += 1;
  }

  const restored = await query(
    `
    UPDATE vps_system.mt5_accounts canon
    SET port_slot = src.port_slot,
        account_name = COALESCE(NULLIF(canon.account_name, ''), 'PORT ' || src.port_slot::text),
        updated_at = NOW()
    FROM vps_system.mt5_accounts src
    WHERE canon.user_id = $1
      AND src.user_id = $1
      AND canon.mt5_login = src.mt5_login
      AND canon.port_slot IS NULL
      AND src.port_slot IS NOT NULL
      AND LOWER(COALESCE(canon.status, '')) = 'connected'
      AND LOWER(COALESCE(src.status, '')) IN ('deleted', 'expired', 'failed', 'cancelled')
      AND canon.id <> src.id
    RETURNING canon.id, canon.port_slot
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  repaired += restored.rows?.length || 0;

  const fromBots = await query(
    `
    UPDATE vps_system.mt5_accounts a
    SET port_slot = COALESCE(a.port_slot, NULLIF(bi.port_used, 0), bi.assigned_port_no),
        status = CASE
          WHEN LOWER(COALESCE(a.status, '')) IN ('failed', 'connecting')
            AND (a.last_equity IS NOT NULL OR a.last_balance IS NOT NULL)
          THEN 'connected'
          ELSE a.status
        END,
        last_login_message = CASE
          WHEN LOWER(COALESCE(a.status, '')) = 'failed'
          THEN COALESCE(NULLIF(a.last_login_message, ''), 'พร้อมรัน — ใช้ข้อมูลเดิม')
          ELSE a.last_login_message
        END,
        updated_at = NOW()
    FROM vps_system.bot_instances bi
    WHERE a.user_id = $1
      AND bi.mt5_account_id = a.id
      AND LOWER(COALESCE(bi.status, '')) IN ('pending', 'running', 'connecting', 'starting')
      AND a.port_slot IS NULL
      AND COALESCE(NULLIF(bi.port_used, 0), bi.assigned_port_no) IS NOT NULL
    RETURNING a.id, a.port_slot
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  repaired += fromBots.rows?.length || 0;

  const revived = await query(
    `
    UPDATE vps_system.mt5_accounts a
    SET status = 'connected',
        last_error = NULL,
        last_login_message = COALESCE(NULLIF(a.last_login_message, ''), 'พร้อมรัน — ใช้ข้อมูลเดิม'),
        updated_at = NOW()
    WHERE a.user_id = $1
      AND LOWER(COALESCE(a.status, '')) = 'deleted'
      AND a.port_slot IS NOT NULL
      AND (a.last_equity IS NOT NULL OR a.last_balance IS NOT NULL)
      AND COALESCE(a.last_login_message, '') NOT ILIKE '%ลบ PORT%'
      AND COALESCE(a.last_login_message, '') NOT ILIKE '%รวมบัญชี MT5 ซ้ำ%'
      AND NOT EXISTS (
        SELECT 1
        FROM vps_system.mt5_accounts b
        WHERE b.user_id = a.user_id
          AND b.port_slot = a.port_slot
          AND b.id <> a.id
          AND LOWER(COALESCE(b.status, '')) NOT IN ('deleted', 'expired')
      )
    RETURNING a.id, a.port_slot
  `,
    [uid]
  ).catch(() => ({ rows: [] }));
  repaired += revived.rows?.length || 0;

  await query(
    `
    UPDATE vps_system.bot_instances bi
    SET status = 'stopped',
        stopped_at = COALESCE(stopped_at, NOW()),
        last_error = COALESCE(NULLIF(last_error, ''), 'Login ไม่สำเร็จ — ยังไม่ได้ส่งคำสั่ง Run'),
        updated_at = NOW()
    WHERE bi.user_id = $1
      AND LOWER(COALESCE(bi.status, '')) IN ('pending', 'running', 'connecting', 'starting')
      AND bi.stopped_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM vps_system.vps_agent_commands lc
        WHERE lc.id = NULLIF(COALESCE(bi.run_payload->>'loginCommandId', ''), '')::bigint
          AND LOWER(COALESCE(lc.status, '')) IN ('cancelled', 'failed', 'error')
      )
      AND EXISTS (
        SELECT 1
        FROM vps_system.vps_agent_commands rc
        WHERE rc.id = NULLIF(COALESCE(bi.run_payload->>'commandId', ''), '')::bigint
          AND LOWER(COALESCE(rc.status, '')) = 'pending'
      )
  `,
    [uid]
  ).catch(() => {});

  await query(
    `
    UPDATE vps_system.vps_agent_commands rc
    SET status = 'cancelled',
        error = COALESCE(NULLIF(rc.error, ''), 'cancelled: bot run login failed'),
        finished_at = COALESCE(rc.finished_at, NOW()),
        updated_at = NOW()
    FROM vps_system.bot_instances bi
    WHERE bi.user_id = $1
      AND rc.id = NULLIF(COALESCE(bi.run_payload->>'commandId', ''), '')::bigint
      AND LOWER(COALESCE(rc.status, '')) = 'pending'
      AND LOWER(COALESCE(bi.status, '')) = 'stopped'
      AND EXISTS (
        SELECT 1
        FROM vps_system.vps_agent_commands lc
        WHERE lc.id = NULLIF(COALESCE(bi.run_payload->>'loginCommandId', ''), '')::bigint
          AND LOWER(COALESCE(lc.status, '')) IN ('cancelled', 'failed', 'error')
      )
  `,
    [uid]
  ).catch(() => {});

  return repaired;
}

module.exports = {
  tryCachedEquityFastConnect,
  getCachedEquityLoginRow,
  resolveCanonicalAccountId,
  retireDuplicateLoginRows,
  repairUserMt5PortBindings,
  findMt5LoginBoundToOtherUser,
  cachedEquityFastConnectMessage,
  fastConnectErrorMessage
};
