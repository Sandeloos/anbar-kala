'use strict';
/**
 * SQLite through Node's built-in node:sqlite (no native add-on to compile).
 * One file in DATA_DIR, WAL mode, foreign keys on, numbered SQL migrations
 * from server/migrations applied in order and tracked in PRAGMA user_version.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// node:sqlite still prints an "experimental" warning on Node 22; it is stable enough here
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (String(warning && warning.message ? warning.message : warning).includes('SQLite is an experimental')) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = path.join(__dirname, 'migrations');

function bind(params) {
  return params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}
function bindNamed(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  return out;
}
function args(params) {
  return params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])
    ? [bindNamed(params[0])] : bind(params);
}

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -20000;');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;

  const db = {
    raw,
    get: (sql, ...p) => stmt(sql).get(...args(p)),
    all: (sql, ...p) => stmt(sql).all(...args(p)),
    run: (sql, ...p) => stmt(sql).run(...args(p)),
    exec: (sql) => raw.exec(sql),
    /** Runs fn inside a transaction (nested calls join the outer one). */
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    /**
     * Runs fn with the append-only guards lifted (the triggers check the maintenance table).
     * For demo/test back-dating and deliberate data repairs only; never from a request.
     */
    maintenance(fn) {
      return db.tx(() => {
        raw.exec('INSERT OR IGNORE INTO maintenance (id) VALUES (1)');
        try { return fn(); } finally { raw.exec('DELETE FROM maintenance'); }
      });
    },
    /** Flushes the write-ahead log and lets SQLite refresh its query statistics. */
    close: () => {
      try { raw.exec('PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* read-only or already closed */ }
      raw.close();
    }
  };
  migrate(db);
  return db;
}

/**
 * Applies new migrations in order, each in its own transaction, and remembers a checksum of
 * every applied file in schema_migrations. Editing a migration that already ran is refused at
 * start-up (the database and the code would disagree silently); add a new migration instead.
 */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const current = db.get('PRAGMA user_version').user_version;
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = parseInt(file, 10);
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    if (version <= current) {
      const row = db.get('SELECT checksum FROM schema_migrations WHERE version = ?', version);
      if (!row) {
        // Databases created before checksums were recorded: remember what is there now
        db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', version, file, checksum, new Date().toISOString());
      } else if (row.checksum !== checksum) {
        throw new Error(`Migration ${file} changed after it was applied to this database. Restore the file and add a new migration instead.`);
      }
      continue;
    }
    db.tx(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.run('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)', version, file, checksum, new Date().toISOString());
    });
  }
}

module.exports = { openDatabase };
