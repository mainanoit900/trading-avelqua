'use strict';

const { query } = require('../config/database');
const { promoteAccountConnected } = require('./mt5LoginCommandVerify');
const { createConnectAttempt, finalizeAttemptConnected } = require('./mt5ConnectAttempt');
const { clearOtherAccountsOnPortSlot } = require('./mt5PortAccount');

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
    LIMIT 1
  `,
    [login, server, uid]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function getCachedEquityLoginRow(userId, mt5Login, serverName) {
  const uid = Number(userId || 0);
  const login = clean(mt5Login);
  const server = clean(serverName);
  if (!uid || !login || !server) return null;
  const r = await query(
    `
    SELECT id, mt5_password, last_equity, last_balance, login_verified, port_slot
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND mt5_login = $2
      AND COALESCE(server_name, mt5_server, '') = $3
      AND (last_equity IS NOT NULL OR last_balance IS NOT NULL)
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [uid, login, server]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
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

  const slot = Number(portSlot || cached.port_slot || 0) || null;
  const msg = cachedEquityFastConnectMessage();
  const accountName = slot ? `PORT ${slot}` : login;

  let acc = await query(
    `
    UPDATE vps_system.mt5_accounts
    SET
      port_slot=COALESCE($2, port_slot),
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
    WHERE user_id=$1
      AND mt5_login=$9
      AND COALESCE(server_name, mt5_server, '')=$4
    RETURNING id, last_equity, last_balance
  `,
    [uid, slot, password, server, accountName, msg, balance, equity, login]
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
      return query(
        `
        UPDATE vps_system.mt5_accounts
        SET
          port_slot=COALESCE($2, port_slot),
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
        WHERE user_id=$1
          AND mt5_login=$7
          AND COALESCE(server_name, mt5_server, '')=$8
        RETURNING id, last_equity, last_balance
      `,
        [uid, slot, password, msg, balance, equity, login, server]
      );
    });
  }
  const accountId = Number(acc.rows?.[0]?.id || cached.id || 0);
  if (!accountId) return { ok: false, reason: 'ACCOUNT_UPSERT_FAILED' };

  if (slot) {
    await clearOtherAccountsOnPortSlot(query, uid, slot, accountId).catch(() => {});
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
    requireMetrics: true
  }).catch(() => {});

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET login_verified=TRUE, current_attempt_id=NULL
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

module.exports = {
  tryCachedEquityFastConnect,
  getCachedEquityLoginRow,
  findMt5LoginBoundToOtherUser,
  cachedEquityFastConnectMessage,
  fastConnectErrorMessage
};
