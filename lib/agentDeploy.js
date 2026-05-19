'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');

const REQUIRED_AGENT_VERSION =
  process.env.AVELQUA_REQUIRED_AGENT_VERSION || '2026-05-19-equity-dashboard-v30';
/** ห่างกันอย่างน้อย N นาทีก่อนคิว deploy_agent ซ้ำ (กันอัปเดตบน VPS ถี่เกินไป) */
const AGENT_DEPLOY_MIN_INTERVAL_MINUTES = Number(
  process.env.AGENT_DEPLOY_MIN_INTERVAL_MINUTES || 120
);
const HEARTBEAT_DEPLOY_MIN_INTERVAL_MINUTES = Number(
  process.env.AGENT_HEARTBEAT_DEPLOY_MIN_MINUTES || AGENT_DEPLOY_MIN_INTERVAL_MINUTES
);
const heartbeatDeployAt = new Map();
const AGENT_SCRIPT_PATH = path.join(process.cwd(), 'public/agent/agent.py');

function hasJournalGateMarker(versionOrBuild) {
  const v = String(versionOrBuild || '').trim();
  if (!v) return false;
  if (v === REQUIRED_AGENT_VERSION) return true;
  return v.includes('journal-gate') || v.includes('agent-perf');
}

/** Agent รองรับ run_bot_command / restart_ea บน PORT เดิม */
function hasRunBotMarker(versionOrBuild) {
  const v = String(versionOrBuild || '').trim();
  if (!v) return false;
  if (v === REQUIRED_AGENT_VERSION) return true;
  return (
    v.includes('run-bot') ||
    v.includes('mt5-run-bot') ||
    v.includes('mt5-algo-live-v21') ||
    v.includes('login-no-trade') ||
    v.includes('fast-login') ||
    v.includes('login-quiet') ||
    v.includes('metrics-sync') ||
    v.includes('agent-quiet') ||
    v.includes('login-gate') ||
    v.includes('login-fast') ||
    v.includes('stop-bot-soft') ||
    v.includes('run-bot-hot') ||
    v.includes('equity-live') ||
    v.includes('equity-push') ||
    v.includes('equity-dashboard') ||
    v.includes('early-connect') ||
    v.includes('algo-live')
  );
}

const BOT_ACTIVE_STATUSES = ['running', 'pending', 'restarting', 'starting'];

function isActiveBotInstance(inst) {
  return BOT_ACTIVE_STATUSES.includes(String(inst?.status || '').toLowerCase());
}

/**
 * ข้อความแจ้ง Agent บน Live Dashboard — แสดงเฉพาะเมื่อมี BOT รันอยู่และ Agent ยังไม่พร้อมจริง
 * (ไม่แสดงเมื่อ BOT หยุดหมดแล้ว หรือ VPS รายงานเวอร์ชัน v21 แล้ว)
 */
async function getPendingAgentMaintenance(vpsId) {
  const r = await query(
    `
    SELECT id, command_type, status, created_at
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'queued', 'picked', 'processing', 'running')
      AND created_at > NOW() - INTERVAL '12 minutes'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  return r.rows?.[0] || null;
}

async function queueAgentRestart(vpsId, opts = {}) {
  const nid = Number(vpsId || 0);
  const force = opts.force === true;
  if (!nid) return { queued: false, reason: 'NO_NODE_ID' };

  if (force) {
    await expireStuckMaintenanceCommands(nid);
  }

  const pending = await getPendingAgentMaintenance(nid);
  if (!force && pending) return { queued: false, reason: 'ALREADY_PENDING' };

  if (force && pending && String(pending.command_type || '') === 'restart_agent') {
    return { queued: false, reason: 'RESTART_ALREADY_PENDING' };
  }

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'restart_agent', '{"service_name":"AvelquaPythonAgent","force":true}'::jsonb, 'pending', NOW(), NOW())
  `,
    [nid]
  ).catch(() => {});

  return { queued: true };
}

/**
 * คิว deploy/restart อัตโนมัติเมื่อ Agent เก่า — ลดข้อความแดงซ้ำบนหน้าเว็บ
 */
async function ensureAgentMaintenance(vpsId, opts = {}) {
  const nid = Number(vpsId || 0);
  if (!nid) return { state: 'legacy', notice: null, maintenancePending: false };

  await expireStuckMaintenanceCommands(nid);

  const verRow = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [nid]
  ).catch(() => ({ rows: [] }));
  const ver = String(verRow.rows?.[0]?.agent_version || '');
  if (hasRunBotMarker(ver)) {
    return { state: 'ready', notice: null, maintenancePending: false, version: ver };
  }

  const pending = await getPendingAgentMaintenance(nid);
  if (pending) {
    return {
      state: 'deploying',
      notice: null,
      maintenancePending: true,
      pendingType: pending.command_type
    };
  }

  let state = await getAgentUpgradeState(nid);

  if (state === 'stuck') {
    return {
      state: 'stuck',
      notice: null,
      maintenancePending: false,
      version: ver,
      recovering: true
    };
  }

  if (state === 'needs_restart') {
    await pruneMetricsCommandBacklog(nid, { keep: 1 }).catch(() => {});
    const q = await queueAgentDeploy(nid, { force: false, restart: false }).catch(() => ({ queued: false }));
    return {
      state: 'deploying',
      notice: null,
      maintenancePending: true,
      queued: !!q.queued,
      version: ver,
      recovering: false
    };
  }

  if (state === 'legacy') {
    const q = await queueAgentDeploy(nid, { force: opts.force === true });
    return {
      state: q.queued ? 'deploying' : state,
      notice: null,
      maintenancePending: !!q.queued,
      queued: !!q.queued
    };
  }

  if (state === 'deploying') {
    return { state: 'deploying', notice: null, maintenancePending: true };
  }

  return { state, notice: null, maintenancePending: false, version: ver };
}

/** ข้อความเดียวสำหรับ Live Dashboard (ไม่ซ้ำกับ diagnostics) */
async function resolveLiveDashboardAgentNotice(instances) {
  const active = (instances || []).filter(isActiveBotInstance);
  if (!active.length) return { notice: null, queueDeploy: false };

  const vpsIds = [...new Set(active.map((i) => Number(i.vps_id || 0)).filter((id) => id > 0))];

  for (const vpsId of vpsIds) {
    const maint = await ensureAgentMaintenance(vpsId);
    if (maint.state === 'ready') continue;
    if (maint.state === 'stuck' || maint.recovering) {
      await ensureAgentMaintenance(vpsId, { force: true }).catch(() => {});
      return { notice: null, queueDeploy: false, maintenancePending: true };
    }
    if (maint.maintenancePending) {
      return { notice: null, queueDeploy: false, maintenancePending: true };
    }
    const cmdErr = active.some(
      (i) =>
        Number(i.vps_id) === vpsId &&
        String(i.last_error || '').includes('Unknown command_type')
    );
    if (cmdErr || maint.state === 'legacy') {
      await ensureAgentMaintenance(vpsId, { force: true }).catch(() => {});
      return { notice: null, queueDeploy: true, maintenancePending: true };
    }
  }

  return { notice: null, queueDeploy: false };
}

/** Agent พร้อมใช้ Login + Run BOT + sync Equity */
function hasAgentCapableMarker(versionOrBuild) {
  return hasJournalGateMarker(versionOrBuild) || hasRunBotMarker(versionOrBuild);
}

function agentVersionOk(body) {
  if (!body || typeof body !== 'object') return false;
  const build = String(body.agent_build_id || body.agentBuildId || '').trim();
  if (hasAgentCapableMarker(build)) return true;
  const ver = String(body.agent_version || body.agentVersion || '').trim();
  if (hasAgentCapableMarker(ver)) return true;
  // Agent เก่าส่ง journal_gate:true ใน heartbeat แต่ยังไม่มี build id จริง — อนุญาตเฉพาะเมื่อสตริงเวอร์ชันมี marker
  if (body.journal_gate === true || body.journalGate === true) {
    return hasJournalGateMarker(build || ver);
  }
  return false;
}

/** Agent รองรับ journal gate (ส่ง journalEvidence ใน connect-result) */
function agentSupportsJournalGate(body) {
  return agentVersionOk(body);
}

/** ยกเลิกคิวที่ไม่จำเป็นชั่วคราว — ให้ login_mt5 ได้ทันที */
async function deferMaintenanceForLogin(vpsId) {
  const nid = Number(vpsId || 0);
  if (!nid) return;

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = 'cancelled',
        result_message = COALESCE(result_message, 'deferred: user login'),
        updated_at = NOW()
    WHERE (vps_id = $1 OR node_id = $1)
      AND LOWER(COALESCE(status, '')) = 'pending'
      AND (
        command_type IN (
          'deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent',
          'dashboard', 'watchdog', 'account_snapshot', 'sync_mt5_account', 'read_account_metrics'
        )
        OR (
          command_type IN ('read_file', 'port_read_file')
          AND COALESCE(payload->>'purpose', '') = 'verify_mt5_journal'
        )
      )
  `,
    [nid]
  ).catch(() => {});
}

/** ยกเลิกคิว dashboard/metrics ซ้ำที่ทับคิว deploy/restart */
async function pruneMetricsCommandBacklog(vpsId, opts = {}) {
  const nid = Number(vpsId || 0);
  if (!nid) return { cancelled: 0 };
  const keep = Math.max(0, Number(opts.keep || 2));
  const r = await query(
    `
    WITH ranked AS (
      SELECT id,
        ROW_NUMBER() OVER (
          PARTITION BY command_type
          ORDER BY id DESC
        ) AS rn
      FROM vps_system.vps_agent_commands
      WHERE (vps_id = $1 OR node_id = $1)
        AND LOWER(COALESCE(status, '')) = 'pending'
        AND command_type IN (
          'dashboard', 'watchdog', 'account_snapshot',
          'sync_mt5_account', 'read_account_metrics', 'port_read_file'
        )
    )
    UPDATE vps_system.vps_agent_commands c
    SET status = 'cancelled',
        result_message = COALESCE(c.result_message, 'pruned: metrics backlog'),
        updated_at = NOW()
    FROM ranked r
    WHERE c.id = r.id AND r.rn > $2
    RETURNING c.id
  `,
    [nid, keep]
  ).catch(() => ({ rows: [] }));
  return { cancelled: r.rows?.length || 0 };
}

async function countRecentMaintenanceSuccess(vpsId, withinMinutes = 60) {
  const nid = Number(vpsId || 0);
  if (!nid) return { deploys: 0, restarts: 0 };
  const r = await query(
    `
    SELECT command_type, COUNT(*)::int AS n
    FROM vps_system.vps_agent_commands
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN (
        'deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent'
      )
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - ($2::text || ' minutes')::interval
    GROUP BY command_type
  `,
    [nid, String(withinMinutes)]
  ).catch(() => ({ rows: [] }));
  let deploys = 0;
  let restarts = 0;
  for (const row of r.rows || []) {
    const t = String(row.command_type || '');
    const n = Number(row.n || 0);
    if (t === 'restart_agent') restarts += n;
    else deploys += n;
  }
  return { deploys, restarts };
}

/** ปล่อยคิว deploy/restart/dashboard ที่ค้าง processing (กัน login_mt5 รอไม่จบ) */
async function expireStuckMaintenanceCommands(nodeId) {
  const vpsId = Number(nodeId || 0);
  if (!vpsId) return;

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = CASE
          WHEN command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent')
            THEN 'success'
          WHEN command_type IN ('dashboard', 'watchdog', 'account_snapshot', 'sync_mt5_account', 'read_account_metrics')
            THEN 'cancelled'
          ELSE 'failed'
        END,
        result_message = COALESCE(result_message, 'auto-closed: maintenance command stuck'),
        error = COALESCE(error, 'stuck maintenance timeout'),
        finished_at = NOW(),
        updated_at = NOW()
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN (
        'deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent',
        'dashboard', 'watchdog', 'account_snapshot', 'sync_mt5_account', 'read_account_metrics'
      )
      AND LOWER(COALESCE(status, '')) IN ('processing', 'picked', 'running')
      AND finished_at IS NULL
      AND COALESCE(locked_at, started_at, picked_at, updated_at, created_at)
          < NOW() - INTERVAL '90 seconds'
  `,
    [vpsId]
  ).catch(() => {});
}

/** สถานะการอัปเดต Agent บน VPS สำหรับข้อความแจ้งผู้ใช้ */
async function getAgentUpgradeState(nodeId) {
  const vpsId = Number(nodeId || 0);
  if (!vpsId) return 'legacy';

  const verRow = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const ver = String(verRow.rows?.[0]?.agent_version || '');
  if (hasAgentCapableMarker(ver)) return 'ready';

  const active = await query(
    `
    SELECT id, status
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running')
      AND created_at > NOW() - INTERVAL '8 minutes'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  if (active.rows?.[0]) return 'deploying';

  const deployed = await query(
    `
    SELECT id, finished_at
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent')
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - INTERVAL '6 hours'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  if (deployed.rows?.[0]) {
    const hb = await query(
      `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
      [vpsId]
    ).catch(() => ({ rows: [] }));
    const hbVer = String(hb.rows?.[0]?.agent_version || '');
    if (hasAgentCapableMarker(hbVer)) return 'ready';
    const recent = await countRecentMaintenanceSuccess(vpsId, 90);
    if (recent.deploys >= 1 && recent.restarts >= 2) {
      return 'stuck';
    }
    return 'needs_restart';
  }

  const recentLegacy = await countRecentMaintenanceSuccess(vpsId, 90);
  if (recentLegacy.deploys >= 2 && recentLegacy.restarts >= 3) {
    return 'stuck';
  }

  return 'legacy';
}

function messageForUpgradeState(state) {
  if (state === 'deploying') {
    return 'ระบบกำลังอัปเดต Agent บน VPS — รอ 2–3 นาที แล้วลองเชื่อมต่อใหม่ (ไม่ต้องกดซ้ำบ่อย)';
  }
  if (state === 'needs_restart') {
    return 'อัปเดตไฟล์ Agent แล้ว แต่ยังไม่รีสตาร์ท — บน VPS รัน: Restart-Service AvelquaPythonAgent แล้วลองเชื่อมต่อใหม่';
  }
  if (state === 'stuck') {
    return 'ระบบกำลังซ่อมแซม Agent บน VPS อัตโนมัติ — รอ 2–3 นาที (ไม่ต้องทำอะไรบน VPS)';
  }
  return 'Agent บน VPS ยังเป็นเวอร์ชันเก่า — ติดต่อแอดมินเพื่ออัปเดต Agent';
}

function loadAgentScript() {
  if (!fs.existsSync(AGENT_SCRIPT_PATH)) {
    throw new Error(`ไม่พบไฟล์ agent: ${AGENT_SCRIPT_PATH}`);
  }
  return fs.readFileSync(AGENT_SCRIPT_PATH, 'utf8');
}

function getAgentScriptUrl() {
  const base = (process.env.AVELQUA_PUBLIC_URL || 'https://trading.avelqua.com').replace(/\/$/, '');
  return `${base}/api/vps-agent/agent-script`;
}

/** payload — agent เก่าใช้ content, agent ใหม่ดาวน์โหลดจาก scriptUrl */
function buildDeployPayload(opts = {}) {
  const payload = {
    scriptUrl: getAgentScriptUrl(),
    targetPath: 'C:\\avelqua-python-agent\\agent.py',
    agent_path: 'C:\\avelqua-python-agent\\agent.py',
    fileName: 'agent.py',
    serviceName: 'AvelquaPythonAgent',
    service_name: 'AvelquaPythonAgent',
    restartService: true,
    requiredVersion: REQUIRED_AGENT_VERSION,
    deployToken: opts.deployToken || Date.now()
  };
  if (opts.inlineContent !== false) {
    payload.content = loadAgentScript();
    delete payload.scriptUrl;
  }
  return payload;
}

/** คิว deploy_agent ไป vps_system.vps_agent_commands (ตารางที่ Agent poll จริง) */
async function queueAgentDeploy(nodeId, opts = {}) {
  const vpsId = Number(nodeId || 0);
  const force = opts.force === true;
  if (!vpsId) return { queued: false, reason: 'NO_NODE_ID' };

  if (force) {
    await expireStuckMaintenanceCommands(vpsId);
    await query(
      `
      UPDATE vps_system.vps_agent_commands
      SET status = 'cancelled',
          result_message = COALESCE(result_message, 'superseded by forced deploy'),
          updated_at = NOW()
      WHERE (vps_id = $1 OR node_id = $1)
        AND command_type IN (
          'deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent'
        )
        AND LOWER(COALESCE(status, '')) IN ('pending', 'queued')
    `,
      [vpsId]
    ).catch(() => {});
  }

  const pending = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent')
      AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'picked', 'running', 'queued')
      AND created_at > NOW() - INTERVAL '10 minutes'
    LIMIT 1
  `,
    [vpsId]
  ).catch(() => ({ rows: [] }));

  if (!force && pending.rows?.[0]) {
    return { queued: false, reason: 'ALREADY_PENDING' };
  }

  if (!force && AGENT_DEPLOY_MIN_INTERVAL_MINUTES > 0) {
    const cool = await query(
      `
      SELECT id
      FROM vps_system.vps_agent_commands
      WHERE vps_id=$1
        AND command_type = 'deploy_agent'
        AND created_at > NOW() - ($2::text || ' minutes')::interval
      LIMIT 1
    `,
      [vpsId, String(AGENT_DEPLOY_MIN_INTERVAL_MINUTES)]
    ).catch(() => ({ rows: [] }));
    if (cool.rows?.[0]) {
      return { queued: false, reason: 'COOLDOWN' };
    }
  }

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'deploy_agent', $2::jsonb, 'pending', NOW(), NOW())
  `,
    [vpsId, JSON.stringify(buildDeployPayload({ inlineContent: true, deployToken: Date.now() }))]
  );

  if (opts.restart === true) {
    await query(
      `
      INSERT INTO vps_system.vps_agent_commands
      (vps_id, node_id, command_type, payload, status, created_at, updated_at)
      SELECT $1, $1, 'restart_agent', '{"service_name":"AvelquaPythonAgent","force":true}'::jsonb, 'pending', NOW(), NOW()
      WHERE NOT EXISTS (
        SELECT 1 FROM vps_system.vps_agent_commands
        WHERE vps_id=$1 AND command_type='restart_agent'
          AND LOWER(COALESCE(status,'')) IN ('pending','processing','picked','running')
          AND created_at > NOW() - INTERVAL '15 minutes'
      )
    `,
      [vpsId]
    ).catch(() => {});
  }

  return { queued: true, requiredVersion: REQUIRED_AGENT_VERSION, forced: force };
}

/** คิว deploy จาก heartbeat — ไม่ถี่เกิน (กันอัปเดตวนลูปบน VPS) */
async function maybeQueueDeployFromHeartbeat(nodeId, body) {
  const nid = Number(nodeId || 0);
  if (!nid || !body) return { queued: false, reason: 'SKIP' };
  if (agentVersionOk(body)) return { queued: false, reason: 'VERSION_OK' };

  const pending = await getPendingAgentMaintenance(nid);
  if (pending) return { queued: false, reason: 'ALREADY_PENDING' };

  const minMs = HEARTBEAT_DEPLOY_MIN_INTERVAL_MINUTES * 60 * 1000;
  const lastAt = heartbeatDeployAt.get(nid) || 0;
  if (Date.now() - lastAt < minMs) {
    return { queued: false, reason: 'HEARTBEAT_COOLDOWN' };
  }

  const recentDeploy = await query(
    `
    SELECT id
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent')
      AND LOWER(COALESCE(status, '')) IN ('success', 'done')
      AND finished_at > NOW() - ($2::text || ' minutes')::interval
    ORDER BY id DESC
    LIMIT 1
  `,
    [nid, String(HEARTBEAT_DEPLOY_MIN_INTERVAL_MINUTES)]
  ).catch(() => ({ rows: [] }));
  if (recentDeploy.rows?.[0]) {
    return { queued: false, reason: 'RECENT_DEPLOY_OK' };
  }

  heartbeatDeployAt.set(nid, Date.now());
  await pruneMetricsCommandBacklog(nid, { keep: 2 }).catch(() => {});
  const upState = await getAgentUpgradeState(nid).catch(() => 'legacy');
  if (upState === 'stuck') {
    return { queued: false, reason: 'STUCK_WAIT_ADMIN' };
  }
  return queueAgentDeploy(nid, { force: false, restart: false });
}

/** หลัง git pull / อัปเดต agent.py — ส่ง deploy + restart ไปทุก VPS ที่เปิดใช้งาน */
async function deployAgentToAllVpsNodes(opts = {}) {
  const force = opts.force !== false;
  const rows = await query(
    `
    SELECT id, node_code, node_name, agent_version, status
    FROM vps_system.vps_nodes
    WHERE COALESCE(agent_enabled, true) = true
    ORDER BY id ASC
  `
  ).catch(() => ({ rows: [] }));

  const results = [];
  for (const n of rows.rows || []) {
    const r = await queueAgentDeploy(n.id, { force, restart: force }).catch((e) => ({
      queued: false,
      reason: e.message || 'ERROR'
    }));
    results.push({
      vpsId: n.id,
      node: n.node_code || n.node_name || String(n.id),
      agentVersion: n.agent_version || '',
      status: n.status || '',
      ...r
    });
  }
  return { count: results.length, results, requiredVersion: REQUIRED_AGENT_VERSION };
}

/** ก่อน Run BOT — คิว deploy ถ้า Agent ยังไม่มี run-bot handler */
async function ensureRunBotAgent(nodeId, opts = {}) {
  const vpsId = Number(nodeId || 0);
  if (!vpsId) return { ok: false, reason: 'NO_NODE_ID' };

  const verRow = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const ver = String(verRow.rows?.[0]?.agent_version || '');
  if (hasRunBotMarker(ver)) return { ok: true, version: ver };

  if (opts.forceDeploy !== false) {
    const q = await queueAgentDeploy(vpsId);
    return {
      ok: false,
      reason: 'AGENT_NEEDS_UPDATE',
      deployQueued: !!q.queued,
      deployReason: q.reason || null,
      requiredVersion: REQUIRED_AGENT_VERSION
    };
  }

  return { ok: false, reason: 'AGENT_NEEDS_UPDATE', version: ver };
}

/**
 * ไม่คิว deploy ตอนผู้ใช้กด Login — deploy ทำผ่าน heartbeat/admin เท่านั้น
 * (กัน deploy_agent แย่งคิวก่อน login_mt5)
 */
async function ensureAgentUpToDate(nodeId) {
  const vpsId = Number(nodeId || 0);
  if (!vpsId) return { action: 'skip', reason: 'NO_NODE' };

  await expireStuckMaintenanceCommands(vpsId);

  const verRow = await query(
    `SELECT agent_version, last_seen_at FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const ver = String(verRow.rows?.[0]?.agent_version || '');
  if (hasAgentCapableMarker(ver)) return { action: 'ok', version: ver };

  if (process.env.MT5_CONNECT_SKIP_AGENT_DEPLOY !== '0') {
    return { action: 'ok', version: ver, reason: 'DEFER_DEPLOY' };
  }

  const recentDeploy = await query(
    `
    SELECT id, status, created_at
    FROM vps_system.vps_agent_commands
    WHERE vps_id=$1
      AND command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent')
      AND created_at > NOW() - INTERVAL '3 minutes'
    ORDER BY id DESC
    LIMIT 1
  `,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const dep = recentDeploy.rows?.[0];
  if (dep && ['pending', 'processing', 'picked', 'running'].includes(String(dep.status || '').toLowerCase())) {
    return { action: 'wait', reason: 'DEPLOY_PENDING' };
  }

  const q = await queueAgentDeploy(vpsId);
  if (!q.queued) {
    if (q.reason === 'COOLDOWN') {
      return { action: 'cooldown', reason: 'COOLDOWN' };
    }
    if (q.reason === 'ALREADY_PENDING') {
      return { action: 'wait', reason: 'DEPLOY_PENDING' };
    }
    return { action: 'skip', reason: q.reason || 'QUEUE_SKIPPED' };
  }

  return { action: 'queued', requiredVersion: REQUIRED_AGENT_VERSION };
}

module.exports = {
  REQUIRED_AGENT_VERSION,
  AGENT_SCRIPT_PATH,
  hasJournalGateMarker,
  hasRunBotMarker,
  hasAgentCapableMarker,
  agentVersionOk,
  agentSupportsJournalGate,
  getAgentUpgradeState,
  messageForUpgradeState,
  loadAgentScript,
  getAgentScriptUrl,
  buildDeployPayload,
  queueAgentDeploy,
  maybeQueueDeployFromHeartbeat,
  deployAgentToAllVpsNodes,
  ensureRunBotAgent,
  ensureAgentUpToDate,
  resolveLiveDashboardAgentNotice,
  ensureAgentMaintenance,
  queueAgentRestart,
  getPendingAgentMaintenance,
  isActiveBotInstance,
  expireStuckMaintenanceCommands,
  deferMaintenanceForLogin,
  pruneMetricsCommandBacklog,
  countRecentMaintenanceSuccess
};
