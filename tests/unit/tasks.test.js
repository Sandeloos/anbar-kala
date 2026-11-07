'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { suggest } = require('../../server/lib/tasks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t) {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 4, seed: 31, variableRatio: 0 });
  const company = await addCompany(ctx, api, s);
  const [w1, w2] = s.products;
  const p1 = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', w1.id);
  const p2 = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', w2.id);
  // p1 on Digikala (with our price there) and on the company site; p2 only on the company site
  const dk = (await api.post('/api/listings', { platform_id: 1, product_id: p1.id, code: 'DK-1', units: p1.units_per_pack, platform_price: '500000' })).body.listing;
  await api.post('/api/listings', { platform_id: 3, product_id: p1.id, code: 'SITE-1', units: p1.units_per_pack });
  await api.post('/api/listings', { platform_id: 3, product_id: p2.id, code: 'SITE-2', units: p2.units_per_pack });
  return { ctx, api, s, company, p1, p2, w1, w2, dk };
}

test('suggested platform price keeps the margin, rounded to 100 tomans', () => {
  assert.equal(suggest(5000000, 4000000, 4400000), 5500000);
  assert.equal(suggest(5000000, 3000000, 3100000), 5167000);
  assert.equal(suggest(null, 1, 2), null);
});

test('inbox: a site price change makes one task per platform listing; later changes update it; done sets our price', async (t) => {
  const { ctx, api, s, company, p1, p2, w1, w2, dk } = await setup(t);
  const original = Number(w1.regular_price);
  await sleep(1100);
  await s.setPrice(w1.id, original * 1.1);
  await s.setPrice(w2.id, Number(w2.regular_price) * 2);
  await ctx.app.ctx.sync.incrementalSync(company.id);
  let open = (await api.get('/api/tasks')).body.items;
  assert.equal(open.length, 1, 'site-only listings make no task');
  const task = open[0];
  assert.equal(task.kind, 'price');
  assert.equal(task.listing_code, 'DK-1');
  assert.equal(task.site_price_before, p1.regular_price);
  assert.equal(task.site_price_after, Math.round(original * 1.1) * 10);
  assert.equal(task.suggested_price, suggest(5000000, p1.regular_price, Math.round(original * 1.1) * 10));
  void p2;

  // Another change before anyone acted: same task, new numbers
  await sleep(1100);
  await s.setPrice(w1.id, original * 1.2);
  await ctx.app.ctx.sync.incrementalSync(company.id);
  open = (await api.get('/api/tasks')).body.items;
  assert.equal(open.length, 1);
  assert.equal(open[0].changes, 2);
  assert.equal(open[0].site_price_after, Math.round(original * 1.2) * 10);

  assert.equal((await api.post(`/api/tasks/${task.id}/done`, {})).status, 400, 'the price set on the platform is required');
  const done = await api.post(`/api/tasks/${task.id}/done`, { platform_price: '۶۰۰,۰۰۰' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.task.status, 'done');
  assert.equal(ctx.db.get('SELECT platform_price FROM listings WHERE id = ?', dk.id).platform_price, 6000000);
  assert.equal((await api.get('/api/tasks')).body.items.length, 0);
  const log = ctx.db.get("SELECT * FROM audit_log WHERE action = 'done'");
  assert.match(log.summary, /کارتابل/);
  assert.equal(JSON.parse(log.changes)[0].to, 6000000);
});

test('inbox: a price that changes back closes the task by itself; stock out and back in', async (t) => {
  const { ctx, api, s, company, w1 } = await setup(t);
  const original = Number(w1.regular_price);
  await sleep(1100);
  await s.setPrice(w1.id, original + 1000);
  await ctx.app.ctx.sync.incrementalSync(company.id);
  await sleep(1100);
  await s.setPrice(w1.id, original);
  await ctx.app.ctx.sync.incrementalSync(company.id);
  assert.equal((await api.get('/api/tasks')).body.items.length, 0);
  assert.equal((await api.get('/api/tasks?status=closed')).body.items[0].status, 'reverted');

  // Stock changes from orders do not touch date_modified: the full sync (or the plugin) sees them
  await s.setStock(w1.id, 0);
  await ctx.app.ctx.sync.fullSync(company.id);
  let open = (await api.get('/api/tasks?kind=stock')).body.items;
  assert.equal(open.length, 1);
  assert.equal(open[0].stock_after, 'outofstock');
  await s.setStock(w1.id, 50);
  await ctx.app.ctx.sync.fullSync(company.id);
  open = (await api.get('/api/tasks?kind=stock')).body.items;
  assert.equal(open.length, 0, 'back in stock before anyone acted');

  // Low stock (at or below the limit) makes a task; dismissing needs a reason
  await s.setStock(w1.id, 3);
  await ctx.app.ctx.sync.fullSync(company.id);
  open = (await api.get('/api/tasks?kind=stock')).body.items;
  assert.equal(open.length, 1);
  assert.equal((await api.post(`/api/tasks/${open[0].id}/dismiss`, {})).status, 400);
  assert.equal((await api.post(`/api/tasks/${open[0].id}/dismiss`, { note: 'در دیجی‌کالا موجودی جدا داریم' })).body.task.status, 'dismissed');
});

test('backups: manual backup is a working copy; old ones are pruned; system page is for the manager', async (t) => {
  const { ctx, api } = await setup(t);
  const { addUser: add } = require('./helpers');
  const b = await api.post('/api/system/backup');
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const file = ctx.app.ctx.backups.file(b.body.backup.name);
  assert.ok(fs.existsSync(file));
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0, 'the copy has the data');
  copy.close();

  ctx.app.ctx.settings.set({ backup_keep: 2 });
  for (let i = 0; i < 3; i++) { await sleep(1050); await api.post('/api/system/backup'); }
  assert.equal(ctx.app.ctx.backups.list().length, 2);

  const sys = await api.get('/api/system');
  assert.equal(sys.body.backups.length, 2);
  assert.ok(sys.body.counts.products > 0);
  const dl = await ctx.app.inject({ method: 'GET', url: `/api/system/backups/${sys.body.backups[0].name}`, headers: { cookie: api.cookie } });
  assert.equal(dl.statusCode, 200);
  assert.equal((await api.get('/api/system/backups/..%2Fanbar.db')).status, 404);

  await add(ctx.db, { username: 'ali', password: 'ali-pass-1', role: 'admin' });
  const ali = client(ctx.app);
  await ali.login('ali', 'ali-pass-1');
  assert.equal((await ali.get('/api/system')).status, 403);
  assert.equal((await ali.post('/api/system/backup')).status, 403);
});
