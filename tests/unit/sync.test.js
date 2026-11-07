'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeApp, addUser, client, shop, addCompany, waitFor } = require('./helpers');
const { normalise, effectiveTime, decodeEntities } = require('../../server/lib/sync');
const { toRial } = require('../../server/lib/util');

test('normalise: prices to rials, variation names, entities, parent stock', () => {
  assert.equal(toRial('120000', 'toman'), 1200000);
  assert.equal(toRial('120000.5', 'toman'), 1200005);
  assert.equal(toRial('۱۲۰٬۰۰۰'.replace('٬', ''), 'rial'), 120000);
  assert.equal(toRial('120', 'thousand_toman'), 1200000);
  assert.equal(toRial('', 'toman'), null);
  assert.equal(decodeEntities('لیوان &amp; نی &#8211; سفید'), 'لیوان & نی – سفید');

  const parent = { id: 10, name: 'لیوان کاغذی', slug: 'cup', stock_quantity: 40, permalink: 'https://x.ir/product/cup/' };
  const v = normalise({
    id: 11, regular_price: '50000', sale_price: '50000', stock_status: 'instock', manage_stock: 'parent', stock_quantity: null,
    attributes: [{ name: 'تعداد در بسته', option: '25 عددی' }], date_modified_gmt: '2026-11-01T10:00:00'
  }, 'toman', parent);
  assert.equal(v.name, 'لیوان کاغذی - 25 عددی');
  assert.equal(v.attributes, 'تعداد در بسته: 25 عددی');
  assert.equal(v.regular_price, 500000);
  assert.equal(v.sale_price, null, 'a sale price equal to the regular price is not a discount');
  assert.equal(v.stock_quantity, 40, 'manage_stock=parent uses the parent quantity');
  assert.equal(v.site_modified_at, '2026-11-01T10:00:00.000Z');
  assert.equal(v.permalink, parent.permalink);
  assert.equal(normalise({ id: 1, type: 'variable' }, 'toman'), null);
});

test('effectiveTime: uses the site modified time only inside the window since the last check', () => {
  const last = '2026-11-04T10:00:00.000Z', now = '2026-11-04T10:10:00.000Z';
  assert.equal(effectiveTime('2026-11-04T10:04:00.000Z', last, now), '2026-11-04T10:04:00.000Z');
  assert.equal(effectiveTime('2026-11-04T09:00:00.000Z', last, now), now, 'older than the last check: we would have seen it');
  assert.equal(effectiveTime('2026-11-04T10:12:00.000Z', last, now), now, 'clock skew is clamped');
  assert.equal(effectiveTime(null, last, now), now);
});

test('company: connection test, full sync with variations, price history and price-at', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 30, seed: 7, currency: 'IRT' });

  const bad = await api.post('/api/companies/test', { site_url: s.url, key: s.key, secret: 'cs_wrong_secret_0000' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /کلید یا رمز/);

  const ok = await api.post('/api/companies/test', { site_url: s.url, key: s.key, secret: s.secret });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.price_unit, 'toman');
  assert.equal(ok.body.productCount, 30);

  const company = await addCompany(ctx, api, s);
  const sellable = s.all().filter((p) => p.type !== 'variable');
  const count = ctx.db.get('SELECT COUNT(*) AS n FROM products WHERE company_id = ?', company.id).n;
  assert.equal(count, sellable.length, 'every simple product and every variation is imported');
  const variation = sellable.find((p) => p.parent_id);
  assert.ok(variation, 'the fake shop has variable products');
  const row = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', variation.id);
  assert.equal(row.type, 'variation');
  assert.equal(row.regular_price, Number(variation.regular_price) * 10);
  assert.ok(row.name.includes('عددی'));

  // A price change on the site, then an incremental sync
  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));
  await s.setPrice(variation.id, 99900);
  const run = await ctx.app.ctx.sync.incrementalSync(company.id);
  assert.equal(run.priceChanges, 1);
  const after = ctx.db.get('SELECT * FROM products WHERE id = ?', row.id);
  assert.equal(after.regular_price, 999000);
  const hist = ctx.db.all('SELECT * FROM price_history WHERE product_id = ? ORDER BY id', row.id);
  assert.equal(hist.length, 2);
  assert.equal(hist[1].source, 'sync');

  // price-at: before the change → old price, now → new price
  const old = await api.get(`/api/products/${row.id}/price-at?at=${encodeURIComponent(before)}`);
  assert.equal(old.body.price.regular_price, row.regular_price);
  const cur = await api.get(`/api/products/${row.id}/price-at`);
  assert.equal(cur.body.price.regular_price, 999000);

  // The change feed shows the previous price
  const feed = await api.get('/api/changes');
  assert.equal(feed.body.items[0].prev_regular_price, row.regular_price);
  assert.equal(feed.body.items[0].regular_price, 999000);
});

test('full sync notices deleted products; refresh reads one product now', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 12, seed: 3, variableRatio: 0 });
  const company = await addCompany(ctx, api, s);

  const gone = s.products[0];
  await s.remove(gone.id);
  const run = await ctx.app.ctx.sync.fullSync(company.id);
  assert.equal(run.removed, 1);
  assert.ok(ctx.db.get('SELECT removed_at FROM products WHERE woo_id = ?', gone.id).removed_at);

  const p = s.products[1];
  await s.setStock(p.id, 0);
  const id = ctx.db.get('SELECT id FROM products WHERE woo_id = ?', p.id).id;
  const r = await api.post(`/api/products/${id}/refresh`);
  assert.equal(r.status, 200);
  assert.equal(r.body.product.stock_status, 'outofstock');
  assert.equal(r.body.history[0].stock_changed, 1);
  assert.equal(r.body.history[0].price_changed, 0);
});

test('sites without pretty links and hosts that drop the auth header are detected', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 5, pretty: false, acceptHeaderAuth: false, currency: 'IRR' });
  const r = await api.post('/api/companies/test', { site_url: s.url, key: s.key, secret: s.secret });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.apiStyle, 'rest_route');
  assert.equal(r.body.authMode, 'query');
  assert.equal(r.body.price_unit, 'rial');
  const company = await addCompany(ctx, api, s, { currency: 'rial', price_unit: 'rial' });
  assert.equal(ctx.db.get('SELECT COUNT(*) AS n FROM products WHERE company_id = ?', company.id).n, s.all().filter((p) => p.type !== 'variable').length);
});

test('webhook: signed pushes update prices instantly; bad signatures are refused', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 8, seed: 5 });
  const company = await addCompany(ctx, api, s);
  const secret = ctx.db.get('SELECT webhook_secret FROM companies WHERE id = ?', company.id).webhook_secret;

  // The fake shop pushes like the plugin; deliver through inject (no real network needed)
  const pushed = [];
  const send = async (payload, { key = secret, ts = Math.floor(Date.now() / 1000) } = {}) => {
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
    const res = await ctx.app.inject({ method: 'POST', url: `/hooks/woo/${company.id}`, payload: body,
      headers: { 'content-type': 'application/json', 'x-anbar-timestamp': String(ts), 'x-anbar-signature': 'sha256=' + sig } });
    pushed.push(res.statusCode);
    return res;
  };
  const p = s.all().find((x) => x.type !== 'variable' && !x.parent_id) || s.all().find((x) => x.parent_id);
  const item = { ...p, regular_price: '777000', date_modified_gmt: new Date().toISOString().slice(0, 19) };
  delete item._variations;
  if (p.parent_id) { const par = s.products.find((x) => x.id === p.parent_id); item.parent = { id: par.id, name: par.name, slug: par.slug }; }

  assert.equal((await send({ items: [item] }, { key: 'wrong' })).statusCode, 401);
  assert.equal((await send({ items: [item] }, { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode, 401);
  const res = await send({ items: [item] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().priceChanges, 1);
  const row = ctx.db.get('SELECT regular_price FROM products WHERE company_id = ? AND woo_id = ?', company.id, p.id);
  assert.equal(row.regular_price, 7770000);
  assert.equal(ctx.db.get("SELECT source FROM price_history ORDER BY id DESC LIMIT 1").source, 'webhook');
  const ping = await send({ ping: true });
  assert.equal(ping.json().ok, true);
  assert.ok(ctx.db.get('SELECT last_webhook_at FROM companies WHERE id = ?', company.id).last_webhook_at);
  await waitFor(() => true);
});

test('lookup by link: a variation link finds that variation; unknown sites are refused', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 20, seed: 9, variableRatio: 1 });
  await addCompany(ctx, api, s);
  const parent = s.products[0];
  const v100 = parent._variations[1];
  const r = await api.post('/api/products/lookup', { url: v100.permalink });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 2);
  const matched = r.body.items.find((i) => i.id === r.body.matched);
  assert.equal(matched.woo_id, v100.id);
  const no = await api.post('/api/products/lookup', { url: 'https://example.com/product/x/' });
  assert.equal(no.status, 400);
});

test('manual price: recorded with reason and user, then replaced by the next site change', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 4, seed: 4, variableRatio: 0 });
  const company = await addCompany(ctx, api, s);
  const p = s.products[0];
  const id = ctx.db.get('SELECT id FROM products WHERE woo_id = ?', p.id).id;

  const missingReason = await api.post(`/api/products/${id}/manual-price`, { regular_price: '150000' });
  assert.equal(missingReason.status, 400);
  const r = await api.post(`/api/products/${id}/manual-price`, { regular_price: '۱۵۰,۰۰۰', note: 'سایت از دسترس خارج بود' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.product.regular_price, 1500000);
  assert.equal(r.body.product.price_source, 'manual');
  assert.equal(r.body.history[0].source, 'manual');
  assert.equal(r.body.history[0].user_name, 'مدیر');
  const log = ctx.db.get("SELECT * FROM audit_log WHERE action = 'price'");
  assert.match(log.summary, /سایت از دسترس خارج بود/);

  await new Promise((r2) => setTimeout(r2, 1100));
  await s.setPrice(p.id, 160000);
  await ctx.app.ctx.sync.incrementalSync(company.id);
  const after = ctx.db.get('SELECT regular_price, price_source FROM products WHERE id = ?', id);
  assert.equal(after.regular_price, 1600000);
  assert.equal(after.price_source, 'site');
});

test('units per pack are suggested from the product name, nearest the end', () => {
  const { guessUnits } = require('../../server/lib/sync');
  assert.equal(guessUnits('لیوان کاغذی ۲۲۰ سی‌سی بسته ۵۰ عددی'), 50);
  assert.equal(guessUnits('جعبه پیتزا ۲۶ سانت - 100 عددی'), 100);
  assert.equal(guessUnits('قاشق ۲۵تایی'), 25);
  assert.equal(guessUnits('دستمال ۱,۰۰۰ عدد'), 1000);
  assert.equal(guessUnits('فویل ۱۰ متری'), null);
  assert.equal(guessUnits('یک عدد'), null);
});

test('confirming suggested pack sizes in one go', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 10, seed: 2, variableRatio: 0.5 });
  await addCompany(ctx, api, s);
  const guessed = ctx.db.get('SELECT COUNT(*) AS n FROM products WHERE units_guessed = 1 AND configured_at IS NULL').n;
  assert.ok(guessed > 0);
  const list = await api.get('/api/products?setup=guessed');
  assert.equal(list.body.total, guessed);
  const r = await api.post('/api/products/confirm-guessed', {});
  assert.equal(r.body.updated, guessed);
  assert.equal((await api.get('/api/products?setup=guessed')).body.total, 0);
  const row = ctx.db.get("SELECT * FROM audit_log WHERE summary LIKE 'تأیید تنظیمات کالا%' LIMIT 1");
  assert.match(row.summary, /عدد در هر بسته/);
});
