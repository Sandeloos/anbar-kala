'use strict';
/** A backup is only kept if it opens and passes SQLite's own check. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeApp } = require('./helpers');
const { verify } = require('../../server/lib/backup');

test('backups: every copy is verified; a broken file is refused', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  const { backups, db } = ctx.app.ctx;
  const b = backups.now(5);
  const file = backups.file(b.name);
  const version = db.get('PRAGMA user_version').user_version;
  assert.deepEqual(verify(file, version), { version });

  // A truncated copy (disk full, I/O error) and a copy of another schema are refused
  const broken = path.join(backups.dir, 'broken.db');
  fs.writeFileSync(broken, fs.readFileSync(file).subarray(0, 4096 + 100));
  assert.throws(() => verify(broken, version), /سالم نیست/);
  fs.writeFileSync(broken, 'not a database at all');
  assert.throws(() => verify(broken, version), /سالم نیست/);
  assert.throws(() => verify(file, version + 1), /schema version/);
  fs.rmSync(broken);

  // The backup flow deletes a copy that fails and keeps the older good ones
  const before = backups.list().map((x) => x.name);
  const original = db.exec;
  db.exec = (sql) => {
    original(sql);
    const m = /VACUUM INTO '(.+)'/.exec(sql);
    if (m) fs.writeFileSync(m[1], 'garbage');
  };
  await new Promise((r) => setTimeout(r, 1100)); // a new file name (one per second)
  assert.throws(() => backups.now(1), /سالم نیست/);
  db.exec = original;
  assert.deepEqual(backups.list().map((x) => x.name), before, 'nothing pruned, the broken copy removed');
});
