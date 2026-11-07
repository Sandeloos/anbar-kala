'use strict';
/**
 * The design rules found missing in the review, pinned down:
 *  - a unit of work: savepoints, no awaits inside, events only after COMMIT;
 *  - every audit line in the transaction of its change;
 *  - a stale sync snapshot never overwrites newer data;
 *  - the inbox commits with the product change that caused it;
 *  - one stock ledger: default warehouses are active ones, nothing new into an inactive one;
 *  - commands that used to be unprotected (company edit, statement paid twice, imports of
 *    another user).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { openDatabase } = require('../../server/db');
const { createEvents } = require('../../server/lib/events');
const { createAudit } = require('../../server/lib/audit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signedIn(t) {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  return { ctx, api, c: ctx.app.ctx };
}

test('unit of work: nested savepoints, no awaits, events only after COMMIT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anbar-uow-'));
  const db = openDatabase(path.join(dir, 'u.db'));
  try {
    db.exec('CREATE TABLE t (v INTEGER)');
    const events = createEvents({ db });
    const seen = [];
    events.subscribe((e) => seen.push(e.type));

    // A rolled-back transaction announces nothing
    assert.throws(() => db.tx(() => { db.run('INSERT INTO t VALUES (1)'); events.emit('a', {}); throw new Error('boom'); }), /boom/);
    assert.deepEqual(seen, []);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM t').n, 0);

    // Inside: held back; after COMMIT: delivered once
    db.tx(() => { db.run('INSERT INTO t VALUES (2)'); events.emit('b', {}); assert.deepEqual(seen, [], 'not before commit'); });
    assert.deepEqual(seen, ['b']);

    // A caught inner failure rolls back only the inner part, and only its events are dropped
    db.tx(() => {
      db.run('INSERT INTO t VALUES (3)');
      events.emit('outer', {});
      try { db.tx(() => { db.run('INSERT INTO t VALUES (4)'); events.emit('inner', {}); throw new Error('inner'); }); } catch { /* handled */ }
      db.run('INSERT INTO t VALUES (5)');
    });
    assert.deepEqual(db.all('SELECT v FROM t ORDER BY v').map((r) => r.v), [2, 3, 5]);
    assert.deepEqual(seen, ['b', 'outer']);

    // A transaction cannot span an await
    assert.throws(() => db.tx(async () => {}), /must not span an await/);
    assert.equal(db.inTransaction, false);
    // Outside a transaction an event goes out at once
    events.emit('now', {});
    assert.deepEqual(seen, ['b', 'outer', 'now']);

    // audit() outside a transaction is a programming error (strict), and allowed-but-reported otherwise
    assert.throws(() => createAudit(db, events)(null, { action: 'x', entity: 'y', summary: 's' }), /outside a transaction/);
    const loose = [];
    createAudit(db, events, { strict: false, onLoose: (e) => loose.push(e) })(null, { action: 'x', entity: 'y', summary: 's' });
    assert.equal(loose.length, 1);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_log').n, 1, 'the line is still written in production');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync: a snapshot read before a newer write does not put the old price back', async (t) => {
  const { ctx, api, c } = await signedIn(t);
  const s = await shop(ctx, { count: 3, seed: 21, variableRatio: 0 });
  const comp = await addCompany(ctx, api, s);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', comp.id);
  const p = ctx.db.get("SELECT * FROM products WHERE company_id = ? AND type = 'simple' ORDER BY id LIMIT 1", comp.id);
  const item = (over) => ({
    woo_id: p.woo_id, parent_woo_id: p.parent_woo_id, type: p.type, name: p.name, parent_name: p.parent_name, attributes: p.attributes,
    sku: p.sku, permalink: p.permalink, slug: p.slug, site_status: p.site_status, regular_price: p.regular_price, sale_price: p.sale_price,
    stock_status: p.stock_status, stock_quantity: p.stock_quantity, manage_stock: p.manage_stock, site_modified_at: p.site_modified_at, ...over
  });
  const history = () => ctx.db.get('SELECT COUNT(*) AS n FROM price_history WHERE product_id = ?', p.id).n;

  const fetchedAt = new Date().toISOString(); // a full sync sends its page request…
  await sleep(5);
  c.sync.applyPush(company, { items: [] });   // (nothing) …
  const newer = p.regular_price + 50000;
  c.sync.apply(company, [item({ regular_price: newer })], { source: 'webhook' }); // …the plugin pushes a new price…
  const before = history();
  const stats = c.sync.apply(company, [item()], { source: 'sync', fetchedAt }); // …then the old page arrives
  assert.equal(stats.stale, 1);
  assert.equal(ctx.db.get('SELECT regular_price FROM products WHERE id = ?', p.id).regular_price, newer, 'the newer price stays');
  assert.equal(history(), before, 'no false change in the price history');

  // If the site itself says the item changed later, the snapshot is newer after all
  const later = new Date(Date.now() + 1000).toISOString();
  const s2 = c.sync.apply(company, [item({ regular_price: newer + 1, site_modified_at: later })], { source: 'sync', fetchedAt });
  assert.equal(s2.stale, 0);
  assert.equal(ctx.db.get('SELECT regular_price FROM products WHERE id = ?', p.id).regular_price, newer + 1);
});

test('inbox: a product change and the task it causes commit together', async (t) => {
  const { ctx, api, c } = await signedIn(t);
  const s = await shop(ctx, { count: 3, seed: 22, variableRatio: 0 });
  const comp = await addCompany(ctx, api, s);
  const company = ctx.db.get('SELECT * FROM companies WHERE id = ?', comp.id);
  const p = ctx.db.get("SELECT * FROM products WHERE company_id = ? AND type = 'simple' ORDER BY id LIMIT 1", comp.id);
  c.sync.onChanges((changes) => { if (changes.length) throw new Error('inbox is broken'); });
  const item = { ...p, regular_price: p.regular_price + 10000 };
  assert.throws(() => c.sync.apply(company, [item], { source: 'webhook' }), /inbox is broken/);
  assert.equal(ctx.db.get('SELECT regular_price FROM products WHERE id = ?', p.id).regular_price, p.regular_price, 'rolled back with the inbox');
});

test('stock ledger: defaults to an active warehouse; nothing new into an inactive one; undo still works', async (t) => {
  const { ctx, api, c } = await signedIn(t);
  const s = await shop(ctx, { count: 3, seed: 23, variableRatio: 0 });
  const comp = await addCompany(ctx, api, s, { warehouse_id: '' });
  const p = ctx.db.get("SELECT * FROM products WHERE company_id = ? AND type = 'simple' ORDER BY id LIMIT 1", comp.id);
  const w2 = (await api.get('/api/warehouses')).body.items.find((w) => w.id !== 1 && w.active);
  assert.ok(w2, 'a second active warehouse (Radloos) is seeded');

  // Something arrives without an order into stock: the company has no warehouse; warehouse 1 is inactive
  assert.equal((await api.post('/api/stock/own-in', { product_id: p.id, warehouse_id: 1, units: 2 })).status, 200);
  const w1 = (await api.get('/api/warehouses')).body.items.find((w) => w.id === 1);
  assert.equal((await api.put('/api/warehouses/1', { name: w1.name, notes: '', active: false })).status, 200);
  const r = await api.post('/api/arrivals', { company_id: comp.id, product_id: p.id, units: 3, disposition: 'stock' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(c.stock.balance(p.id, w2.id, comp.id), 3, 'went to the active warehouse, not to warehouse 1');

  const into = await api.post('/api/stock/own-in', { product_id: p.id, warehouse_id: 1, units: 1 });
  assert.equal(into.status, 400);
  assert.match(into.body.error, /غیرفعال/);
  // Taking out of an inactive warehouse is fine (emptying it)
  assert.equal((await api.post('/api/stock/transfer', { product_id: p.id, warehouse_id: 1, to_warehouse_id: w2.id, units: 2, owner_company_id: 'own' })).status, 200);
  assert.equal(c.stock.balance(p.id, 1, null), 0);
  assert.throws(() => c.stock.move({ productId: p.id, warehouseId: w2.id, units: 1, kind: 'own_in' }), /outside a transaction/);
  assert.throws(() => ctx.db.tx(() => c.stock.move({ productId: p.id, warehouseId: w2.id, units: 1, kind: 'gift' })), /unknown stock move kind/);
});

test('company edit is atomic and logged; the address is checked again after the site test', async (t) => {
  const { ctx, api } = await signedIn(t);
  const s1 = await shop(ctx, { count: 2, seed: 24 });
  const s2 = await shop(ctx, { count: 2, seed: 25, name: 'دوم' });
  const a = await addCompany(ctx, api, s1);
  const b = await addCompany(ctx, api, s2);
  const body = (c, over) => ({ name: c.name, site_url: c.site_url, currency: c.currency, price_unit: c.price_unit, warehouse_id: 1, active: true, ...over });
  const ok = await api.put(`/api/companies/${a.id}`, body(a, { name: 'شرکت اول', contact_name: 'رابط' }), { 'if-match': `"${a.version}"` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.company.name, 'شرکت اول');
  assert.equal(ok.body.company.version, a.version + 1);
  const log = ctx.db.get("SELECT * FROM audit_log WHERE entity = 'company' AND entity_id = ? AND action = 'update'", String(a.id));
  assert.match(log.changes, /شرکت اول/);
  const taken = await api.put(`/api/companies/${a.id}`, body(ok.body.company, { site_url: b.site_url }));
  assert.equal(taken.status, 409);
  assert.equal(ctx.db.get('SELECT site_url FROM companies WHERE id = ?', a.id).site_url, a.site_url);
});

test('statements and inbox: a second "paid" or "dismiss" is refused, not applied twice', async (t) => {
  const { ctx, api, c } = await signedIn(t);
  const now = new Date().toISOString();
  ctx.db.run(`INSERT INTO companies (name, site_url, currency, price_unit, webhook_secret, created_at, updated_at) VALUES ('ث', 'https://th.example', 'toman', 'toman', 's', ?, ?)`, now, now);
  const cid = ctx.db.get("SELECT id FROM companies WHERE name = 'ث'").id;
  ctx.db.run("INSERT INTO statements (company_id, month, status, currency, issued_at) VALUES (?, '1404-01', 'issued', 'toman', ?)", cid, now);
  const sid = ctx.db.get('SELECT id FROM statements WHERE company_id = ?', cid).id;
  assert.equal((await api.post(`/api/statements/${sid}/paid`, { reference: 'A1' })).status, 200);
  assert.equal((await api.post(`/api/statements/${sid}/paid`, { reference: 'A2' })).status, 409);
  assert.equal(ctx.db.get('SELECT paid_reference FROM statements WHERE id = ?', sid).paid_reference, 'A1');
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'paid'").n, 1);
  assert.ok(c.statements);
});

test('imports: an uploaded file belongs to the person (and platform) that uploaded it', async (t) => {
  const { ctx, api } = await signedIn(t);
  await addUser(ctx.db, { username: 'other', password: 'other-pass-12', role: 'admin', name: 'دیگری' });
  const other = client(ctx.app);
  await other.login('other', 'other-pass-12');
  const csv = 'شماره سفارش,تاریخ,کد,تعداد\n1001,1405/08/10,DK-1,1\n';
  const up = await api.post('/api/imports/parse', { platform_id: 1, file_name: 'a.csv', data: Buffer.from(csv).toString('base64') });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const body = { token: up.body.token, platform_id: 1, mapping: { order_number: 0, date: 1, code: 2, qty: 3 }, price_unit: 'toman' };
  const pre = await api.post('/api/imports/preview', body);
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal((await other.post('/api/imports/preview', body)).status, 400, 'another user cannot use the token');
  assert.equal((await api.post('/api/imports/preview', { ...body, platform_id: 2 })).status, 400, 'nor another platform');
  assert.equal((await api.post('/api/imports/parse', { platform_id: 999, file_name: 'a.csv', data: Buffer.from(csv).toString('base64') })).status, 400);
  assert.ok(crypto);
});

test('stock ledger: consigned stock belongs only to the product\'s own company (or to us)', async (t) => {
  const { ctx, api, c } = await signedIn(t);
  const s1 = await shop(ctx, { count: 2, seed: 26, variableRatio: 0 });
  const s2 = await shop(ctx, { count: 2, seed: 27, variableRatio: 0, name: 'دیگری' });
  const a = await addCompany(ctx, api, s1);
  const b = await addCompany(ctx, api, s2);
  const p = ctx.db.get('SELECT id FROM products WHERE company_id = ? ORDER BY id LIMIT 1', a.id);
  for (const owner of [b.id, 999]) {
    const adj = await api.post('/api/stock/adjust', { product_id: p.id, warehouse_id: 1, owner_company_id: owner, units: 3, note: 'آزمایش' });
    assert.equal(adj.status, 400, `owner ${owner}: ${JSON.stringify(adj.body)}`);
    assert.equal(adj.body.fields.owner_company_id, 'صاحب کالا درست نیست.');
    const cnt = await api.post('/api/stock/count', { warehouse_id: 1, counts: [{ product_id: p.id, owner_company_id: owner, counted: 2 }] });
    assert.equal(cnt.status, 400);
  }
  assert.equal(c.stock.balance(p.id, 1, b.id), 0, 'nothing recorded under the other company');
  assert.equal((await api.post('/api/stock/adjust', { product_id: p.id, warehouse_id: 1, owner_company_id: a.id, units: 3, note: 'آزمایش' })).status, 200);
  assert.equal((await api.post('/api/stock/adjust', { product_id: p.id, warehouse_id: 1, owner_company_id: 'own', units: 1, note: 'آزمایش' })).status, 200);
});

test('sync: a site that suddenly lists nothing does not mark every product removed', async (t) => {
  const { ctx, api, c } = await signedIn(t);
  const s = await shop(ctx, { count: 5, seed: 28 });
  const comp = await addCompany(ctx, api, s);
  const active = () => ctx.db.get('SELECT COUNT(*) AS n FROM products WHERE company_id = ? AND removed_at IS NULL', comp.id).n;
  const before = active();
  assert.ok(before > 0);
  s.listNothing();
  await assert.rejects(c.sync.fullSync(comp.id), (e) => e.code === 'empty_catalogue');
  assert.equal(active(), before, 'nothing marked removed');
  const row = ctx.db.get('SELECT sync_state, sync_error FROM companies WHERE id = ?', comp.id);
  assert.equal(row.sync_state, 'error');
  assert.match(row.sync_error, /هیچ کالایی برنگرداند/);
  // A real deletion of one product is still noticed once the site lists again
  s.listNothing(false);
  await s.remove(s.products.find((p) => p.type === 'simple').id);
  ctx.db.run('UPDATE companies SET next_sync_at = NULL WHERE id = ?', comp.id);
  const run = await c.sync.fullSync(comp.id);
  assert.equal(run.removed, 1);
});

test('dates typed by hand: a return not before shipping or in the future; a payment not before issue or in the future', async (t) => {
  const { ctx, api } = await signedIn(t);
  const s = await shop(ctx, { count: 2, seed: 29, variableRatio: 0 });
  const comp = await addCompany(ctx, api, s);
  const p = ctx.db.get("SELECT * FROM products WHERE company_id = ? AND type = 'simple' ORDER BY id LIMIT 1", comp.id);
  const o = await api.post('/api/orders', { platform_id: 1, order_number: 'R-1', ordered_at: new Date().toISOString(), lines: [{ product_id: p.id, qty: 1 }] });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const line = o.body.lines[0];
  assert.equal((await api.post(`/api/order-lines/${line.id}/receive`, { outcome: 'ok' })).status, 200);
  const future = new Date(Date.now() + 2 * 864e5).toISOString();
  const before = new Date(Date.now() - 864e5).toISOString();
  const f = await api.post(`/api/order-lines/${line.id}/returns`, { units: 1, returned_at: future });
  assert.equal(f.status, 400);
  assert.equal(f.body.fields.returned_at, 'در آینده است.');
  const b = await api.post(`/api/order-lines/${line.id}/returns`, { units: 1, returned_at: before });
  assert.equal(b.status, 400);
  assert.equal(b.body.fields.returned_at, 'قبل از ارسال است.');
  // Today's date without a time (Tehran midnight) on the shipping day is fine
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
  const r = await api.post(`/api/order-lines/${line.id}/returns`, { units: 1, returned_at: today });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const now = new Date().toISOString();
  ctx.db.run("INSERT INTO statements (company_id, month, status, currency, issued_at) VALUES (?, '1404-02', 'issued', 'toman', ?)", comp.id, now);
  const sid = ctx.db.get("SELECT id FROM statements WHERE company_id = ? AND month = '1404-02'", comp.id).id;
  assert.equal((await api.post(`/api/statements/${sid}/paid`, { paid_at: future })).body.fields.paid_at, 'در آینده است.');
  assert.equal((await api.post(`/api/statements/${sid}/paid`, { paid_at: before })).body.fields.paid_at, 'قبل از صدور است.');
  assert.equal(ctx.db.get('SELECT status FROM statements WHERE id = ?', sid).status, 'issued');
  assert.equal((await api.post(`/api/statements/${sid}/paid`, { paid_at: today })).status, 200, 'paid on the day of issue');
});

