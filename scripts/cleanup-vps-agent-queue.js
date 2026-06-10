#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { cleanupStuckVpsAgentQueue } = require('../lib/mt5QueueCleanup');

async function main() {
  const vpsId = Number(process.argv[2] || process.env.VPS_NODE_ID || 11);
  const res = await cleanupStuckVpsAgentQueue(vpsId, {
    stuckProcessingMin: Number(process.argv[3] || 12)
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
