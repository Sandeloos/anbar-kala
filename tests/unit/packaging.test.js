'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { defaultMultiplier, priceUnitsSuggestion } = require('../../server/lib/pricing-defaults');
const { priceFor } = require('../../server/lib/digikala');
const { createSync } = require('../../server/lib/sync');
const { radanPackEvidence, radanProductUrl } = require('../../server/lib/radan-packs');

const km1Url = 'https://radiantajhiz.com/product/shomare-sim-feshari-km1/';
const km1Option = { size: 200, unitPrice: 935, refUnit: 935, packPrice: 187000 };
const selector = (...options) => `<div class="rpq-selector" data-options="${JSON.stringify(options).replace(/"/g, '&quot;')}"></div>`;

test('Radan evidence requires the Woo reference price and consistent pack options', () => {
  const km1 = selector(km1Option);
  assert.deepEqual(radanPackEvidence(km1 + km1, 9350), { price_units: 1, sale_units: 200, sizes: [200] });
  assert.deepEqual(radanPackEvidence(selector(km1Option, { ...km1Option, size: 100, packPrice: 93500 }), 9350),
    { price_units: 1, sale_units: null, sizes: [100, 200] });
  assert.equal(radanPackEvidence(km1, 1870000), null);
  assert.equal(radanPackEvidence(km1 + selector({ ...km1Option, size: 100, packPrice: 93500 }), 9350), null);
  assert.equal(radanPackEvidence(selector({ ...km1Option, packPrice: 935 }), 9350), null);
  assert.equal(radanProductUrl('https://radiantajhiz.com', km1Url + '?source=test'), km1Url);
  assert.equal(radanProductUrl('https://radiantajhiz.com', 'https://radiantajhiz.com.evil.test/product/km1/'), null);
});

test('refreshing KM1 holds the old basis for review and a verified 200-pack prices at 280,500 toman', async (t) => {
  const ctx = await makeApp(); t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const shopSite = await shop(ctx, { count: 1, variableRatio: 0 });
  const company = await addCompany(ctx, api, shopSite);
  const { db, config } = ctx;
  const { packaging, secrets, events } = ctx.app.ctx;
  const p = db.get('SELECT * FROM products WHERE company_id = ?', company.id);
  const name = 'شماره سیم فشاری KM1 جعبه ۲۰۰ تایی';
  db.run("UPDATE companies SET site_url = ?, price_unit = 'rial' WHERE id = ?", 'https://radiantajhiz.com', company.id);
  db.run('UPDATE products SET name = ?, regular_price = ?, units_per_pack = ?, sale_pack_units = ? WHERE id = ?', name, 9350, 200, 200, p.id);
  const dkTitle = 'شماره سیم فشاری KM1 بسته ۲۰۰ عددی';
  const listing = (await api.post('/api/listings', {
    platform_id: 1, product_id: p.id, code: '83699223', title: dkTitle, units: 1, auto_price: false
  })).body.listing;
  const sync = createSync({
    db, config, packaging, secrets, events,
    fetchImpl: async (url, options) => {
      if (String(url) === km1Url) {
        assert.equal(options.redirect, 'error');
        return new Response(selector(km1Option), { headers: { 'content-type': 'text/html' } });
      }
      assert.match(String(url), /\/products\/\d+/);
      return Response.json({ id: p.woo_id, type: 'simple', name, permalink: km1Url, regular_price: '9350' });
    }
  });
  const pending = await sync.refreshProduct(p.id);
  assert.equal(pending.units_per_pack, 200);
  assert.equal(pending.packaging_pending, 1);
  const formula = { title: dkTitle, units: 200, margin_pct: 50, round_to: 1 };
  assert.equal(priceFor(formula, pending), null);
  const review = packaging.pending()[0];
  assert.deepEqual(review.after.verified_pack, { price_units: 1, sale_units: 200, sizes: [200] });
  assert.equal(review.listings[0].declared_units, 200);
  const input = { version: pending.version, price_units: 1, sale_units: 200, listings: [{ id: listing.id, version: listing.version, units: 200 }] };
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, { ...input, price_units: 200 })).status, 409);
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, { ...input, sale_units: 1 })).status, 409);
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, { ...input, listings: [{ ...input.listings[0], units: 1 }] })).status, 409);
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, input)).status, 200);
  const corrected = await sync.refreshProduct(p.id);
  assert.deepEqual(priceFor(formula, corrected), { base: 1870000, price: 2805000 });
  assert.equal(priceFor({ ...formula, units: 1 }, corrected), null);
  assert.equal(packaging.pending().length, 0);
});

test('tool/non-tool defaults and price-based quantity suggestions do not confuse a unit price with a sales pack', () => {
  assert.equal(defaultMultiplier({ name: 'انبر پرس' }), 1.4);
  assert.equal(defaultMultiplier({ name: 'اره برقی' }), 1.4);
  assert.equal(defaultMultiplier({ name: 'کالا', category_names: 'ابزارآلات' }), 1.4);
  assert.equal(defaultMultiplier({ name: 'گلند شماره ۲' }), 1.5);
  assert.equal(defaultMultiplier({ name: 'انبر', pricing_group: 'other' }), 1.5);
  assert.equal(priceUnitsSuggestion({ price_sale: 1050000 }, { regular_price: 1000000, units_per_pack: 100 }).units, 100);
  assert.equal(priceUnitsSuggestion({ price_sale: 1500000 }, { regular_price: 10000, units_per_pack: 1, sale_pack_units: 100 }).units, 100);
  assert.equal(priceUnitsSuggestion({ price_sale: 0 }, { regular_price: 10000, units_per_pack: 1 }), null);
  assert.equal(priceUnitsSuggestion({ price_sale: 10000 }, { regular_price: 10000, units_per_pack: 100, packaging_pending: 1 }), null);
});

test('site packaging changes suspend pricing and settlement until every listing is reconfirmed; old order amounts stay frozen', async (t) => {
  const ctx = await makeApp(); t.after(ctx.cleanup);
  await addUser(ctx.db); const api = client(ctx.app); await api.login();
  const site = await shop(ctx, { count: 1, variableRatio: 0 });
  const company = await addCompany(ctx, api, site);
  const db = ctx.db, c = ctx.app.ctx;
  let p = db.get('SELECT * FROM products WHERE company_id = ?', company.id);
  db.run('UPDATE products SET name = ?, units_per_pack = 100, sale_pack_units = 100 WHERE id = ?', 'بست کابل بسته ۱۰۰ عددی', p.id);
  p = db.get('SELECT * FROM products WHERE id = ?', p.id);
  const oldTime = new Date(Date.now() - 600000).toISOString();
  const changed = new Date(Date.now() - 300000).toISOString();
  const comp = db.get('SELECT * FROM companies WHERE id = ?', company.id);
  c.sync.apply(comp, [{ ...p, regular_price: 1000000, site_modified_at: oldTime }], { source: 'webhook', now: oldTime });
  p = db.get('SELECT * FROM products WHERE id = ?', p.id);
  assert.equal((await api.put(`/api/products/${p.id}`, { units_per_pack: 100, sale_pack_units: 100, warehouse_id: '', tracked: true })).status, 200);
  const listing = (await api.post('/api/listings', { platform_id: 1, product_id: p.id, code: '8899', units: 100 })).body.listing;
  assert.equal(listing.auto_price, 1);
  assert.equal(listing.margin_pct, 50);
  const beforeOrder = c.orders.createOrder(null, { platform_id: 1, order_number: 'before', ordered_at: new Date(Date.parse(oldTime) + 1000).toISOString(), lines: [{ listing_id: listing.id, qty: 1 }] });
  assert.equal(c.orders.orderDetail(beforeOrder).lines[0].settle_unit_price, 1000000);
  p = db.get('SELECT * FROM products WHERE id = ?', p.id);
  c.sync.apply(comp, [{ ...p, name: 'بست کابل قیمت هر عدد', regular_price: 10000, description: 'قیمت هر عدد؛ فروش بسته ۱۰۰تایی', site_modified_at: changed }], { source: 'webhook', now: changed });
  p = db.get('SELECT * FROM products WHERE id = ?', p.id);
  assert.equal(p.packaging_pending, 1);
  assert.equal(priceFor(listing, p), null);
  assert.throws(() => c.orders.createOrder(null, { platform_id: 1, order_number: 'wait', ordered_at: changed, lines: [{ listing_id: listing.id, qty: 1 }] }), /بسته‌بندی/);
  const review = c.packaging.pending()[0];
  assert.equal(review.before.price_units, 100);
  const confirm = { version: p.version, price_units: 1, sale_units: 100, listings: review.listings.map((l) => ({ id: l.id, version: l.version, units: 100 })) };
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, { ...confirm, listings: [] })).status, 409);
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, confirm)).status, 200);
  p = db.get('SELECT * FROM products WHERE id = ?', p.id);
  assert.equal(p.units_per_pack, 1); assert.equal(p.sale_pack_units, 100); assert.equal(p.packaging_pending, 0);
  assert.equal(priceFor({ ...listing, margin_default: 1 }, p).price, 1500000);
  const afterOrder = c.orders.createOrder(null, { platform_id: 1, order_number: 'after', ordered_at: changed, lines: [{ listing_id: listing.id, qty: 1 }] });
  assert.equal(c.orders.orderDetail(afterOrder).lines[0].settle_unit_price, 1000000);
  assert.equal(c.orders.orderDetail(afterOrder).lines[0].units_per_pack, 1);
  assert.equal(c.orders.orderDetail(beforeOrder).lines[0].units_per_pack, 100);
  assert.equal(c.orders.orderDetail(beforeOrder).lines[0].settle_unit_price, 1000000);
  assert.equal(c.packaging.pending().length, 0);
  assert.equal((await api.post(`/api/products/${p.id}/packaging`, confirm)).status, 409);
});

test('a user opt-out stays off after unrelated listing edits', async (t) => {
  const ctx = await makeApp(); t.after(ctx.cleanup); await addUser(ctx.db);
  const api = client(ctx.app); await api.login();
  const site = await shop(ctx, { count: 1, variableRatio: 0 }); await addCompany(ctx, api, site);
  const p = ctx.db.get('SELECT * FROM products LIMIT 1');
  ctx.db.run('UPDATE products SET pricing_group = ? WHERE id = ?', 'tools', p.id);
  const base = { platform_id: 1, product_id: p.id, code: '2233', units: 1 };
  const created = await api.post('/api/listings', base);
  assert.equal(created.body.listing.auto_price, 1);
  assert.equal(created.body.listing.margin_pct, 40);
  const off = await api.put(`/api/listings/${created.body.listing.id}`, { ...base, auto_price: false });
  assert.equal(off.body.listing.auto_price, 0);
  const edit = await api.put(`/api/listings/${created.body.listing.id}`, { ...base, note: 'یادداشت' });
  assert.equal(edit.body.listing.auto_price, 0);
});
