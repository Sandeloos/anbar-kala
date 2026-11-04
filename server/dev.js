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
  // Prices keep moving so the live updates are visible
  setInterval(() => {
    const shop = shops[Math.floor(Math.random() * shops.length)];
    shop.randomChanges(1 + Math.floor(Math.random() * 2)).catch(() => {});
  }, 7000).unref();
  console.log(`\nDemo ready: http://127.0.0.1:${port}  (demo / demo-1234 manager, ali / demo-1234 admin)`);
  for (const s of shops) console.log(`  shop "${s.name}" ${s.url}`);
  return app;
}

(async () => {
  const port = Number(process.env.PORT || 8080);
  if (process.argv.includes('--demo')) return demo(port);
  const config = loadConfig({ port });
  const app = await buildApp(config);
  await app.listen({ host: config.host, port });
  console.log(`Anbar (dev): http://${config.host}:${port}`);
})().catch((err) => { console.error(err); process.exit(1); });
