'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');

async function ensureLineNotifyTables() {
  const sqlPath = path.join(__dirname, '..', 'sql', 'line_subscribers.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await query(sql).catch(() => {});
}

module.exports = { ensureLineNotifyTables };
