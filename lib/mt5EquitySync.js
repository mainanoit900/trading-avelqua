'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const { hasRunBotMarker } = require('./agentDeploy');
const { folderPathForPortNo } = require('./mt5AccountPort');

const EQUITY_MQ5_PATH = path.join(process.cwd(), 'public/agent/mql5/AvelquaEquityPulse.mq5');

function positiveMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseMoneyToken(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/\s/g, '').replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseMetricsFromLogText(text) {
  const out = { balance: null, equity: null, profit: null, currency: '' };
  if (!text || typeof text !== 'string') return out;
  const raw = String(text);
  const balPats = [
    /balance\s*[:=]\s*([0-9][0-9,.\s]*)/gi,
    /previous\s+balance[:\s]+([0-9][0-9,.\s]*)/gi,
    /new\s+balance[:\s]+([0-9][0-9,.\s]*)/gi
  ];
  const eqPats = [/equity\s*[:=]\s*([0-9][0-9,.\s]*)/gi, /account\s+equity[:\s]+([0-9][0-9,.\s]*)/gi];
  const profitPats = [
    /(?:total\s+)?(?:floating\s+)?profit\s*[:=]\s*(-?[0-9][0-9,.\s]*)/gi,
    /profit\/loss\s*[:=]\s*(-?[0-9][0-9,.\s]*)/gi
  ];
  let m;
  for (const pat of balPats) {
    let last = null;
    while ((m = pat.exec(raw)) !== null) last = m[1];
    if (last) out.balance = positiveMoney(parseMoneyToken(last));
  }
  for (const pat of eqPats) {
    let last = null;
    while ((m = pat.exec(raw)) !== null) last = m[1];
    if (last) out.equity = positiveMoney(parseMoneyToken(last));
  }
  for (const pat of profitPats) {
    let last = null;
    while ((m = pat.exec(raw)) !== null) last = m[1];
    if (last) out.profit = parseMoneyToken(last);
  }
  if (out.equity == null && out.balance != null && out.profit != null) {
    const eq = Math.round((out.balance + out.profit) * 100) / 100;
    if (eq > 0) out.equity = eq;
  }
  return out;
}

function parseEquityFileContent(text) {
  const out = { balance: null, equity: null, profit: null, currency: '' };
  if (!text) return out;

  const raw = String(text);
  try {
    if (raw.trim().startsWith('{')) {
      const data = JSON.parse(raw);
      out.balance = positiveMoney(data.balance);
      out.equity = positiveMoney(data.equity);
      out.currency = String(data.currency || '');
      return out;
    }
  } catch (_) {}

  const kv = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    kv[k.trim().toLowerCase()] = rest.join('=').trim();
  }
  out.balance = positiveMoney(parseMoneyToken(kv.balance));
  out.equity = positiveMoney(parseMoneyToken(kv.equity));
  out.profit = parseMoneyToken(kv.profit);
  out.currency = String(kv.currency || '').toUpperCase();
  if (out.equity == null && out.balance != null && out.profit != null) {
    out.equity = Math.round((out.balance + out.profit) * 100) / 100;
    if (out.equity <= 0) out.equity = null;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function applyEquityToAccount(accountId, balance, equity) {
  const bal = positiveMoney(balance);
  const eq = positiveMoney(equity);
  if (!bal && !eq) return false;
  await query(
    `
    UPDATE vps_system.mt5_accounts
    SET last_balance = COALESCE($2::numeric, last_balance),
        last_equity = COALESCE($3::numeric, last_equity),
        last_seen_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `,
    [accountId, bal, eq]
  );
  return !!(bal || eq);
}

async function waitCommandResult(commandId, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await query(
      `SELECT status, result, error, result_message FROM vps_system.vps_agent_commands WHERE id=$1 LIMIT 1`,
      [commandId]
    );
    const row = r.rows?.[0];
    if (!row) return null;
    const st = String(row.status || '').toLowerCase();
    if (['success', 'failed', 'cancelled', 'done'].includes(st)) return row;
    await sleep(450);
  }
  return null;
}

function equityFilePaths(ctx) {
  const base = String(ctx.folderPath || '').replace(/[\\/]+$/, '');
  const rel = 'MQL5\\Files\\avelqua_account.txt';
  const abs = base ? `${base}\\${rel}` : rel;
  return { abs, rel };
}

function baseEquityPayload(ctx, accountId, userId, filePath, purpose = 'equity_sync') {
  const portName = `VPS-WIN-01-PORT-${String(ctx.portNo || 1).padStart(2, '0')}`;
  return {
    port: ctx.portNo,
    portNumber: ctx.portNo,
    portSlot: ctx.portSlot,
    vpsPortName: portName,
    vpsFolderPath: ctx.folderPath,
    folder_path: ctx.folderPath,
    file_path: filePath,
    filename: String(filePath || '').split(/[\\/]/).pop() || filePath,
    accountId: Number(accountId),
    userId: Number(userId),
    purpose
  };
}

async function queuePortReadFile(vpsId, ctx, accountId, userId, filePath, purpose = 'equity_sync') {
  const ins = await query(
    `
    INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'port_read_file', $2::jsonb, 'pending', NOW(), NOW())
    RETURNING id
  `,
    [vpsId, JSON.stringify(baseEquityPayload(ctx, accountId, userId, filePath, purpose))]
  );
  return Number(ins.rows?.[0]?.id || 0);
}

async function queueReadEquityFile(vpsId, ctx, accountId, userId, purpose = 'equity_sync') {
  const { rel } = equityFilePaths(ctx);
  const portReadId = await queuePortReadFile(vpsId, ctx, accountId, userId, rel, purpose || 'equity_sync');
  return { readId: 0, portReadId };
}

function mt5LogDateCandidates(maxDays = 1) {
  const out = [];
  const tz = 'Asia/Bangkok';
  const days = Math.max(1, Math.min(4, Number(maxDays) || 1));
  for (let d = 0; d < days; d += 1) {
    const t = new Date(Date.now() - d * 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(t);
    const y = parts.find((p) => p.type === 'year')?.value;
    const mo = parts.find((p) => p.type === 'month')?.value;
    const da = parts.find((p) => p.type === 'day')?.value;
    if (y && mo && da) out.push(`${y}${mo}${da}`);
  }
  return [...new Set(out)];
}

async function queueReadMt5JournalLogs(vpsId, ctx, accountId, userId, maxDays = 1) {
  const ids = [];
  const relPaths = [];
  for (const stamp of mt5LogDateCandidates(maxDays)) {
    // MT5 portable ส่วนใหญ่ log จริงอยู่ที่ logs\YYYYMMDD.log
    // ลดการยิงไป MQL5\Logs ที่มักไม่มีไฟล์ ทำให้ Agent ขึ้น file not found
    relPaths.push(`logs\\${stamp}.log`);
  }
  for (const rel of relPaths) {
    const id = await queuePortReadFile(vpsId, ctx, accountId, userId, rel, 'equity_sync_journal');
    if (id) ids.push(id);
  }
  return ids;
}

async function queueDeployEquityIndicator(vpsId, ctx) {
  if (!fs.existsSync(EQUITY_MQ5_PATH)) return 0;
  const content = fs.readFileSync(EQUITY_MQ5_PATH, 'utf8');
  const payload = {
    port: ctx.portNo,
    portNumber: ctx.portNo,
    vpsFolderPath: ctx.folderPath,
    folder_path: ctx.folderPath,
    file_path: 'MQL5\\Indicators\\AvelquaEquityPulse.mq5',
    filename: 'AvelquaEquityPulse.mq5',
    content,
    purpose: 'deploy_equity_indicator'
  };
  const ins = await query(
    `
    INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    SELECT $1, $1, 'port_write_file', $2::jsonb, 'pending', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM vps_system.vps_agent_commands
      WHERE vps_id=$1 AND command_type='port_write_file'
        AND COALESCE(payload->>'purpose','')='deploy_equity_indicator'
        AND COALESCE(payload->>'portNumber','')=$3
        AND created_at > NOW() - INTERVAL '1 hour'
    )
    RETURNING id
  `,
    [vpsId, JSON.stringify(payload), String(ctx.portNo)]
  );
  return Number(ins.rows?.[0]?.id || 0);
}

async function queueSyncMt5Account(vpsId, payload, opts = {}) {
  return queueAccountSnapshot(vpsId, payload, opts);
}

/** Agent เก่าใช้ dashboard+equitySnapshot; รุ่น equity-dashboard ใช้ account_snapshot */
function equityCommandTypeForAgent(agentVersion) {
  const ver = String(agentVersion || '').trim();
  if (ver.includes('equity-dashboard-v30') || ver.includes('equity-dashboard-v29')) {
    return 'account_snapshot';
  }
  if (ver.includes('equity-dashboard') || ver.includes('equity-push')) {
    return 'account_snapshot';
  }
  return 'dashboard';
}

async function resolvePortIdForEquityPayload(vpsId, payload) {
  const pid = Number(payload?.portId || payload?.port_id || 0);
  if (pid) return pid;
  const portNo = Number(payload?.port || payload?.portSlot || payload?.portNumber || 0);
  if (!vpsId || !portNo) return null;
  const r = await query(
    `
    SELECT id FROM vps_system.vps_ports
    WHERE vps_id = $1 AND port_no IN ($2, $3)
    ORDER BY CASE WHEN port_no = $2 THEN 0 ELSE 1 END
    LIMIT 1
  `,
    [vpsId, portNo, 100 + portNo]
  ).catch(() => ({ rows: [] }));
  return Number(r.rows?.[0]?.id || 0) || null;
}

/** ยกเลิก equity snapshot ค้าง (กันบล็อก login_mt5) */
async function cancelPendingEquitySnapshots(vpsId, opts = {}) {
  const nid = Number(vpsId || 0);
  if (!nid) return 0;
  const accountId = opts.accountId != null ? String(opts.accountId) : '';
  const r = await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'cancelled',
        result_message = COALESCE(result_message, 'cancelled: stale equity snapshot'),
        updated_at = NOW()
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN (
        'account_snapshot', 'sync_mt5_account', 'read_account_metrics', 'dashboard', 'watchdog'
      )
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running')
      AND ($2::text = '' OR COALESCE(payload->>'accountId', '') = $2)
    RETURNING id
  `,
    [nid, accountId]
  ).catch(() => ({ rows: [] }));
  return r.rows?.length || 0;
}

/** อ่าน Balance/Equity จาก MT5 ที่เปิดอยู่ (UIA) — เร็วกว่า sync เต็ม */
async function queueAccountSnapshot(vpsId, payload, opts = {}) {
  const accountId = Number(payload?.accountId || payload?.account_id || 0);
  if (accountId) {
    const stRow = await query(
      `SELECT LOWER(TRIM(COALESCE(status, ''))) AS st FROM vps_system.mt5_accounts WHERE id=$1 LIMIT 1`,
      [accountId]
    ).catch(() => ({ rows: [] }));
    const st = String(stRow.rows?.[0]?.st || '');
    if (!st || st === 'deleted' || st === 'expired') return 0;
  }

  let agentVersion = opts.agentVersion;
  if (!agentVersion && vpsId) {
    const verRow = await query(
      `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
      [vpsId]
    ).catch(() => ({ rows: [] }));
    agentVersion = verRow.rows?.[0]?.agent_version || '';
  }
  const cmdType = opts.commandType || equityCommandTypeForAgent(agentVersion);
  const instanceId = String(payload?.instanceId || payload?.instance_id || '');
  if (vpsId && instanceId) {
    const recent = await hasRecentMetricsSync(vpsId, instanceId, opts.withinSec || 25);
    if (recent) return 0;
  }
  const pend = await query(
    `
    SELECT COUNT(*)::int AS n
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND LOWER(COALESCE(status,'')) = 'pending'
      AND command_type IN ('dashboard','account_snapshot','sync_mt5_account','read_account_metrics')
  `,
    [vpsId]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  if (Number(pend.rows?.[0]?.n || 0) >= 6) {
    return 0;
  }
  const useDashboard = cmdType === 'dashboard';
  const body = {
    ...(payload || {}),
    purpose: payload?.purpose || 'equity_sync',
    action: useDashboard ? 'dashboard' : 'account_snapshot',
    equitySnapshot: useDashboard,
    vpsFolderPath: payload?.vpsFolderPath || payload?.folder_path || payload?.folderPath,
    folder_path: payload?.folder_path || payload?.vpsFolderPath || payload?.folderPath
  };
  const portId = await resolvePortIdForEquityPayload(vpsId, payload);
  const ins = await query(
    `
    INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, port_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, $2, $3, $4::jsonb, 'pending', NOW(), NOW())
    RETURNING id
  `,
    [vpsId, portId, cmdType, JSON.stringify(body)]
  );
  return Number(ins.rows?.[0]?.id || 0);
}

function metricsFromSnapshotResult(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.snapshot && typeof result.snapshot === 'object') {
    const nested = metricsFromSnapshotResult(result.snapshot);
    if (nested && (nested.balance || nested.equity)) return nested;
  }
  if (result.metrics && typeof result.metrics === 'object') {
    const nested = metricsFromSnapshotResult(result.metrics);
    if (nested && (nested.balance || nested.equity)) return nested;
  }
  const bal = positiveMoney(result.balance);
  const eq = positiveMoney(result.equity);
  let profit = result.profit != null && result.profit !== '' ? Number(result.profit) : null;
  if (!Number.isFinite(profit) && bal != null && eq != null) {
    profit = Math.round((eq - bal) * 100) / 100;
  }
  if (!bal && !eq) return null;
  return { balance: bal, equity: eq, profit: Number.isFinite(profit) ? profit : null, currency: result.currency || '' };
}

async function hasRecentMetricsSync(vpsId, instanceId, withinSec = 18) {
  const r = await query(
    `
    SELECT 1
    FROM vps_system.vps_agent_commands
    WHERE vps_id = $1
      AND command_type IN ('sync_mt5_account', 'read_account_metrics', 'account_snapshot', 'dashboard', 'watchdog')
      AND COALESCE(payload->>'instanceId', '') = $2
      AND created_at > NOW() - ($3::text || ' seconds')::interval
    LIMIT 1
  `,
    [vpsId, String(instanceId), String(withinSec)]
  ).catch(() => ({ rows: [] }));
  return !!r.rows?.length;
}

async function queueDashboard(vpsId) {
  const ins = await query(
    `
    INSERT INTO vps_system.vps_agent_commands (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'dashboard', '{}'::jsonb, 'pending', NOW(), NOW())
    RETURNING id
  `,
    [vpsId]
  );
  return Number(ins.rows?.[0]?.id || 0);
}

function metricsFromCommandResult(result, portNo, folderPath) {
  if (!result || typeof result !== 'object') return null;
  if (result.found === false) return null;
  const direct = metricsFromSnapshotResult(result);
  if (direct && (direct.balance || direct.equity)) return direct;
  const content = result.content;
  if (typeof content === 'string' && content.trim()) {
    const parsed = parseEquityFileContent(content);
    if (parsed.balance || parsed.equity) return parsed;
    const fromLog = parseMetricsFromLogText(content);
    if (fromLog.balance || fromLog.equity) return fromLog;
  }
  const ports = result.ports;
  if (Array.isArray(ports)) {
    const folderNorm = String(folderPath || '')
      .trim()
      .toLowerCase()
      .replace(/\\/g, '/');
    let p = null;
    if (folderNorm) {
      p = ports.find((x) => {
        const path = String(x.path || '')
          .toLowerCase()
          .replace(/\\/g, '/');
        return path && (path === folderNorm || path.includes(folderNorm) || folderNorm.includes(path));
      });
    }
    if (!p) {
      p =
        ports.find(
          (x) => Number(x.portNumber || x.port) === Number(portNo) && x.running
        ) || ports.find((x) => Number(x.portNumber || x.port) === Number(portNo));
    }
    if (p) {
      return {
        balance: positiveMoney(p.balance),
        equity: positiveMoney(p.equity),
        profit: null,
        currency: ''
      };
    }
  }
  return null;
}

/**
 * ดึง Balance/Equity จาก VPS ผ่านคำสั่งที่ Agent รุ่นเก่ารองรับ (port_read_file, dashboard)
 */
function buildSyncPayload(ctx, accountId, userId) {
  const portNo = Number(ctx.portNo || ctx.assigned_port_no || 0);
  const portSlot = Number(ctx.portSlot || 0);
  const folder = String(ctx.folderPath || '').trim() || folderPathForPortNo(portNo, '');
  return {
    port: portNo,
    portNumber: portNo,
    portSlot: portSlot || portNo,
    accountId: Number(accountId),
    userId: Number(userId),
    vpsFolderPath: folder,
    folder_path: folder,
    vpsPortName: `VPS-WIN-01-PORT-${String(portNo).padStart(2, '0')}`
  };
}

async function applyEquityFromPortHealthDb(vpsId, portNo, accountId, mt5Login) {
  const port = Number(portNo || 0);
  const nid = Number(vpsId || 0);
  if (!nid || !port) return null;
  const r = await query(
    `
    SELECT balance, equity, mt5_login, updated_at
    FROM vps_system.vps_port_health
    WHERE node_id = $1 AND port_number = $2
      AND updated_at > NOW() - INTERVAL '3 minutes'
    LIMIT 1
  `,
    [nid, port]
  ).catch(() => ({ rows: [] }));
  const row = r.rows?.[0];
  if (!row) return null;
  const login = String(mt5Login || '').trim();
  if (login && row.mt5_login && String(row.mt5_login) !== login) return null;
  const bal = positiveMoney(row.balance);
  const eq = positiveMoney(row.equity);
  if (!bal && !eq) return null;
  if (accountId) await applyEquityToAccount(accountId, bal, eq);
  return { balance: bal, equity: eq, source: 'port_health_db' };
}

async function cancelPendingEquityFileReads(vpsId) {
  if (!vpsId) return 0;
  const r = await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'cancelled',
        result_message = COALESCE(result_message, 'cancelled: equity uses account_snapshot'),
        updated_at = NOW()
    WHERE vps_id = $1
      AND command_type = 'port_read_file'
      AND COALESCE(payload->>'purpose', '') IN ('equity_sync', 'equity_connect', 'equity_poller')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running')
    RETURNING id
  `,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  return r.rows?.length || 0;
}

async function fetchEquityLight(ctx, accountId, userId, options = {}) {
  const waitMs = Number(options.waitMs || 0);
  const vpsId = Number(ctx.vpsId || 0);
  if (!vpsId || !accountId) return { ok: false, reason: 'NO_VPS' };

  const fromHealth = await applyEquityFromPortHealthDb(
    vpsId,
    ctx.portNo,
    accountId,
    ctx.mt5Login || ctx.account?.mt5_login
  ).catch(() => null);
  if (fromHealth && (fromHealth.balance || fromHealth.equity)) {
    return { ok: true, ...fromHealth };
  }

  const purpose = options.purpose || 'equity_sync';
  const syncPayload = {
    ...buildSyncPayload(ctx, accountId, userId),
    purpose,
    mt5Login: ctx.mt5Login || ctx.account?.mt5_login || ''
  };

  const recent = await query(
    `
    SELECT result
    FROM vps_system.vps_agent_commands
    WHERE vps_id = $1
      AND command_type IN ('account_snapshot', 'sync_mt5_account')
      AND COALESCE(payload->>'accountId', '') = $2
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '90 seconds'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId, String(accountId)]
  ).catch(() => ({ rows: [] }));

  let metrics = metricsFromSnapshotResult(recent.rows?.[0]?.result);
  if (!metrics || (!metrics.balance && !metrics.equity)) {
    metrics = metricsFromCommandResult(recent.rows?.[0]?.result, ctx.portNo, ctx.folderPath);
  }
  if (metrics && (metrics.balance || metrics.equity)) {
    await applyEquityToAccount(accountId, metrics.balance, metrics.equity);
    return { ok: true, ...metrics, source: 'recent_snapshot' };
  }

  await cancelPendingEquityFileReads(vpsId).catch(() => 0);

  const cmdId = await queueAccountSnapshot(vpsId, syncPayload, {
    commandType: 'account_snapshot'
  }).catch(() => 0);
  if (!cmdId) return { ok: false, reason: 'QUEUE_BUSY' };

  if (waitMs <= 0) {
    return { ok: false, reason: 'QUEUED', syncCommandId: cmdId };
  }

  const row = await waitCommandResult(cmdId, Math.min(waitMs, 12000));
  if (row && ['success', 'done'].includes(String(row.status || '').toLowerCase())) {
    metrics = metricsFromSnapshotResult(row.result);
    if (!metrics || (!metrics.balance && !metrics.equity)) {
      metrics = metricsFromCommandResult(row.result, ctx.portNo, ctx.folderPath);
    }
    if (metrics && (metrics.balance || metrics.equity)) {
      await applyEquityToAccount(accountId, metrics.balance, metrics.equity);
      return { ok: true, ...metrics, source: 'account_snapshot' };
    }
  }

  const journal = await fetchEquityFromJournal(ctx, accountId, userId, {
    waitMs: Math.min(waitMs, 10000)
  }).catch(() => ({ ok: false }));
  if (journal?.ok) return journal;

  return { ok: false, reason: 'NO_DATA', syncCommandId: cmdId };
}

async function fetchEquityFromJournal(ctx, accountId, userId, options = {}) {
  const waitMs = Number(options.waitMs || 8000);
  const vpsId = Number(ctx.vpsId || 0);
  if (!vpsId || !accountId) return { ok: false, reason: 'NO_VPS' };

  const journalIds = await queueReadMt5JournalLogs(vpsId, ctx, accountId, userId, 2).catch(() => []);
  if (!journalIds.length) return { ok: false, reason: 'NO_JOURNAL_QUEUE' };

  const perCmd = Math.max(4000, Math.floor(waitMs / Math.max(journalIds.length, 1)));
  for (const cmdId of journalIds) {
    const row = await waitCommandResult(cmdId, perCmd);
    if (!row || !['success', 'done'].includes(String(row.status || '').toLowerCase())) continue;
    const content =
      row.result?.content ||
      row.result?.journalEvidence ||
      (typeof row.result === 'string' ? row.result : '');
    const metrics = parseMetricsFromLogText(String(content || ''));
    if (metrics.balance || metrics.equity) {
      await applyEquityToAccount(accountId, metrics.balance, metrics.equity);
      return { ok: true, ...metrics, source: 'journal_log' };
    }
  }
  return { ok: false, reason: 'NO_JOURNAL_METRICS' };
}

async function fetchEquityFromVps(ctx, accountId, userId, options = {}) {
  const waitMs = Number(options.waitMs || 12000);
  const skipJournal = options.skipJournal === true;
  const light = options.light === true;
  const vpsId = Number(ctx.vpsId || 0);
  if (!vpsId || !accountId) return { ok: false, reason: 'NO_VPS' };

  if (light) {
    return fetchEquityLight(ctx, accountId, userId, options);
  }

  const syncPayload = buildSyncPayload(ctx, accountId, userId);
  syncPayload.mt5Login = ctx.mt5Login || ctx.account?.mt5_login || syncPayload.mt5Login;

  const lightFirst = await fetchEquityLight(ctx, accountId, userId, {
    waitMs: Math.min(waitMs, 4500),
    skipJournal: true,
    purpose: options.purpose
  });
  if (lightFirst.ok) return lightFirst;
  if (waitMs <= 0) return lightFirst;

  const snapWait = Math.min(Math.max(waitMs, 2500), 6000);
  const snapCmdId = await queueAccountSnapshot(vpsId, syncPayload).catch(() => 0);
  if (snapCmdId && waitMs > 0) {
    const snapRow = await waitCommandResult(snapCmdId, snapWait);
    if (snapRow && ['success', 'done'].includes(String(snapRow.status || '').toLowerCase())) {
      const metrics = metricsFromSnapshotResult(snapRow.result);
      if (metrics && (metrics.balance || metrics.equity)) {
        await applyEquityToAccount(accountId, metrics.balance, metrics.equity);
        return { ok: true, ...metrics, source: 'account_snapshot' };
      }
    }
  }

  const syncId = await queueSyncMt5Account(vpsId, syncPayload).catch(() => 0);

  if (waitMs <= 0) {
    return { ok: false, reason: 'QUEUED', syncCommandId: syncId };
  }

  if (syncId) {
    const syncRow = await waitCommandResult(syncId, Math.min(waitMs, 10000));
    if (syncRow && ['success', 'done'].includes(String(syncRow.status || '').toLowerCase())) {
      const snap = syncRow.result || {};
      const bal = positiveMoney(snap.balance);
      const eq = positiveMoney(snap.equity);
      if (bal || eq) {
        await applyEquityToAccount(accountId, bal, eq);
        return { ok: true, balance: bal, equity: eq, source: 'sync_mt5_account' };
      }
    }
  }

  const dashId = await queueDashboard(vpsId);
  if (dashId) {
    const row = await waitCommandResult(dashId, Math.min(waitMs, 10000));
    if (row && ['success', 'done'].includes(String(row.status || '').toLowerCase())) {
      metrics = metricsFromCommandResult(row.result, ctx.portNo, ctx.folderPath);
      if (metrics && (metrics.balance || metrics.equity)) {
        await applyEquityToAccount(accountId, metrics.balance, metrics.equity);
        return { ok: true, ...metrics, source: 'dashboard' };
      }
    }
  }

  await queueDeployEquityIndicator(vpsId, ctx).catch(() => 0);
  return {
    ok: false,
    reason: 'NO_DATA',
    hint:
      'ดู Balance/Equity ที่แถบล่าง MT5 แล้วใส่ในช่อง「เงินทุน」ด้านล่าง หรือแนบ Indicator AvelquaEquityPulse บนชาร์ท'
  };
}

async function applyEquityFromCommandResult(accountId, result) {
  const metrics = metricsFromCommandResult(result, null);
  if (!metrics) return false;
  return applyEquityToAccount(accountId, metrics.balance, metrics.equity);
}

/** คิวดึง equity เบาๆ หลัง login — ไม่รอบล็อก HTTP */
async function ensureEquityOnConnect(accountId, userId, loadCtx, options = {}) {
  if (!accountId || !userId) return { ok: false, reason: 'MISSING' };
  const row = await query(
    `SELECT last_balance, last_equity FROM vps_system.mt5_accounts WHERE id=$1 AND user_id=$2 LIMIT 1`,
    [accountId, userId]
  ).catch(() => ({ rows: [] }));
  const acc = row.rows?.[0];
  if (positiveMoney(acc?.last_equity)) {
    return {
      ok: true,
      balance: positiveMoney(acc.last_balance),
      equity: positiveMoney(acc.last_equity),
      source: 'db'
    };
  }
  const ctx = typeof loadCtx === 'function' ? await loadCtx(accountId, userId) : loadCtx;
  if (!ctx?.vpsId) return { ok: false, reason: 'NO_CTX' };
  fetchEquityFromVps(ctx, accountId, userId, {
    waitMs: 0,
    skipJournal: true,
    light: true,
    purpose: 'equity_connect'
  }).catch(() => {});
  return { ok: false, reason: 'QUEUED' };
}

module.exports = {
  positiveMoney,
  parseEquityFileContent,
  parseMetricsFromLogText,
  applyEquityToAccount,
  fetchEquityFromVps,
  fetchEquityLight,
  queueAccountSnapshot,
  metricsFromSnapshotResult,
  applyEquityFromCommandResult,
  applyEquityFromPortHealthDb,
  metricsFromCommandResult,
  queueSyncMt5Account,
  hasRecentMetricsSync,
  ensureEquityOnConnect,
  buildSyncPayload,
  cancelPendingEquityFileReads,
  cancelPendingEquitySnapshots,
  fetchEquityFromJournal
};
