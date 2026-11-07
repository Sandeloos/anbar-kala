'use strict';
/** Test helpers: a fresh app on a temporary folder, a signed-in client, fake shops. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../server/config');
const { buildApp } = require('../../server/app');
const { hashPassword, nowIso } = require('../../server/lib/util');
const { createMockWoo } = require('../../tools/mock-woo');

async function makeApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-test-'));
  const config = loadConfig({ dataDir, jobs: false, secret: 'test-secret', relaxLimits: false, wooTimeoutMs: 5000, ...overrides });
  const app = await buildApp(config, { logger: false });
  const shops = [];
  const ctx = { app, config, db: app.ctx.db, shops, checkIntegrity: true };
  // Every test ends with the whole-database integrity check: whatever a scenario did
  // (orders, receiving, returns, statements), the books must still agree.
  ctx.cleanup = async () => {
    let report = null;
    if (ctx.checkIntegrity && !app.ctx.shuttingDown) report = app.ctx.integrity.run();
    await app.close();
    for (const s of shops) await s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (report && !report.ok) {
      throw new Error('integrity check failed: ' + JSON.stringify(report.results.filter((r) => !r.ok).map((r) => ({ id: r.id, problems: r.problems.slice(0, 3) }))));
    }
  };
  return ctx;
}

async function addUser(db, { username = 'boss', password = 'secret-pass-1', role = 'manager', name = 'مدیر', mustChange = 0 } = {}) {
  const now = nowIso();
  const info = db.run(`INSERT INTO users (username, name, role, password_hash, must_change_password, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`, username, name, role, await hashPassword(password), mustChange, now, now);
  return Number(info.lastInsertRowid);
}

/** A tiny client that keeps the session cookie and sends the X-Anbar header. */
function client(app) {
  let cookie = '';
  async function call(method, url, body, extra = {}) {
    const res = await app.inject({
      method, url,
      headers: Object.assign({ 'x-anbar': '1' }, cookie ? { cookie } : {}, body !== undefined ? { 'content-type': 'application/json' } : {}, extra),
      payload: body !== undefined ? JSON.stringify(body) : undefined
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const c = (Array.isArray(set) ? set : [set]).find((s) => s.startsWith('anbar_session='));
      if (c) cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    }
    let json = null;
    try { json = res.json(); } catch { /* not JSON */ }
    return { status: res.statusCode, body: json, headers: res.headers };
  }
  return {
    get: (u) => call('GET', u), post: (u, b = {}, h) => call('POST', u, b, h), put: (u, b = {}, h) => call('PUT', u, b, h), del: (u) => call('DELETE', u),
    login: (username = 'boss', password = 'secret-pass-1') => call('POST', '/api/auth/login', { username, password }),
    get cookie() { return cookie; }
  };
}

async function shop(ctx, opts = {}) {
  const s = await createMockWoo(opts).listen(0);
  ctx.shops.push(s);
  return s;
}

/** Creates a company through the API (which tests the connection) and waits for its first sync. */
async function addCompany(ctx, api, s, extra = {}) {
  const res = await api.post('/api/companies', {
    name: s.name, site_url: s.url, key: s.key, secret: s.secret, currency: 'toman', price_unit: 'toman', warehouse_id: 1, ...extra
  });
  if (res.status !== 200) throw new Error('add company failed: ' + JSON.stringify(res.body));
  await waitFor(() => !ctx.app.ctx.sync.isRunning(res.body.company.id));
  return res.body.company;
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

module.exports = { makeApp, addUser, client, shop, addCompany, waitFor };
