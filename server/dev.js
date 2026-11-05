'use strict';
/**
 * Development server.
 *   npm run dev    — the real database in ./data, background sync on
 *   npm run demo   — a fresh demo in .local/demo: three fake WooCommerce shops
 *                    (tools/mock-woo.js) whose prices change every few seconds
 *                    and push to Anbar like the WordPress plugin does.
 *                    Sign in with demo / demo-1234 (manager) or ali / demo-1234 (admin).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, root } = require('./config');
const { buildApp } = require('./app');

const DEMO_SHOPS = [
  { name: 'آوا پک', count: 320, seed: 11, currency: 'IRT', port: 8091 },
  { name: 'بازرگانی سبزینه', count: 260, seed: 22, currency: 'IRR', port: 8092 },
  { name: 'پخش البرز', count: 180, seed: 33, currency: 'IRT', port: 8093 }
];

async function demo(port) {
  const { createMockWoo } = require('../tools/mock-woo');
  const { hashPassword, nowIso } = require('./lib/util');
  const dataDir = path.join(root, '.local', 'demo');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const config = loadConfig({ dataDir, port, relaxLimits: true, publicUrl: `http://127.0.0.1:${port}` });
  const app = await buildApp(config);
  const { db, secrets, settings } = app.ctx;
  settings.set({ incremental_sync_minutes: 1, full_sync_minutes: 30 });

  const now = nowIso();
  const pw = await hashPassword('demo-1234');
  db.run("INSERT INTO users (username, name, role, phone, password_hash, created_at, updated_at) VALUES ('demo', 'مدیر نمونه', 'manager', '09120000000', ?, ?, ?)", pw, now, now);
  db.run("INSERT INTO users (username, name, role, password_hash, created_at, updated_at) VALUES ('ali', 'علی رضایی', 'admin', ?, ?, ?)", pw, now, now);

  const shops = [];
  for (const s of DEMO_SHOPS) {
    const shop = await createMockWoo({ name: s.name, count: s.count, seed: s.seed, currency: s.currency, key: `ck_demo_${s.seed}_${'x'.repeat(20)}`, secret: `cs_demo_${s.seed}_${'y'.repeat(20)}` }).listen(s.port);
    const hook = crypto.randomBytes(24).toString('base64url');
    const info = db.run(`INSERT INTO companies (name, site_url, currency, price_unit, woo_key_enc, woo_secret_enc, key_hint, webhook_secret, warehouse_id,
        contact_name, site_currency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    s.name, shop.url, s.currency === 'IRR' ? 'rial' : 'toman', s.currency === 'IRR' ? 'rial' : 'toman',
    secrets.encrypt(shop.key), secrets.encrypt(shop.secret), shop.key.slice(-4), hook, 'رابط ' + s.name, s.currency, now, now);
    shop.pushTo({ url: `${config.publicUrl}/hooks/woo/${info.lastInsertRowid}`, secret: hook });
    shops.push(shop);
  }
  await app.listen({ host: '127.0.0.1', port });
  for (const c of db.all('SELECT id FROM companies')) await app.ctx.sync.fullSync(c.id);
  seedOrders(app);
  // Prices keep moving so the live updates are visible
  setInterval(() => {
    const shop = shops[Math.floor(Math.random() * shops.length)];
    shop.randomChanges(1 + Math.floor(Math.random() * 2)).catch(() => {});
  }, 7000).unref();
  console.log(`\nDemo ready: http://127.0.0.1:${port}  (demo / demo-1234 manager, ali / demo-1234 admin)`);
  for (const s of shops) console.log(`  shop "${s.name}" ${s.url}`);
  return app;
}

/**
 * Demo only: pretend the shops were connected three days ago (so yesterday's orders have a
 * site price), add listings (some "25 of a 100-pack") and yesterday's orders, and receive a few
 * of them with different outcomes.
 */
function seedOrders(app) {
  const { db, orders } = app.ctx;
  const { nowIso, searchKey } = require('./lib/util');
  db.run("UPDATE price_history SET effective_at = ? WHERE source = 'import'", new Date(Date.now() - 3 * 864e5).toISOString());
  const manager = db.get("SELECT * FROM users WHERE username = 'demo'");
  const ali = db.get("SELECT * FROM users WHERE username = 'ali'");
  const as = (u) => ({ user: { id: u.id, name: u.name }, ip: '127.0.0.1' });
  // Units per pack as suggested from the names, confirmed
  db.run('UPDATE products SET configured_at = ?, units_guessed = 0 WHERE units_guessed = 1 AND id % 3 <> 0', nowIso());
  // Spread over the three companies
  const big = db.all("SELECT * FROM products WHERE type = 'variation' AND units_per_pack = 100 AND removed_at IS NULL ORDER BY (id * 7919) % 1009 LIMIT 30");
  const simple = db.all("SELECT * FROM products WHERE type <> 'variation' AND removed_at IS NULL ORDER BY (id * 7919) % 1009 LIMIT 40");
  const now = nowIso();
  const listings = [];
  big.forEach((p, i) => {
    const code = `DKPC-${7000 + i}`;
    const title = `${p.parent_name || p.name} - بسته ۲۵ عددی`;
    const id = Number(db.run(`INSERT INTO listings (platform_id, product_id, code, title, units, search_text, created_at, updated_at) VALUES (1, ?, ?, ?, 25, ?, ?, ?)`,
      p.id, code, title, searchKey(`${code} ${title} ${p.name}`), now, now).lastInsertRowid);
    listings.push({ id, units: 25, product: p });
  });
  simple.slice(0, 20).forEach((p, i) => {
    const code = `BSL-${300 + i}`;
    const id = Number(db.run(`INSERT INTO listings (platform_id, product_id, code, title, units, search_text, created_at, updated_at) VALUES (2, ?, ?, ?, ?, ?, ?, ?)`,
      p.id, code, p.name, p.units_per_pack, searchKey(`${code} ${p.name}`), now, now).lastInsertRowid);
    listings.push({ id, units: p.units_per_pack, product: p });
  });
  let n = 0;
  const { tehranDay, wall } = require('./lib/jalali');
  const [yy, ym, yd] = tehranDay(new Date(Date.now() - 864e5).toISOString()).date.split('-').map(Number);
  const yesterday = (h, m) => wall(yy, ym, yd, h, m);
  const lineIds = [];
  for (let i = 0; i < 24; i++) {
    const a = listings[(i * 7) % listings.length];
    const b = i % 4 === 0 ? listings[(i * 7 + 3) % listings.length] : null;
    const lines = [{ listing_id: a.id, qty: 1 + (i % 3 === 0 ? 1 : 0), platform_price: 100000 + i * 2500 }];
    if (b && b.id !== a.id) lines.push({ listing_id: b.id, qty: 1 });
    try {
      const id = orders.createOrder(as(i % 2 ? ali : manager), { platform_id: i % 3 === 2 ? 2 : 1, order_number: String(243180000 + i * 37), ordered_at: yesterday(9 + (i % 12), (i * 13) % 60), lines });
      lineIds.push(...db.all('SELECT id FROM order_lines WHERE order_id = ?', id).map((r) => r.id));
      n++;
    } catch (err) { console.warn('demo order skipped:', err.message); }
  }
  // Some arrived already: fine, too many (a 100-pack for a 25 listing), and one filled from that surplus
  const lineOf = (id) => db.get('SELECT * FROM order_lines WHERE id = ?', id);
  const tryReceive = (id, body) => { try { orders.receive(as(ali), id, body); } catch (err) { console.warn('demo receive skipped:', err.message); } };
  lineIds.slice(0, 5).forEach((id) => tryReceive(id, { outcome: 'ok' }));
  const partial = lineIds.map(lineOf).find((l) => l.units_per_sale === 25 && l.units_total === 25 && l.status === 'pending');
  if (partial) tryReceive(partial.id, { outcome: 'excess', arrived_units: 100 });
  const sameProduct = partial && lineIds.map(lineOf).find((l) => l.product_id === partial.product_id && l.status === 'pending');
  if (sameProduct) tryReceive(sameProduct.id, { outcome: 'short', arrived_units: 0, rest: 'stock' });
  console.log(`  demo: ${listings.length} listings, ${n} orders from yesterday`);
}

(async () => {
  const port = Number(process.env.PORT || 8080);
  if (process.argv.includes('--demo')) return demo(port);
  const config = loadConfig({ port });
  const app = await buildApp(config);
  await app.listen({ host: config.host, port });
  console.log(`Anbar (dev): http://${config.host}:${port}`);
})().catch((err) => { console.error(err); process.exit(1); });
