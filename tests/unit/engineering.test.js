'use strict';
/**
 * The engineering guarantees: database guards, migration checksums, idempotent writes,
 * optimistic locking, WooCommerce retries, webhook replay protection, sync back-off,
 * readiness/metrics, graceful shutdown, config validation and the integrity check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { openDatabase } = require('../../server/db');
const { createWooClient } = require('../../server/lib/woo');
const { parseEnv } = require('../../server/config');
const { backoffMinutes } = require('../../server/lib/sync');
const { toJalali, toGregorian } = require('../../server/lib/jalali');

async function signedIn(t, overrides) {
  const ctx = await makeApp(overrides);
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  return { ctx, api };
}

test('database guards: history is append-only, nothing is deleted, stock never goes below zero', async (t) => {
  const { ctx } = await signedIn(t);
  const { db } = ctx;
  assert.ok(db.get('SELECT COUNT(*) AS n FROM audit_log').n > 0, 'the sign-in was logged');
  assert.throws(() => db.run("UPDATE audit_log SET summary = 'x'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_log'), /append-only/);
  assert.throws(() => db.run('DELETE FROM users'), /never deleted/);

  const now = new Date().toISOString();
  const comp = Number(db.run(`INSERT INTO companies (name, site_url, currency, price_unit, webhook_secret, created_at, updated_at)
                              VALUES ('آزمایش', 'https://t.example', 'toman', 'toman', 's', ?, ?)`, now, now).lastInsertRowid);
  const prod = Number(db.run(`INSERT INTO products (company_id, woo_id, type, name, created_at, updated_at) VALUES (?, 1, 'simple', 'کالا', ?, ?)`, comp, now, now).lastInsertRowid);
  const move = (units) => db.run(`INSERT INTO stock_moves (product_id, warehouse_id, owner_company_id, units, kind, created_at)
                                  VALUES (?, 1, NULL, ?, 'adjust', ?)`, prod, units, now);
  move(5);
  assert.throws(() => move(-6), /stock below zero/);
  move(-5);
  assert.equal(db.get('SELECT SUM(units) AS s FROM stock_moves WHERE product_id = ?', prod).s, 0);
  assert.throws(() => db.run('UPDATE stock_moves SET units = 1'), /write an opposite row/);
  assert.throws(() => db.run('DELETE FROM stock_moves'), /append-only/);

  // Deliberate repairs go through maintenance mode, and the guards come back afterwards
  db.maintenance(() => db.run("UPDATE audit_log SET summary = summary || '' WHERE id = 1"));
  assert.throws(() => db.run("UPDATE audit_log SET summary = 'x'"), /append-only/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM maintenance').n, 0);
});

test('migrations: an edited migration is refused instead of leaving the schema half-known', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-mig-'));
  const file = path.join(dir, 'a.db');
  try {
    const db = openDatabase(file);
    const applied = db.all('SELECT version, checksum FROM schema_migrations ORDER BY version');
    assert.ok(applied.length >= 5 && applied.every((m) => /^[0-9a-f]{64}$/.test(m.checksum)));
    db.run("UPDATE schema_migrations SET checksum = 'edited' WHERE version = 1");
    db.close();
    assert.throws(() => openDatabase(file), /changed after it was applied/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idempotency: a retried write returns the first answer and runs once', async (t) => {
  const { ctx, api } = await signedIn(t);
  const key = crypto.randomUUID();
  const first = await api.post('/api/warehouses', { name: 'انبار سوم' }, { 'idempotency-key': key });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await api.post('/api/warehouses', { name: 'انبار سوم' }, { 'idempotency-key': key });
  assert.equal(again.status, 200);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.deepEqual(again.body, first.body);
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM warehouses WHERE name = 'انبار سوم'").n, 1);
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'create' AND entity = 'warehouse'").n, 1);

  const other = await api.post('/api/warehouses', { name: 'انبار چهارم' }, { 'idempotency-key': key });
  assert.equal(other.status, 422, 'the same key for a different request');
  const bad = await api.post('/api/warehouses', { name: 'انبار چهارم' }, { 'idempotency-key': 'short' });
  assert.equal(bad.status, 400);
  // Without a key nothing is remembered: the duplicate name is refused by the normal rules
  const dupe = await api.post('/api/warehouses', { name: 'انبار سوم' });
  assert.equal(dupe.status, 409);

  // Validation errors are replayed too (the form must send a new key after the user fixes it)
  const k2 = crypto.randomUUID();
  assert.equal((await api.post('/api/warehouses', { name: '' }, { 'idempotency-key': k2 })).status, 400);
  assert.equal((await api.post('/api/warehouses', { name: '' }, { 'idempotency-key': k2 })).headers['idempotent-replayed'], 'true');

  // A request that never finished (process stopped) is not stuck for a day
  const k3 = crypto.randomUUID();
  const userId = ctx.db.get("SELECT id FROM users WHERE username = 'boss'").id;
  ctx.db.run(`INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, created_at) VALUES (?, ?, 'POST', '/api/warehouses', 'x', ?)`,
    k3, userId, new Date(Date.now() - 10 * 60e3).toISOString());
  assert.equal((await api.post('/api/warehouses', { name: 'انبار پنجم' }, { 'idempotency-key': k3 })).status, 200);
  const k4 = crypto.randomUUID();
  ctx.db.run(`INSERT INTO idempotency_keys (key, user_id, method, path, request_hash, created_at) VALUES (?, ?, 'POST', '/api/warehouses', ?, ?)`,
    k4, userId, crypto.createHash('sha256').update(`POST /api/warehouses\n${JSON.stringify({ name: 'انبار ششم' })}`).digest('hex'), new Date().toISOString());
  const busy = await api.post('/api/warehouses', { name: 'انبار ششم' }, { 'idempotency-key': k4 });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'in_progress');

  ctx.db.run('UPDATE idempotency_keys SET created_at = ?', new Date(Date.now() - 25 * 3600e3).toISOString());
  assert.ok(ctx.app.ctx.idempotency.prune() >= 3);
});

test('optimistic locking: a stale edit is refused with who changed it; the current version saves', async (t) => {
  const { ctx, api } = await signedIn(t);
  const w = (await api.get('/api/warehouses')).body.items.find((x) => x.id === 1);
  assert.equal(w.version, 1);
  const ok = await api.put('/api/warehouses/1', { name: 'انبار اصلی', notes: 'یک', active: true }, { 'if-match': '"1"' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.items.find((x) => x.id === 1).version, 2);
  const stale = await api.put('/api/warehouses/1', { name: 'انبار اصلی', notes: 'دو', active: true }, { 'if-match': '"1"' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  assert.equal(stale.body.current_version, 2);
  assert.match(stale.body.error, /مدیر/, 'names the person who saved');
  assert.equal(ctx.db.get('SELECT notes FROM warehouses WHERE id = 1').notes, 'یک', 'nothing overwritten');
  assert.equal((await api.put('/api/warehouses/1', { name: 'انبار اصلی', notes: 'دو', active: true }, { 'if-match': 'x' })).status, 400);
  // Without If-Match the edit applies (scripts); the version still moves on
  assert.equal((await api.put('/api/warehouses/1', { name: 'انبار اصلی', notes: 'سه', active: true })).status, 200);
  assert.equal(ctx.db.get('SELECT version FROM warehouses WHERE id = 1').version, 3);

  const u = (await api.get('/api/users')).body.items[0];
  const body = { name: u.name, username: u.username, role: u.role, active: true, phone: '', email: '' };
  assert.equal((await api.put(`/api/users/${u.id}`, { ...body, name: 'مدیر کل' }, { 'if-match': `"${u.version}"` })).status, 200);
  assert.equal((await api.put(`/api/users/${u.id}`, { ...body, name: 'مدیر ارشد' }, { 'if-match': `"${u.version}"` })).body.code, 'stale');
});

test('woo client: retries time-outs and 5xx with back-off, honours Retry-After, never retries a wrong key', async () => {
  const answers = [];
  const fetchImpl = async () => {
    const a = answers.shift();
    if (a === 'drop') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers || {} });
  };
  const seen = [];
  const metrics = { inc: (name, labels) => seen.push(labels.outcome) };
  const client = createWooClient({ siteUrl: 'https://s.example', key: 'k', secret: 's', fetchImpl, retryBaseMs: 1, metrics });

  answers.push('drop', { status: 503, body: {} }, { status: 200, body: [{ id: 1 }], headers: { 'x-wp-totalpages': '1', 'x-wp-total': '1' } });
  const res = await client.products();
  assert.equal(res.data[0].id, 1);
  assert.equal(client.retried, 2);
  assert.deepEqual(seen, ['retry', 'retry', 'ok']);

  answers.push({ status: 401, body: { code: 'woocommerce_rest_cannot_view' } });
  await assert.rejects(client.products(), (e) => e.code === 'auth');
  assert.equal(client.retried, 2, 'a wrong key is not retried');

  answers.push({ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} });
  await assert.rejects(client.products(), (e) => e.code === 'http' && e.status === 503);
  assert.equal(answers.length, 0, 'gave up after 1 + 2 tries');

  const t0 = Date.now();
  answers.push({ status: 429, body: {}, headers: { 'retry-after': '1' } }, { status: 200, body: [], headers: {} });
  await client.products();
  assert.ok(Date.now() - t0 >= 950, 'waited for Retry-After');
});

test('webhook: a signed push is accepted once; a replay of it is refused', async (t) => {
  const { ctx, api } = await signedIn(t);
  const s = await shop(ctx, { count: 2, seed: 3 });
  const c = await addCompany(ctx, api, s);
  const secret = ctx.db.get('SELECT webhook_secret FROM companies WHERE id = ?', c.id).webhook_secret;
  const body = JSON.stringify({ ping: true });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const send = () => ctx.app.inject({
    method: 'POST', url: `/hooks/woo/${c.id}`, payload: body,
    headers: { 'content-type': 'application/json', 'x-anbar-timestamp': String(ts), 'x-anbar-signature': `sha256=${sig}` }
  });
  assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 409);
});

test('sync back-off: a failing site waits 2, 4, 8 … minutes; the scheduler skips it until then', async (t) => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMinutes), [2, 4, 8, 16, 32, 60, 60, 60]);
  const { ctx, api } = await signedIn(t);
  const s = await shop(ctx, { count: 2, seed: 4 });
  const c = await addCompany(ctx, api, s);
  await s.close();
  ctx.shops.length = 0;
  await assert.rejects(ctx.app.ctx.sync.fullSync(c.id));
  let row = ctx.db.get('SELECT sync_failures, next_sync_at, sync_state FROM companies WHERE id = ?', c.id);
  assert.equal(row.sync_failures, 1);
  assert.equal(row.sync_state, 'error');
  const wait = new Date(row.next_sync_at).getTime() - Date.now();
  assert.ok(wait > 100e3 && wait <= 120e3, `about two minutes, got ${wait}`);
  const runs = () => ctx.db.get('SELECT COUNT(*) AS n FROM sync_runs WHERE company_id = ?', c.id).n;
  const before = runs();
  ctx.db.run("UPDATE companies SET last_full_sync_at = '2000-01-01T00:00:00Z' WHERE id = ?", c.id);
  await ctx.app.ctx.jobs.tick();
  assert.equal(runs(), before, 'skipped while backing off');
  await assert.rejects(ctx.app.ctx.sync.fullSync(c.id));
  row = ctx.db.get('SELECT sync_failures FROM companies WHERE id = ?', c.id);
  assert.equal(row.sync_failures, 2);
});

test('operations: request ids, readiness, metrics behind a token', async (t) => {
  const token = 'metrics-token-0123456789';
  const { ctx, api } = await signedIn(t, { metricsToken: token });
  const res = await ctx.app.inject({ url: '/health', headers: { 'x-request-id': 'caddy-req-12345' } });
  assert.equal(res.headers['x-request-id'], 'caddy-req-12345');
  assert.match((await ctx.app.inject({ url: '/health' })).headers['x-request-id'], /^[0-9a-f-]{36}$/);
  await api.get('/api/dashboard');

  assert.equal((await ctx.app.inject({ url: '/ready' })).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: '/metrics' })).statusCode, 401);
  assert.equal((await ctx.app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  const m = await ctx.app.inject({ url: '/metrics', headers: { authorization: `Bearer ${token}` } });
  assert.equal(m.statusCode, 200);
  assert.match(m.body, /anbar_http_requests_total\{method="GET",route="\/api\/dashboard",status="200"\} 1/);
  assert.match(m.body, /anbar_http_request_duration_seconds_bucket\{method="GET",route="\/api\/dashboard",le="\+Inf"\} 1/);
  assert.match(m.body, /anbar_tasks_open 0/);
  assert.match(m.body, /anbar_integrity_ok -1/);

  ctx.app.ctx.shuttingDown = true;
  assert.equal((await ctx.app.inject({ url: '/ready' })).statusCode, 503);
  ctx.app.ctx.shuttingDown = false;

  const off = await makeApp();
  t.after(off.cleanup);
  assert.equal((await off.app.inject({ url: '/metrics' })).statusCode, 404, 'off without METRICS_TOKEN');
});

test('graceful shutdown waits for a running sync, then closes', async (t) => {
  const { ctx, api } = await signedIn(t);
  const s = await shop(ctx, { count: 30, seed: 5 });
  const c = await addCompany(ctx, api, s);
  const run = ctx.app.ctx.sync.fullSync(c.id);
  let finished = false;
  run.then(() => { finished = true; }, () => { finished = true; });
  await ctx.app.shutdown();
  assert.ok(finished, 'the sync ended before the app closed');
  assert.equal(ctx.app.ctx.shuttingDown, true);
});

test('config: a wrong variable stops the start with its name', () => {
  assert.equal(parseEnv({}).PORT, 8080);
  assert.equal(parseEnv({ PORT: '9000', JOBS: '0', TRUST_PROXY: 'true' }).JOBS, false);
  assert.throws(() => parseEnv({ PORT: 'eighty' }), /PORT/);
  assert.throws(() => parseEnv({ WOO_TIMEOUT_MS: '10' }), /WOO_TIMEOUT_MS/);
  assert.throws(() => parseEnv({ APP_SECRET: 'short' }), /APP_SECRET must be at least 32/);
  assert.throws(() => parseEnv({ PUBLIC_URL: 'ftp://x' }), /PUBLIC_URL/);
  assert.equal(parseEnv({ PUBLIC_URL: '' }).PUBLIC_URL, undefined, 'empty means not set');
});

test('integrity: a clean database passes; a broken invariant is reported', async (t) => {
  const { ctx, api } = await signedIn(t);
  const first = (await api.post('/api/system/integrity')).body.report;
  assert.equal(first.ok, true, JSON.stringify(first.results.filter((r) => !r.ok)));
  assert.ok(first.results.length >= 8);
  const now = new Date().toISOString();
  ctx.db.maintenance(() => {
    const comp = Number(ctx.db.run(`INSERT INTO companies (name, site_url, currency, price_unit, webhook_secret, created_at, updated_at)
                                    VALUES ('ب', 'https://b.example', 'toman', 'toman', 's', ?, ?)`, now, now).lastInsertRowid);
    const prod = Number(ctx.db.run(`INSERT INTO products (company_id, woo_id, type, name, created_at, updated_at) VALUES (?, 9, 'simple', 'ک', ?, ?)`, comp, now, now).lastInsertRowid);
    ctx.db.run(`INSERT INTO stock_moves (product_id, warehouse_id, owner_company_id, units, kind, created_at) VALUES (?, 1, NULL, -3, 'adjust', ?)`, prod, now);
  });
  ctx.checkIntegrity = false; // broken on purpose
  const r = (await api.post('/api/system/integrity')).body.report;
  assert.equal(r.ok, false);
  assert.equal(r.results.find((x) => x.id === 'stock_negative').count, 1);
  assert.equal((await api.get('/api/system')).body.integrity.ok, false, 'the last report is kept');
});

test('jalali: 20 000 random days round-trip between the calendars', () => {
  let x = 12345;
  const rand = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const start = Date.UTC(1925, 0, 1);
  for (let i = 0; i < 20000; i++) {
    const d = new Date(start + Math.floor(rand() * 150 * 365.25) * 864e5);
    const g = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const j = toJalali(...g);
    assert.deepEqual(toGregorian(...j), g, `${g} → ${j}`);
    assert.ok(j[1] >= 1 && j[1] <= 12 && j[2] >= 1 && j[2] <= (j[1] <= 6 ? 31 : 30));
    const fmt = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
    const part = (type) => Number(fmt.find((p) => p.type === type).value);
    assert.deepEqual(j, [part('year'), part('month'), part('day')], `matches Intl for ${d.toISOString()}`);
  }
});
