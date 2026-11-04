'use strict';
/**
 * SQLite through Node's built-in node:sqlite (no native add-on to compile).
 * One file in DATA_DIR, WAL mode, foreign keys on, numbered SQL migrations
 * from server/migrations applied in order and tracked in PRAGMA user_version.
 */
const fs = require('fs');
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
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

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
    close: () => raw.close()
  };
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.get('PRAGMA user_version').user_version;
  const files = fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = parseInt(file, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    db.tx(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

module.exports = { openDatabase };
