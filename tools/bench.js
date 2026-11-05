'use strict';
/**
 * Load benchmark: a realistic month and more on one SQLite file, then the hot paths timed.
 *
 *   node tools/bench.js                 # 1 500 products, 300 orders a day for 45 days
 *   node tools/bench.js --days 90 --per-day 500 --products 3000
 *
 * Builds the app on a temporary folder (nothing touches data/), syncs a fake WooCommerce
 * shop, back-dates its price history, writes the orders through the same code the API uses,
 * receives them, then measures the API with fastify.inject (no network in the numbers).
 * Results and the machine they ran on: docs/performance.md.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const DAYS = arg('days', 45);
const PER_DAY = arg('per-day', 300);
const PRODUCTS = arg('products', 1500);
const SAMPLES = arg('samples', 60);

process.env.TZ = 'Asia/Tehran';
const { loadConfig } = require('../server/config');
const { buildApp } = require('../server/app');
const { hashPassword, nowIso, searchKey } = require('../server/lib/util');
const { monthOf } = require('../server/lib/jalali');
const { createMockWoo } = require('./mock-woo');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (n) => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString());

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-bench-'));
  const config = loadConfig({ dataDir, jobs: false, secret: 'bench-secret-0123456789abcdef0123', relaxLimits: true });
  const app = await buildApp(config, { logger: false });
  const { db, secrets, sync, orders, integrity, statements } = app.ctx;
  const rows = [];
  const step = (label, t0, extra = '') => { const v = ms(t0); rows.push([label, fmt(v), extra]); console.log(`${label}: ${fmt(v)} ms ${extra}`); };

  try {
    const now = nowIso();
    db.run("INSERT INTO users (username, name, role, password_hash, created_at, updated_at) VALUES ('bench', 'بنچ', 'manager', ?, ?, ?)",
      await hashPassword('bench-pass-123'), now, now);
    const user = db.get("SELECT id, name FROM users WHERE username = 'bench'");
    const as = { user, ip: '127.0.0.1' };

    const shop = await createMockWoo({ name: 'بنچ', count: PRODUCTS, seed: 7 }).listen(0);
    const cid = Number(db.run(`INSERT INTO companies (name, site_url, currency, price_unit, woo_key_enc, woo_secret_enc, key_hint, webhook_secret, warehouse_id, created_at, updated_at)
      VALUES ('بنچ', ?, 'toman', 'toman', ?, ?, 'xxxx', ?, 1, ?, ?)`, shop.url, secrets.encrypt(shop.key), secrets.encrypt(shop.secret),
    crypto.randomBytes(16).toString('hex'), now, now).lastInsertRowid);

    let t0 = process.hrtime.bigint();
    await sync.fullSync(cid);
    const nProducts = db.get('SELECT COUNT(*) AS n FROM products').n;
    step('full sync (fake shop, local network)', t0, `${nProducts} products`);
    await shop.close();
    db.maintenance(() => db.run('UPDATE price_history SET effective_at = ?', new Date(Date.now() - (DAYS + 5) * 864e5).toISOString()));
    db.run('UPDATE products SET configured_at = ?, units_guessed = 0', now);

    const prods = db.all("SELECT id, name FROM products WHERE removed_at IS NULL AND regular_price IS NOT NULL AND regular_price > 0 ORDER BY id LIMIT 400");
    const listings = prods.map((p, i) => Number(db.run(`INSERT INTO listings (platform_id, product_id, code, title, units, search_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, (SELECT units_per_pack FROM products WHERE id = ?), ?, ?, ?)`, 1 + (i % 2), p.id, `B-${i}`, p.name, p.id,
    searchKey(`B-${i} ${p.name}`), now, now).lastInsertRowid));

    // Orders: PER_DAY a day, 1–3 lines each, spread over working hours
    t0 = process.hrtime.bigint();
    const lineIds = [];
    let n = 0;
    for (let d = DAYS; d >= 1; d--) {
      const day = Date.now() - d * 864e5;
      for (let i = 0; i < PER_DAY; i++) {
        const k = (d * 7919 + i * 104729) % listings.length;
        const lines = [{ listing_id: listings[k], qty: 1 + (i % 3 === 0 ? 1 : 0), platform_price: 120000 + (i % 50) * 1000 }];
        if (i % 4 === 0) lines.push({ listing_id: listings[(k + 13) % listings.length], qty: 1 });
        const id = orders.createOrder(as, { platform_id: 1 + (i % 2), order_number: `${d}-${i}`, ordered_at: new Date(day + (i % 600) * 60e3).toISOString(), lines });
        for (const r of db.all('SELECT id FROM order_lines WHERE order_id = ?', id)) lineIds.push(r.id);
        n++;
      }
    }
    const tOrders = ms(t0);
    rows.push(['create orders (library)', fmt(tOrders / n), `per order, ${n} orders / ${lineIds.length} lines`]);
    console.log(`orders: ${n} in ${fmt(tOrders)} ms`);

    t0 = process.hrtime.bigint();
    for (const id of lineIds) orders.receive(as, id, { outcome: 'ok' });
    rows.push(['receive a line (library)', fmt(ms(t0) / lineIds.length), `per line, ${lineIds.length} lines`]);

    // HTTP measurements
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-anbar': '1', 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'bench', password: 'bench-pass-123' }) });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const lastMonth = monthOf(new Date(Date.now() - 20 * 864e5).toISOString());
    const measure = async (label, method, url, body) => {
      const times = [];
      for (let i = 0; i < SAMPLES; i++) {
        const u = typeof url === 'function' ? url(i) : url;
        const b = typeof body === 'function' ? body(i) : body;
        const t = process.hrtime.bigint();
        const res = await app.inject({ method, url: u, headers: { cookie, 'x-anbar': '1', ...(b ? { 'content-type': 'application/json' } : {}) }, payload: b ? JSON.stringify(b) : undefined });
        times.push(ms(t));
        if (res.statusCode >= 400) throw new Error(`${label}: ${res.statusCode} ${res.body.slice(0, 200)}`);
      }
      rows.push([label, `${fmt(pct(times, 50))} / ${fmt(pct(times, 95))}`, 'p50 / p95 over HTTP']);
      console.log(`${label}: p50 ${fmt(pct(times, 50))} ms, p95 ${fmt(pct(times, 95))} ms`);
    };
    await measure('POST /api/orders (2 lines)', 'POST', '/api/orders', (i) => ({
      platform_id: 1, order_number: `http-${i}`, ordered_at: new Date(Date.now() - 3600e3).toISOString(),
      lines: [{ listing_id: listings[i % listings.length], qty: 1 }, { listing_id: listings[(i + 7) % listings.length], qty: 2 }]
    }));
    await measure('GET /api/orders (first page)', 'GET', '/api/orders');
    await measure('GET /api/orders?q= (search)', 'GET', (i) => `/api/orders?q=${encodeURIComponent(`${10 + (i % 30)}-1`)}`);
    await measure('GET /api/receiving', 'GET', `/api/receiving?company=${cid}`);
    await measure('GET /api/dashboard', 'GET', '/api/dashboard');
    await measure('GET /api/pick (picker search)', 'GET', (i) => `/api/pick?platform=1&q=${encodeURIComponent(prods[i % prods.length].name.split(' ')[0])}`);
    await measure('GET /api/products (list)', 'GET', `/api/products?company=${cid}`);
    await measure('GET /api/statements/month (draft)', 'GET', `/api/statements/month?company=${cid}&month=${lastMonth}`);
    await measure('GET /api/statements/overview', 'GET', '/api/statements/overview');

    t0 = process.hrtime.bigint();
    const sample = db.all('SELECT product_id, created_at FROM order_lines ORDER BY id LIMIT 5000');
    for (const l of sample) sync.priceAt(l.product_id, l.created_at);
    rows.push(['priceAt (price at the order time)', fmt(ms(t0) / sample.length), `per call, ${sample.length} calls`]);

    t0 = process.hrtime.bigint();
    statements.compute(cid, lastMonth);
    step('statement compute (one company, one month)', t0);

    t0 = process.hrtime.bigint();
    const report = integrity.run();
    step('integrity check (whole database)', t0, report.ok ? 'ok' : 'PROBLEMS: ' + report.results.filter((r) => !r.ok).map((r) => r.id).join(','));

    const size = fs.statSync(path.join(dataDir, 'anbar.db')).size + (fs.existsSync(path.join(dataDir, 'anbar.db-wal')) ? fs.statSync(path.join(dataDir, 'anbar.db-wal')).size : 0);
    rows.push(['database size', `${(size / 1048576).toFixed(1)} MB`, `${db.get('SELECT COUNT(*) AS n FROM stock_moves').n} stock moves, ${db.get('SELECT COUNT(*) AS n FROM audit_log').n} log rows`]);

    console.log(`\n| Step | ms | Note |\n|---|---:|---|\n${rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n')}`);
    console.log(`\nNode ${process.version}, ${os.cpus()[0].model} × ${os.cpus().length}, ${Math.round(os.totalmem() / 1073741824)} GB RAM`);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
