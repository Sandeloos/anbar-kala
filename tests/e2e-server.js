'use strict';
/**
 * Server for the Playwright tests: a fresh database, a manager (boss / boss-password-1)
 * and an admin (ali / ali-password-1), two fake WooCommerce shops:
 *   - "شرکت آزمایشی" on :4181, already added and synced, pushing changes like the plugin
 *   - "شرکت دوم" on :4182, not added yet (the tests add it through the wizard)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('../server/config');
const { buildApp } = require('../server/app');
const { hashPassword, nowIso } = require('../server/lib/util');
const { createMockWoo } = require('../tools/mock-woo');

(async () => {
  const port = Number(process.env.E2E_PORT || 4180);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-e2e-'));
  const config = loadConfig({ dataDir, port, jobs: false, relaxLimits: true, secret: 'e2e', publicUrl: `http://127.0.0.1:${port}` });
  const app = await buildApp(config, { logger: false });
  const { db, secrets } = app.ctx;
  const now = nowIso();
  db.run("INSERT INTO users (username, name, role, password_hash, created_at, updated_at) VALUES ('boss', 'مدیر آزمایشی', 'manager', ?, ?, ?)", await hashPassword('boss-password-1'), now, now);
  db.run("INSERT INTO users (username, name, role, password_hash, created_at, updated_at) VALUES ('ali', 'علی رضایی', 'admin', ?, ?, ?)", await hashPassword('ali-password-1'), now, now);

  const one = await createMockWoo({ name: 'شرکت آزمایشی', count: 60, seed: 42, key: 'ck_e2e_one_000000000001', secret: 'cs_e2e_one_000000000001' }).listen(4181);
  await createMockWoo({ name: 'شرکت دوم', count: 25, seed: 43, key: 'ck_e2e_two_000000000002', secret: 'cs_e2e_two_000000000002', currency: 'IRR' }).listen(4182);
  const hook = crypto.randomBytes(18).toString('base64url');
  const info = db.run(`INSERT INTO companies (name, site_url, currency, price_unit, woo_key_enc, woo_secret_enc, key_hint, webhook_secret, warehouse_id, created_at, updated_at)
    VALUES (?, ?, 'toman', 'toman', ?, ?, ?, ?, 1, ?, ?)`, one.name, one.url, secrets.encrypt(one.key), secrets.encrypt(one.secret), one.key.slice(-4), hook, now, now);
  one.pushTo({ url: `${config.publicUrl}/hooks/woo/${info.lastInsertRowid}`, secret: hook });
  await app.listen({ host: '127.0.0.1', port });
  await app.ctx.sync.fullSync(Number(info.lastInsertRowid));
  console.log(`e2e server on ${port}`);
})().catch((err) => { console.error(err); process.exit(1); });
