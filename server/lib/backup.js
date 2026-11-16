'use strict';
/**
 * Database backups: a consistent copy made with SQLite's VACUUM INTO while the app keeps
 * running, kept in DATA_DIR/backups (the same Docker volume). One a day from the scheduler,
 * or on demand from the settings page; the oldest are removed beyond `keep`.
 * Restore: stop the app, replace DATA_DIR/anbar.db with a backup file, start the app.
 *
 * Every copy is verified right after it is written: opened read-only, SQLite's own
 * quick_check must pass and it must hold the same schema version as the live database.
 * A copy that fails is deleted and the backup reports an error (the nightly job logs it and
 * the dashboard shows backups as late), instead of a broken file waiting for the day it is needed.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/** Opens a backup file read-only and checks it; throws with the reason if it is not usable. */
function verify(file, expectedVersion) {
  let copy;
  try {
    copy = new DatabaseSync(file, { readOnly: true });
    const problems = copy.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]).filter((v) => v !== 'ok');
    if (problems.length) throw new Error(problems.slice(0, 3).join('; '));
    const version = copy.prepare('PRAGMA user_version').get().user_version;
    if (expectedVersion !== undefined && version !== expectedVersion) throw new Error(`schema version ${version}, expected ${expectedVersion}`);
    return { version };
  } catch (err) {
    throw new Error(`نسخه‌ی پشتیبان سالم نیست (${err.message}).`, { cause: err });
  } finally {
    if (copy) copy.close();
  }
}

function createBackups({ db, config }) {
  const dir = path.join(config.dataDir, 'backups');
  const stamp = (d = new Date()) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).reduce((o, x) => ((o[x.type] = x.value), o), {});
    return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
  };

  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^anbar-\d{8}-\d{6}\.db$/.test(f)).sort().reverse()
      .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, size: st.size, at: st.mtime.toISOString() }; });
  }

  function now(keep = 14) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `anbar-${stamp()}.db`;
    const file = path.join(dir, name);
    // VACUUM INTO takes a string literal: the name is ours (digits only), so quoting is safe
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    try {
      verify(file, db.get('PRAGMA user_version').user_version);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    // Old copies are pruned only after the new one proved good
    for (const old of list().slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true });
    return { name, size: fs.statSync(file).size, at: new Date().toISOString() };
  }

  function file(name) {
    if (!/^anbar-\d{8}-\d{6}\.db$/.test(name)) return null;
    const f = path.join(dir, name);
    return fs.existsSync(f) ? f : null;
  }

  return { list, now, file, dir, verify };
}

module.exports = { createBackups, verify };
