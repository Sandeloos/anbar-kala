'use strict';
/**
 * Creates the first manager account when none exists:
 *   MANAGER_USERNAME=… MANAGER_PASSWORD=… MANAGER_NAME=… node server/seed.js
 * Safe to run on every start (Docker does): it only adds what is missing.
 */
const path = require('path');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { hashPassword, nowIso } = require('./lib/util');

async function ensureManager(db, { username, password, name }) {
  if (db.get("SELECT 1 FROM users WHERE role = 'manager'")) return false;
  if (!username || !password) return false;
  if (password.length < 8) throw new Error('MANAGER_PASSWORD must be at least 8 characters');
  const now = nowIso();
  db.run(`INSERT INTO users (username, name, role, password_hash, must_change_password, created_at, updated_at)
          VALUES (?, ?, 'manager', ?, 0, ?, ?)`, username.toLowerCase(), name || 'مدیر', await hashPassword(password), now, now);
  return true;
}

module.exports = { ensureManager };

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    const db = openDatabase(path.join(config.dataDir, 'anbar.db'));
    const env = process.env;
    const made = await ensureManager(db, { username: env.MANAGER_USERNAME, password: env.MANAGER_PASSWORD, name: env.MANAGER_NAME });
    if (made) console.log(`Manager "${env.MANAGER_USERNAME}" created.`);
    else if (!db.get("SELECT 1 FROM users WHERE role = 'manager'")) {
      console.warn('No manager yet: set MANAGER_USERNAME and MANAGER_PASSWORD and run `npm run db:seed`.');
    }
    db.close();
  })().catch((err) => { console.error(err.message); process.exit(1); });
}
