'use strict';

const { query } = require('../config/database');
const { parseMt5JournalOutcome, MT5_SUCCESS_MSG, MT5_FAIL_USER_MSG } = require('./mt5JournalVerify');
const {
  hasJournalGateMarker,
  messageForUpgradeState,
  getAgentUpgradeState,
  expireStuckMaintenanceCommands
} = require('./agentDeploy');
const { buildMt5LoginPayload } = require('./adminVpsPortPicker');
const {
  resolveSystemVpsId,
  setAdminAllocationStatus,
  upsertPortHealthRunning,
  clearPortHealthRunning,
  adminPortNoFromSystem,
  reconcilePortIdleWhenAgentFree
} = require('./adminVpsBridge');

async function findLoginCommandInProgress(accountId, vpsId) {
  if (!accountId || !vpsId) return null;
  const r = await query(
    `
    SELECT id, status
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='login_mt5'
      AND (payload->>'accountId')::text = $2::text
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function findRecentLoginCommand(accountId, vpsId) {
  if (!accountId || !vpsId) return null;
  const r = await query(
    `
    SELECT id, status, result, finished_at, payload
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='login_mt5'
      AND (payload->>'accountId')::text = $2::text
      AND finished_at > NOW() - INTERVAL '3 hours'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

function extractJournalEvidence(...sources) {
  for (const src of sources) {
    const text = String(src || '').trim();
    if (!text) continue;
    if (text.length >= 40 && /authorized on|authorization on/i.test(text)) {
      return text.slice(0, 8000);
    }
  }
  return '';
}

async function verifyPortRunningLogin(vpsId, portNo, mt5Login) {
  if (!vpsId || !portNo || !mt5Login) return { ok: false, reason: 'MISSING_PARAMS' };

  const r = await query(
    `
    SELECT running, mt5_login, payload, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id=$1 AND port_number=$2
      AND updated_at > NOW() - INTERVAL '3 minutes'
    ORDER BY updated_at DESC
    LIMIT 1
  `,
    [vpsId, portNo]
  ).catch(() => ({ rows: [] }));

  const row = r.rows?.[0];
  if (!row || !row.running) return { ok: false, reason: 'PORT_NOT_RUNNING' };

  const login = String(mt5Login).trim();
  let reported = String(row.mt5_login || '').trim();
  if (!reported && row.payload) {
    const pl = typeof row.payload === 'object' ? row.payload : {};
    reported = String(pl.mt5_login || pl.mt5Login || '').trim();
  }
  if (reported && reported === login) {
    return { ok: true, source: 'port_health_login' };
  }

  return { ok: false, reason: 'LOGIN_MISMATCH', reported };
}

/**
 * ยืนยัน login จากผลคำสั่ง login_mt5 (ต้องมี journalEvidence)
 */
async function verifyLoginFromCommand({ accountId, vpsId, mt5Login, portNo }) {
  const login = String(mt5Login || '').trim();
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  if (!cmd) return { ok: false, reason: 'NO_COMMAND' };

  const st = String(cmd.status || '').toLowerCase();
  if (['failed', 'error'].includes(st)) {
    const evidence = extractJournalEvidence(cmd.result?.journalEvidence, cmd.result?.journal_evidence, cmd.error, cmd.result?.message);
    if (evidence && login && parseMt5JournalOutcome(evidence, login) === 'failed') {
      return { ok: false, reason: 'JOURNAL_FAILED', journalEvidence: evidence };
    }
    return { ok: false, reason: 'COMMAND_NOT_SUCCESS', status: st };
  }
  if (!['success', 'done'].includes(st)) {
    return { ok: false, reason: 'COMMAND_NOT_SUCCESS', status: st };
  }

  const result = cmd.result || {};
  const cmdLogin = String(result.login || cmd.payload?.mt5Login || '').trim();
  if (login && cmdLogin && cmdLogin !== login) {
    return { ok: false, reason: 'LOGIN_MISMATCH' };
  }

  const evidence = extractJournalEvidence(
    result.journalEvidence,
    result.journal_evidence,
    result.message
  );
  if (evidence && login) {
    const verdict = parseMt5JournalOutcome(evidence, login);
    if (verdict === 'success') {
      return { ok: true, source: 'command_journal', journalEvidence: evidence };
    }
    if (verdict === 'failed') {
      return { ok: false, reason: 'JOURNAL_FAILED', journalEvidence: evidence };
    }
  }

  return { ok: false, reason: 'JOURNAL_REQUIRED' };
}

function journalLogPathsForFolder(folderPath) {
  const base = String(folderPath || '').trim().replace(/[\\/]+$/, '');
  if (!base) return [];
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const altBase = base.replace(/MT5_PORTS/gi, 'MT5_PORTs');
  const bases = [...new Set([base, altBase].filter(Boolean))];
  const paths = [];
  for (const b of bases) {
    paths.push(`${b}\\logs\\${today}.log`);
    paths.push(`${b}\\Logs\\${today}.log`);
  }
  return [...new Set(paths)];
}

function isLegacyWindowVerifiedMessage(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('window verified') ||
    m.includes('login success') ||
    m.includes('เห็นบัญชี') ||
    m.includes('หน้าต่าง mt5')
  );
}

async function cancelStuckJournalReads(vpsId, accountId) {
  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: journal read timeout',
        finished_at=NOW(),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND (
        LOWER(COALESCE(status, '')) IN ('processing', 'picked', 'running')
        AND created_at < NOW() - INTERVAL '45 seconds'
      )
  `,
    [vpsId, String(accountId)]
  ).catch(() => {});
}

async function syncJournalFromLatestCommand(accountId, vpsId, login, folderPath, portNo) {
  let nodeId = vpsId;
  if (!nodeId) {
    const restored = await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => null);
    nodeId = restored?.vpsId || null;
  }
  const applied = await tryApplyPendingJournalRead(accountId, nodeId).catch(() => false);
  if (applied) return { applied: true, action: 'applied' };

  const journalSql = nodeId
    ? `
    SELECT result, payload, finished_at
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '20 minutes'
    ORDER BY id DESC
    LIMIT 1
  `
    : `
    SELECT result, payload, finished_at
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $1::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '20 minutes'
    ORDER BY id DESC
    LIMIT 1
  `;
  const journalParams = nodeId ? [nodeId, String(accountId)] : [String(accountId)];
  const r = await query(journalSql, journalParams).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) {
    const fp = folderPath;
    if (fp && login && nodeId) {
      await queueJournalReadVerify({ accountId, vpsId: nodeId, folderPath: fp, mt5Login: login, portNo }).catch(() => {});
    }
    return { applied: false, action: 'queued' };
  }

  const content = String(
    row.result?.journalEvidence || row.result?.journal_evidence || row.result?.content || ''
  ).trim();
  const verdict = content && login ? parseMt5JournalOutcome(content, login) : null;
  if (verdict === 'success' || verdict === 'failed') {
    const ok = await applyJournalReadCommandResult({ id: nodeId }, row.payload || {}, row.result || {});
    return { applied: ok, action: verdict };
  }

  const finMs = row.finished_at ? new Date(row.finished_at).getTime() : 0;
  if (folderPath && login && finMs && Date.now() - finMs > 6000 && nodeId) {
    await queueJournalReadVerify({ accountId, vpsId: nodeId, folderPath, mt5Login: login, portNo }).catch(() => {});
    return { applied: false, action: 'requeued' };
  }
  return { applied: false, action: 'waiting' };
}

async function tryApplyPendingJournalRead(accountId, vpsId) {
  let nodeId = vpsId;
  if (!nodeId) {
    const restored = await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => null);
    nodeId = restored?.vpsId || null;
  }

  const sql = nodeId
    ? `
    SELECT result, payload, command_type, vps_id, node_id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '15 minutes'
    ORDER BY id DESC
    LIMIT 1
  `
    : `
    SELECT result, payload, command_type, vps_id, node_id
    FROM vps_system.vps_agent_commands
    WHERE command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $1::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '15 minutes'
    ORDER BY id DESC
    LIMIT 1
  `;
  const params = nodeId ? [nodeId, String(accountId)] : [String(accountId)];
  const r = await query(sql, params).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return false;
  const applyNodeId = nodeId || row.vps_id || row.node_id;
  return applyJournalReadCommandResult({ id: applyNodeId }, row.payload || {}, row.result || {});
}

async function queueJournalReadVerify({ accountId, vpsId, folderPath, mt5Login, portNo }) {
  if (!accountId || !vpsId || !mt5Login) return false;

  await cancelStuckJournalReads(vpsId, accountId);

  const pending = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND created_at > NOW() - INTERVAL '5 minutes'
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));
  if (pending.rows?.[0]) return false;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const port = Number(portNo || 0);
  const login = String(mt5Login).trim();

  if (port && folderPath) {
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, command_type, payload, status, created_at, updated_at)
      VALUES ($1, $1, 'port_read_file', $2::jsonb, 'pending', NOW(), NOW())
    `,
      [
        vpsId,
        JSON.stringify({
          port,
          portNumber: port,
          port_no: port,
          vpsFolderPath: folderPath,
          folder_path: folderPath,
          file_path: `logs\\${today}.log`,
          accountId,
          purpose: 'verify_mt5_journal',
          mt5Login: login
        })
      ]
    ).catch(() => {});
    return true;
  }

  const logPaths = journalLogPathsForFolder(folderPath);
  if (!logPaths.length) return false;

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'read_file', $2::jsonb, 'pending', NOW(), NOW())
  `,
    [
      vpsId,
      JSON.stringify({
        file_path: logPaths[0],
        file_paths: logPaths,
        accountId,
        purpose: 'verify_mt5_journal',
        mt5Login: login
      })
    ]
  ).catch(() => {});

  return true;
}

async function handleLegacyWindowVerifiedConnect({
  accountId,
  vpsId,
  portId,
  portNo,
  mt5Login,
  message,
  folderPath
}) {
  if (!isLegacyWindowVerifiedMessage(message)) return false;

  const login = String(mt5Login || '').trim();
  const cmd = await findRecentLoginCommand(accountId, vpsId);
  const cmdOk = cmd && ['success', 'done'].includes(String(cmd.status || '').toLowerCase());
  if (!cmdOk) return false;

  if (folderPath) {
    await queueJournalReadVerify({ accountId, vpsId, folderPath, mt5Login: login }).catch(() => {});
  }

  const applied = await tryApplyPendingJournalRead(accountId, vpsId).catch(() => false);
  if (applied) return true;

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='checking', last_error=NULL,
        last_login_message='กำลังยืนยัน Login จาก MT5 Journal...', updated_at=NOW()
    WHERE id=$1
  `, [accountId]).catch(() => {});

  return 'pending';
}

async function queueStopMt5ForAccount(accountId, opts = {}) {
  let vpsId = Number(opts.vpsId || 0);
  let portId = Number(opts.portId || 0);
  let portNo = Number(opts.portNo || opts.port_no || 0);
  let folderPath = String(opts.folderPath || opts.folder_path || '').trim();

  if (accountId && (!vpsId || !folderPath)) {
    const acc = await query(
      `
      SELECT a.vps_id, a.port_id, a.assigned_port_no, a.port_slot, p.folder_path
      FROM vps_system.mt5_accounts a
      LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
      WHERE a.id=$1
      LIMIT 1
    `,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const row = acc.rows?.[0];
    if (row) {
      vpsId = vpsId || Number(row.vps_id || 0);
      portId = portId || Number(row.port_id || 0);
      portNo = portNo || Number(row.assigned_port_no || row.port_slot || 0);
      folderPath = folderPath || String(row.folder_path || '').trim();
    }
  }

  if (!vpsId) return false;

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status='cancelled',
        error='cancelled: journal login failed',
        finished_at=NOW(),
        updated_at=NOW()
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type='login_mt5'
      AND (payload->>'accountId')::text = $2::text
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
  `,
    [vpsId, String(accountId)]
  ).catch(() => {});

  const pl = {
    port: portNo || undefined,
    port_no: portNo || undefined,
    portNumber: portNo || undefined,
    folder_path: folderPath,
    folderPath,
    vpsFolderPath: folderPath,
    accountId,
    reason: opts.reason || 'journal_auth_failed'
  };

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, $2, 'stop_mt5', $3::jsonb, 'pending', NOW(), NOW())
  `,
    [vpsId, portId || null, JSON.stringify(pl)]
  ).catch(() => {});

  return true;
}

/** Login ผิด/ล้มเหลว — ปิด MT5 ทันที, ไม่ค้าง PORT แพ็กเกจ, เคลียร์ admin เป็น ว่าง */
async function failAccountFromJournal(accountId, portId, message, opts = {}) {
  const msg = message || MT5_FAIL_USER_MSG;
  const accRes = await query(
    `
    SELECT a.vps_id, a.port_id, a.port_slot, a.assigned_port_no, a.windows_port_no,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1
    LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const acc = accRes.rows?.[0] || {};

  const vpsId = Number(opts.vpsId || acc.vps_id || 0);
  const effectivePortId = Number(portId || acc.port_id || 0);
  const portNo = Number(opts.portNo || acc.assigned_port_no || acc.windows_port_no || 0);
  const folderPath = String(opts.folderPath || acc.folder_path || '').trim();
  const adminPortNo = adminPortNoFromSystem(portNo);

  await queueStopMt5ForAccount(accountId, {
    portId: effectivePortId,
    vpsId,
    portNo,
    folderPath,
    reason: opts.reason || 'login_failed'
  }).catch(() => {});

  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET status='failed',
        last_error=$2,
        last_login_message=$2,
        port_slot=NULL,
        vps_id=NULL,
        port_id=NULL,
        assigned_port_no=NULL,
        windows_port_no=NULL,
        updated_at=NOW()
    WHERE id=$1
  `,
    [accountId, msg]
  ).catch(() => {});

  if (effectivePortId) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL,
          process_id=NULL, last_pid=NULL,
          mt5_login=NULL, current_mt5_login=NULL, last_error=$2, updated_at=NOW()
      WHERE id=$1
    `,
      [effectivePortId, msg]
    ).catch(() => {});
  } else if (vpsId && portNo) {
    await query(
      `
      UPDATE vps_system.vps_ports
      SET status='available', locked_by_user_id=NULL, locked_until=NULL,
          process_id=NULL, last_pid=NULL,
          mt5_login=NULL, current_mt5_login=NULL, last_error=$2, updated_at=NOW()
      WHERE vps_id=$1 AND port_no = ANY($2::int[])
    `,
      [vpsId, systemPortNosForFail(portNo)]
    ).catch(() => {});
  }

  if (vpsId && portNo) {
    await clearPortHealthRunning(vpsId, portNo).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(vpsId);
    if (adminNodeId && adminPortNo) {
      await reconcilePortIdleWhenAgentFree(adminNodeId, adminPortNo, folderPath).catch(() => {});
      await setAdminAllocationStatus(adminNodeId, adminPortNo, 'free').catch(() => {});
    }
  }
}

function systemPortNosForFail(portNo) {
  const n = Number(portNo || 0);
  if (!n) return [];
  if (n >= 100) return [n];
  return [...new Set([n, 100 + n].filter((x) => x > 0))];
}

async function applyJournalReadCommandResult(node, payload, result) {
  const accountId = Number(payload?.accountId ?? 0);
  const login = String(payload?.mt5Login || '').trim();
  const content = String(
    result?.content || result?.journalEvidence || result?.journal_evidence || result?.text || ''
  ).trim();
  if (!accountId || !login || !content) return false;

  const verdict = parseMt5JournalOutcome(content, login);
  const acc = await query(
    `
    SELECT a.port_id, a.vps_id, a.assigned_port_no, a.port_slot, p.folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1 LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));
  const accRow = acc.rows?.[0] || {};
  const portId = Number(accRow.port_id || 0);

  if (verdict === 'failed') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
      vpsId: accRow.vps_id || node?.id,
      portNo: accRow.assigned_port_no || accRow.port_slot || payload?.portNo,
      folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || accRow.folder_path
    });
    return true;
  }
  if (verdict !== 'success') return false;

  await promoteAccountConnected({
    accountId,
    portId,
    mt5Login: login,
    message: MT5_SUCCESS_MSG
  });
  return true;
}

async function restoreAccountVpsBindingFromLatestLogin(accountId) {
  const r = await query(
    `
    SELECT payload
    FROM vps_system.vps_agent_commands
    WHERE command_type = 'login_mt5'
      AND (payload->>'accountId')::text = $1::text
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
    ORDER BY id DESC
    LIMIT 1
  `,
    [String(accountId)]
  ).catch(() => ({ rows: [] }));
  const p = r.rows?.[0]?.payload || {};
  const vpsId = Number(p.vpsId || p.nodeId || 0) || null;
  const portId = Number(p.portId || 0) || null;
  const portNo = Number(p.portNo || p.port_no || p.portNumber || p.port || 0) || null;
  if (!vpsId && !portId) return null;
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET
      vps_id = COALESCE(vps_id, $2),
      port_id = COALESCE(port_id, $3),
      assigned_port_no = COALESCE(assigned_port_no, $4),
      windows_port_no = COALESCE(windows_port_no, $4),
      port_slot = COALESCE(port_slot, $4),
      updated_at = NOW()
    WHERE id = $1
  `,
    [accountId, vpsId, portId, portNo]
  ).catch(() => {});
  return { vpsId, portId, portNo };
}

async function promoteAccountConnected({ accountId, portId, mt5Login, message }) {
  const msg = message || MT5_SUCCESS_MSG;
  await restoreAccountVpsBindingFromLatestLogin(accountId).catch(() => {});

  const accRes = await query(
    `
    SELECT a.vps_id, a.assigned_port_no, a.port_slot, a.port_id,
           COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.id=$1 LIMIT 1
  `,
    [accountId]
  ).catch(() => ({ rows: [] }));

  const accRow = accRes.rows?.[0] || {};
  const effectivePortId = portId || Number(accRow.port_id || 0) || null;

  await query(`
    UPDATE vps_system.mt5_accounts
    SET status='connected', last_error=NULL, last_login_message=$2, updated_at=NOW()
    WHERE id=$1
  `, [accountId, msg]).catch(() => {});

  if (effectivePortId) {
    await query(`
      UPDATE vps_system.vps_ports
      SET status='running', mt5_login=$2, current_mt5_login=$2,
          locked_by_user_id=NULL, locked_until=NULL, last_error=NULL, updated_at=NOW()
      WHERE id=$1
    `, [effectivePortId, mt5Login]).catch(() => {});
  }

  const acc = accRow;
  if (acc?.vps_id) {
    const portNo = Number(acc.assigned_port_no || acc.port_slot || 0);
    const folderPath = String(acc.folder_path || '').trim() || null;
    await upsertPortHealthRunning(acc.vps_id, portNo, folderPath, mt5Login).catch(() => {});
    const { adminNodeId } = await resolveSystemVpsId(acc.vps_id);
    if (adminNodeId && portNo) {
      await setAdminAllocationStatus(adminNodeId, portNo, 'used').catch(() => {});
    }
  }
}

async function applyLoginMt5CommandFailed(node, payload, opts = {}) {
  const accountId = Number(payload?.accountId ?? payload?.account_id ?? 0);
  if (!accountId) return false;

  const login = String(payload?.mt5Login || payload?.mt5_login || opts.result?.login || '').trim();
  const result = opts.result && typeof opts.result === 'object' ? opts.result : {};
  const message = String(opts.message || result.message || '').trim();
  const evidence = extractJournalEvidence(
    result.journalEvidence,
    result.journal_evidence,
    result.message,
    message
  );

  let failMsg = MT5_FAIL_USER_MSG;
  if (evidence && login && parseMt5JournalOutcome(evidence, login) === 'failed') {
    failMsg = MT5_FAIL_USER_MSG;
  } else if (/ทันเวลา|timeout/i.test(message)) {
    failMsg = 'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่';
  }

  await failAccountFromJournal(accountId, Number(payload?.portId || payload?.port_id || 0), failMsg, {
    vpsId: node?.id,
    portNo: payload?.portNumber || payload?.port_no || payload?.port,
    folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath
  });
  return true;
}

async function applyLoginMt5FromCommandResult(node, payload, result) {
  const accountId = Number(payload?.accountId ?? payload?.account_id ?? 0);
  if (!accountId || !node?.id) return false;

  const mt5Login = String(result?.login || payload?.mt5Login || payload?.mt5_login || '').trim();
  const portNo = Number(payload?.portNo || payload?.port_no || payload?.portNumber || payload?.port || 0);
  const portId = Number(payload?.portId || payload?.port_id || 0);

  const evidence = extractJournalEvidence(
    result?.journalEvidence,
    result?.journal_evidence,
    result?.message
  );
  let verified = false;
  if (evidence && mt5Login) {
    const verdict = parseMt5JournalOutcome(evidence, mt5Login);
    if (verdict === 'failed') {
      const accRow = await query(
        `
        SELECT a.vps_id, a.assigned_port_no, a.port_slot, p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1 LIMIT 1
      `,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const ar = accRow.rows?.[0] || {};
      await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
        vpsId: node?.id || ar.vps_id,
        portNo: portNo || ar.assigned_port_no || ar.port_slot,
        folderPath: payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || ar.folder_path
      });
      return true;
    }
    if (verdict === 'success') verified = true;
  }
  if (!verified) {
    const folderPath = payload?.folder_path || payload?.folderPath || payload?.vpsFolderPath || '';
    await query(`
      UPDATE vps_system.mt5_accounts
      SET status='checking', last_error=NULL,
          last_login_message='กำลังตรวจสอบ Login MT5 จาก Journal...', updated_at=NOW()
      WHERE id=$1 AND LOWER(COALESCE(status,'')) IN ('connecting','starting','checking')
    `, [accountId]).catch(() => {});
    await queueJournalReadVerify({
      accountId,
      vpsId: node.id,
      folderPath,
      mt5Login,
      portNo
    }).catch(() => {});
    const applied = await tryApplyPendingJournalRead(accountId, node.id).catch(() => false);
    if (applied) return true;
    return false;
  }

  await promoteAccountConnected({
    accountId,
    portId,
    mt5Login,
    message: MT5_SUCCESS_MSG
  });
  return true;
}

/**
 * แก้สถานะค้าง checking/starting หลัง Agent เก่าส่ง connected แต่ไม่มี journal
 */
async function resolveStuckLoginAccount(account) {
  if (!account?.id) return { resolved: false };

  const accountId = Number(account.id);
  const vpsId = Number(account.vps_id || 0);
  const portId = Number(account.port_id || 0);
  const portNo = Number(account.assigned_port_no || account.port_no || 0);
  const login = String(account.mt5_login || '').trim();
  const status = String(account.status || '').toLowerCase();
  if (!['connecting', 'starting', 'checking'].includes(status)) {
    return { resolved: false };
  }

  const updatedAt = account.updated_at ? new Date(account.updated_at).getTime() : 0;
  const elapsedSec = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));

  const folderPathEarly = account.folder_path || '';
  const journalSync = await syncJournalFromLatestCommand(
    accountId, vpsId, login, folderPathEarly, portNo
  ).catch(() => ({ applied: false }));
  if (journalSync.applied) {
    const stRow = await query(
      `SELECT status, last_login_message FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const stNow = String(stRow.rows?.[0]?.status || '').toLowerCase();
    if (stNow === 'failed') {
      return {
        resolved: true,
        status: 'failed',
        message: stRow.rows?.[0]?.last_login_message || MT5_FAIL_USER_MSG
      };
    }
    return { resolved: true, status: 'connected', source: 'journal_read' };
  }

  if (elapsedSec >= 2) {
    const cmd = await findRecentLoginCommand(accountId, vpsId);
    if (cmd) {
      const st = String(cmd.status || '').toLowerCase();
      const res = cmd.result && typeof cmd.result === 'object' ? cmd.result : {};
      const evidence = extractJournalEvidence(res.journalEvidence, res.journal_evidence, res.message, cmd.error);
      if (evidence && login && parseMt5JournalOutcome(evidence, login) === 'failed') {
        await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
          vpsId, portNo, folderPath: folderPathEarly, reason: 'login_cmd_journal_failed'
        });
        return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
      }
      if (['failed', 'error'].includes(st)) {
        await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG, {
          vpsId, portNo, folderPath: folderPathEarly, reason: 'login_cmd_failed'
        });
        return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
      }
    }
  }

  if (elapsedSec < 2) return { resolved: false };

  if (folderPathEarly && elapsedSec >= 2) {
    await queueJournalReadVerify({
      accountId,
      vpsId,
      folderPath: folderPathEarly,
      mt5Login: login,
      portNo
    }).catch(() => {});
    const appliedEarly = await tryApplyPendingJournalRead(accountId, vpsId).catch(() => false);
    if (appliedEarly) {
      const stEarly = await query(
        `SELECT status, last_login_message FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const stNowEarly = String(stEarly.rows?.[0]?.status || '').toLowerCase();
      if (stNowEarly === 'failed') {
        return {
          resolved: true,
          status: 'failed',
          message: stEarly.rows?.[0]?.last_login_message || MT5_FAIL_USER_MSG
        };
      }
      if (stNowEarly === 'connected') {
        return { resolved: true, status: 'connected', source: 'journal_read_early' };
      }
    }
  }

  if (elapsedSec < 5) return { resolved: false };

  const verRowEarly = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const agentVerEarly = String(verRowEarly.rows?.[0]?.agent_version || '');
  const agentReadyEarly = hasJournalGateMarker(agentVerEarly);

  const cmdVerify = await verifyLoginFromCommand({
    accountId,
    vpsId,
    mt5Login: login,
    portNo
  }).catch(() => ({ ok: false }));

  if (cmdVerify.ok) {
    await promoteAccountConnected({
      accountId,
      portId,
      mt5Login: login,
      message: MT5_SUCCESS_MSG
    });
    return { resolved: true, status: 'connected', source: cmdVerify.source };
  }

  if (cmdVerify.reason === 'JOURNAL_FAILED') {
    await failAccountFromJournal(accountId, portId, MT5_FAIL_USER_MSG);
    return { resolved: true, status: 'failed', message: MT5_FAIL_USER_MSG };
  }

  const verRow = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const agentVer = String(verRow.rows?.[0]?.agent_version || '');
  const agentReady = hasJournalGateMarker(agentVer);

  if (agentReady && /รีสตาร์ท|Restart-Service/i.test(String(account.last_login_message || ''))) {
    await query(`
      UPDATE vps_system.mt5_accounts
      SET last_login_message='กำลังตรวจสอบ Login MT5 จาก Journal...', last_error=NULL, updated_at=NOW()
      WHERE id=$1
    `, [accountId]).catch(() => {});
  }

  const folderPath = account.folder_path || '';
  if (folderPath && elapsedSec >= 5) {
    await queueJournalReadVerify({
      accountId, vpsId, folderPath, mt5Login: login, portNo
    }).catch(() => {});
  }
  const applied2 = await tryApplyPendingJournalRead(accountId, vpsId).catch(() => false);
  if (applied2) {
    const stRow2 = await query(
      `SELECT status, last_login_message FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const stNow2 = String(stRow2.rows?.[0]?.status || '').toLowerCase();
    if (stNow2 === 'failed') {
      return {
        resolved: true,
        status: 'failed',
        message: stRow2.rows?.[0]?.last_login_message || MT5_FAIL_USER_MSG
      };
    }
    return { resolved: true, status: 'connected', source: 'journal_read' };
  }

  if (!agentReady) {
    await expireStuckMaintenanceCommands(vpsId).catch(() => {});
    const upgradeState = await getAgentUpgradeState(vpsId);

    if (elapsedSec >= 120) {
      const failMsg = messageForUpgradeState(upgradeState);
      await failAccountFromJournal(accountId, portId, failMsg, {
        vpsId,
        portNo,
        folderPath: account.folder_path || '',
        reason: 'connect_timeout'
      }).catch(() => {});
      return { resolved: true, status: 'failed', message: failMsg };
    }

    if (elapsedSec >= 25 && upgradeState !== 'ready') {
      const waitMsg = messageForUpgradeState(upgradeState);
      await query(`
        UPDATE vps_system.mt5_accounts
        SET last_login_message=$2, updated_at=NOW()
        WHERE id=$1 AND LOWER(COALESCE(status,'')) IN ('connecting','starting','checking')
      `, [accountId, waitMsg]).catch(() => {});
      return { resolved: false, message: waitMsg };
    }
  }

  if (agentReady && elapsedSec >= 12) {
    const inProg = await findLoginCommandInProgress(accountId, vpsId);
    const recent = await findRecentLoginCommand(accountId, vpsId);
    const recentSt = String(recent?.status || '').toLowerCase();
    if (!inProg && (!recent || recentSt === 'cancelled')) {
      const accRow = await query(
        `
        SELECT a.user_id, a.mt5_password, a.server_name, a.mt5_server, a.port_slot, p.folder_path
        FROM vps_system.mt5_accounts a
        LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
        WHERE a.id=$1
        LIMIT 1
      `,
        [accountId]
      ).catch(() => ({ rows: [] }));
      const ar = accRow.rows?.[0];
      if (ar?.mt5_password) {
        const payload = buildMt5LoginPayload({
          accountId,
          userId: ar.user_id,
          reservedPort: {
            vps_id: vpsId,
            port_id: portId,
            port_number: portNo,
            folder_path: account.folder_path || ar.folder_path
          },
          portSlot: account.port_slot || ar.port_slot,
          mt5Login: login,
          mt5Password: ar.mt5_password,
          serverName: ar.server_name || ar.mt5_server
        });
        await query(
          `
          INSERT INTO vps_system.vps_agent_commands
          (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
          VALUES ($1,$1,$2,'login_mt5',$3::jsonb,'pending',NOW(),NOW())
        `,
          [vpsId, portId, JSON.stringify(payload)]
        ).catch(() => {});
      }
    }
  }

  const readCount = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.vps_agent_commands
    WHERE (vps_id=$1 OR node_id=$1)
      AND command_type IN ('read_file', 'port_read_file')
      AND (payload->>'accountId')::text = $2::text
      AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
      AND status IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '10 minutes'
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [{ c: 0 }] }));
  const readsDone = Number(readCount.rows?.[0]?.c || 0);

  if (elapsedSec >= 90 && cmdVerify.reason === 'JOURNAL_REQUIRED') {
    const failMsg = readsDone >= 2 && !hasJournalGateMarker(agentVer)
      ? 'Agent บน VPS ยังเป็นเวอร์ชันเก่า — รัน Restart-Service AvelquaPythonAgent แล้วลองใหม่'
      : 'ไม่สามารถยืนยัน Login จาก MT5 ได้ทันเวลา กรุณาลองใหม่';
    await failAccountFromJournal(accountId, portId, failMsg, {
      vpsId,
      portNo,
      folderPath: account.folder_path || '',
      reason: 'journal_verify_timeout'
    }).catch(() => {});
    return { resolved: true, status: 'failed', message: failMsg };
  }

  return { resolved: false };
}

/** เคลียร์ PORT แพ็กเกจที่ค้างจาก login ผิดก่อนหน้า */
async function repairFailedAccountsHoldingSlots(userId) {
  if (!userId) return;
  const rows = await query(
    `
    SELECT a.id, a.port_id, a.vps_id, a.assigned_port_no, a.windows_port_no,
           a.last_error, COALESCE(p.folder_path, '') AS folder_path
    FROM vps_system.mt5_accounts a
    LEFT JOIN vps_system.vps_ports p ON p.id = a.port_id
    WHERE a.user_id=$1
      AND a.port_slot IS NOT NULL
      AND LOWER(TRIM(COALESCE(a.status, ''))) = 'failed'
  `,
    [userId]
  ).catch(() => ({ rows: [] }));

  for (const row of rows.rows || []) {
    await failAccountFromJournal(Number(row.id), Number(row.port_id || 0), row.last_error, {
      vpsId: row.vps_id,
      portNo: row.assigned_port_no || row.windows_port_no,
      folderPath: row.folder_path,
      reason: 'repair_failed_slot'
    }).catch(() => {});
  }
}

module.exports = {
  findRecentLoginCommand,
  findLoginCommandInProgress,
  extractJournalEvidence,
  verifyPortRunningLogin,
  verifyLoginFromCommand,
  applyLoginMt5FromCommandResult,
  applyLoginMt5CommandFailed,
  applyJournalReadCommandResult,
  queueJournalReadVerify,
  tryApplyPendingJournalRead,
  syncJournalFromLatestCommand,
  handleLegacyWindowVerifiedConnect,
  isLegacyWindowVerifiedMessage,
  promoteAccountConnected,
  restoreAccountVpsBindingFromLatestLogin,
  queueStopMt5ForAccount,
  failAccountFromJournal,
  repairFailedAccountsHoldingSlots,
  resolveStuckLoginAccount
};
