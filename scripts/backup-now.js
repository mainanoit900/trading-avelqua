require('dotenv').config();
const { createBackup } = require('../services/backupService');

createBackup()
  .then(result => {
    console.log(`[backup] success ${result.name}`);
    process.exit(0);
  })
  .catch(error => {
    console.error('[backup] failed', error);
    process.exit(1);
  });
