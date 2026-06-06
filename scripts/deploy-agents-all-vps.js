#!/usr/bin/env node
'use strict';

/**
 * คิว deploy_agent + restart_agent ไปทุก VPS (โหลด agent.py จากเซิร์ฟเวอร์ + รีสตาร์ทบริการ)
 * ใช้: node scripts/deploy-agents-all-vps.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  deployAgentToAllVpsNodes,
  REQUIRED_AGENT_VERSION,
  loadAgentScript,
  AGENT_SCRIPT_PATH
} = require('../lib/agentDeploy');

async function main() {
  try {
    loadAgentScript();
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error('  path:', AGENT_SCRIPT_PATH);
    process.exit(1);
  }

  const force = process.env.AGENT_DEPLOY_FORCE !== '0';
  console.log(`==> Deploy agent to all VPS (force=${force}, version=${REQUIRED_AGENT_VERSION})`);

  const out = await deployAgentToAllVpsNodes({ force });
  if (!out.count) {
    console.log('No VPS nodes found (agent_enabled=true).');
    process.exit(0);
  }

  for (const r of out.results) {
    const tag = r.queued ? 'QUEUED' : r.reason || 'SKIP';
    console.log(`  VPS ${r.vpsId} [${r.node}] ${tag}`);
  }

  console.log(
    `DONE: ${out.count} node(s) — Agent จะอัปเดต + Restart-Service บน Windows ภายใน ~30–60 วินาที`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
