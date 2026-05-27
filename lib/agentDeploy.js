'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');

const REQUIRED_AGENT_VERSION =
  process.env.AVELQUA_REQUIRED_AGENT_VERSION || '2026-05-27-mt5-options-algo-v39';
/** ห่างกันอย่างน้อย N นาทีก่อนคิว deploy_agent ซ้ำ (กันอัปเดตบน VPS ถี่เกินไป) */
const AGENT_DEPLOY_MIN_INTERVAL_MINUTES = Number(
  process.env.AGENT_DEPLOY_MIN_INTERVAL_MINUTES || 45
);
const AGENT_SCRIPT_PATH = path.join(process.cwd(), 'public/agent/agent.py');

function hasJournalGateMarker(versionOrBuild) {
  const v = String(versionOrBuild || '').trim();
  if (!v) return false;
  if (v === REQUIRED_AGENT_VERSION) return true;
  return v.includes('journal-gate');
}

function agentVersionOk(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.journal_gate === true || body.journalGate === true) return true;
  const build = body.agent_build_id || body.agentBuildId || '';
  if (hasJournalGateMarker(build)) return true;
  return hasJournalGateMarker(body.agent_version || body.agentVersion || '');
}

/** Agent รองรับ journal gate (ส่ง journalEvidence ใน connect-result) */
function agentSupportsJournalGate(body) {
  return agentVersionOk(body);
}

/** ปล่อยคิว deploy/restart ที่ค้าง processing (กัน login_mt5 รอไม่จบ) */
async function expireStuckMaintenanceCommands(nodeId) {
  const vpsId = Number(nodeId || 0);
  if (!vpsId) return;

  await query(
    `
    UPDATE vps_system.vps_agent_commands
    SET status = CASE
          WHEN command_type IN ('deploy_agent', 'update_agent_script', 'update_python_agent')
            THEN 'success'
          ELSE 'failed'
        END,
        result_message = COALESCE(result_message, 'auto-closed: maintenance command stuck'),
        error = COALESCE(error, 'stuck maintenance timeout'),
        finished_at = NOW(),
        updated_at = NOW()
    WHERE (vps_id = $1 OR node_id = $1)
      AND command_type IN (
        'deploy_agent', 'update_agent_script', 'update_python_agent', 'restart_agent'
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
  if (hasJournalGateMarker(ver)) return 'ready';

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
    if (hasJournalGateMarker(hbVer)) return 'ready';
    return 'needs_restart';
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
    targetPath: 'C:\\avelqua-python-agent\\agent.py',
    agent_path: 'C:\\avelqua-python-agent\\agent.py',
    fileName: 'agent.py',
    serviceName: 'AvelquaPythonAgent',
    service_name: 'AvelquaPythonAgent',
    restartService: true,
    requiredVersion: REQUIRED_AGENT_VERSION
  };
  if (opts.inlineContent) {
    payload.content = loadAgentScript();
  } else {
    payload.scriptUrl = getAgentScriptUrl();
  }
  return payload;
}

/** คิว deploy_agent ไป vps_system.vps_agent_commands (ตารางที่ Agent poll จริง) */
async function queueAgentDeploy(nodeId) {
  const vpsId = Number(nodeId || 0);
  if (!vpsId) return { queued: false, reason: 'NO_NODE_ID' };

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

  if (pending.rows?.[0]) {
    return { queued: false, reason: 'ALREADY_PENDING' };
  }

  if (AGENT_DEPLOY_MIN_INTERVAL_MINUTES > 0) {
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

  const verRow = await query(
    `SELECT agent_version FROM vps_system.vps_nodes WHERE id=$1 LIMIT 1`,
    [vpsId]
  ).catch(() => ({ rows: [] }));
  const currentVer = verRow.rows?.[0]?.agent_version || '';
  const needsInline = !hasJournalGateMarker(currentVer);

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    VALUES ($1, $1, 'deploy_agent', $2::jsonb, 'pending', NOW(), NOW())
  `,
    [vpsId, JSON.stringify(buildDeployPayload({ inlineContent: true }))]
  );

  await query(
    `
    INSERT INTO vps_system.vps_agent_commands
    (vps_id, node_id, command_type, payload, status, created_at, updated_at)
    SELECT $1, $1, 'restart_agent', '{"service_name":"AvelquaPythonAgent","force":true}'::jsonb, 'pending', NOW(), NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM vps_system.vps_agent_commands
      WHERE vps_id=$1 AND command_type='restart_agent'
        AND LOWER(COALESCE(status,'')) IN ('pending','processing','picked','running')
        AND created_at > NOW() - INTERVAL '3 minutes'
    )
  `,
    [vpsId]
  ).catch(() => {});

  return { queued: true, requiredVersion: REQUIRED_AGENT_VERSION };
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
  if (hasJournalGateMarker(ver)) return { action: 'ok', version: ver };

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
  agentVersionOk,
  agentSupportsJournalGate,
  getAgentUpgradeState,
  messageForUpgradeState,
  loadAgentScript,
  getAgentScriptUrl,
  buildDeployPayload,
  queueAgentDeploy,
  ensureAgentUpToDate,
  expireStuckMaintenanceCommands
};
