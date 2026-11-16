'use strict';
/**
 * Takes one database backup now, exactly like «تنظیمات ← پشتیبان‌گیری الان» (VACUUM INTO, the app
 * keeps running) and keeps the number of copies set in the panel. Used by tools/auto-deploy.sh
 * before every update:
 *   docker compose exec -T anbar node server/backup-now.js
 * Prints the file name; exits 1 when the copy could not be made.
 */
const path = require('path');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createBackups } = require('./lib/backup');
const { createSettings } = require('./lib/settings');

function backupNow(config) {
  const db = openDatabase(path.join(config.dataDir, 'anbar.db'));
  try {
    return createBackups({ db, config }).now(createSettings(db).get('backup_keep'));
  } finally {
    db.close();
  }
}

module.exports = { backupNow };

if (require.main === module) {
  try {
    const b = backupNow(loadConfig());
    console.log(`backup ${b.name} (${b.size} bytes)`);
  } catch (err) {
    console.error(`backup failed: ${err.message}`);
    process.exit(1);
  }
}
