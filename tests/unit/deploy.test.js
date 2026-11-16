'use strict';
/**
 * Automatic update on the server (tools/auto-deploy.sh) and the backup it takes first
 * (server/backup-now.js). The script runs against a real git remote in a temp folder and a fake
 * `docker` on PATH that records its calls and answers the health check as the test says.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { loadConfig } = require('../../server/config');
const { backupNow } = require('../../server/backup-now');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'auto-deploy.sh');

test('backup-now: one consistent copy in the backups folder, like the settings page', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-bk-'));
  try {
    const b = backupNow(loadConfig({ dataDir, jobs: false, secret: 'test-secret' }));
    assert.match(b.name, /^anbar-\d{8}-\d{6}\.db$/);
    assert.ok(fs.statSync(path.join(dataDir, 'backups', b.name)).size > 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-deploy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const server = path.join(root, 'server');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  fs.mkdirSync(path.join(work, 'tools'));
  fs.copyFileSync(SCRIPT, path.join(work, 'tools', 'auto-deploy.sh'));
  fs.writeFileSync(path.join(work, 'version'), '1');
  fs.writeFileSync(path.join(work, '.gitignore'), '.deploy-failed\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'v1');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(root, 'clone', '-q', origin, server);

  // Fake docker: logs every call; "healthy" unless the checked-out version is listed in BAD
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(root, 'calls.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$*" in
  "compose ps -q --status running anbar") echo abc ;;
  "compose ps -q anbar") echo abc ;;
  inspect*) if grep -qx "$(cat version)" <<< "\${BAD:-}"; then echo unhealthy; else echo healthy; fi ;;
  "compose exec -T anbar node server/backup-now.js") [ -n "\${BACKUP_FAILS:-}" ] && exit 1; echo "backup ok" ;;
esac
exit 0
`, { mode: 0o755 });

  const release = (v) => {
    fs.writeFileSync(path.join(work, 'version'), v);
    git(work, 'commit', '-qam', `v${v}`);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
  };
  const run = (env = {}) => {
    fs.writeFileSync(calls, '');
    const r = spawnSync('bash', [path.join(server, 'tools', 'auto-deploy.sh')], {
      cwd: server, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
    });
    return { status: r.status, out: r.stdout + r.stderr, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
  };
  const version = () => fs.readFileSync(path.join(server, 'version'), 'utf8');
  return { release, run, version, server, git };
}

test('auto-deploy: nothing new → nothing touched; a new commit → backup, rebuild, healthy', (t) => {
  const s = setup(t);
  let r = s.run();
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, [], 'no docker call when main has not moved');

  s.release('2');
  r = s.run();
  assert.equal(r.status, 0, r.out);
  assert.equal(s.version(), '2');
  const backup = r.calls.indexOf('compose exec -T anbar node server/backup-now.js');
  const up = r.calls.indexOf('compose up -d --build anbar');
  assert.ok(backup >= 0 && up > backup, `backup before the rebuild: ${r.calls.join(' | ')}`);
  assert.match(r.out, /ok: .* v2/);
});

test('auto-deploy: no backup → no update; files edited on the server → no update', (t) => {
  const s = setup(t);
  s.release('2');
  let r = s.run({ BACKUP_FAILS: '1' });
  assert.equal(r.status, 1);
  assert.equal(s.version(), '1');
  assert.ok(!r.calls.includes('compose up -d --build anbar'));

  fs.writeFileSync(path.join(s.server, 'version'), 'edited');
  r = s.run();
  assert.equal(r.status, 1);
  assert.match(r.out, /changed by hand/);
  assert.equal(s.version(), 'edited');
});

test('auto-deploy: an unhealthy version goes back to the previous one and is not retried', (t) => {
  const s = setup(t);
  s.release('2');
  let r = s.run({ BAD: '2' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /going back/);
  assert.match(r.out, /rolled back/);
  assert.equal(s.version(), '1', 'previous version restored');
  r = s.run({ BAD: '2' });
  assert.deepEqual(r.calls, [], 'the failed commit is not rebuilt every 5 minutes');

  s.release('3'); // a fix
  r = s.run({ BAD: '2' });
  assert.equal(r.status, 0, r.out);
  assert.equal(s.version(), '3');
});
