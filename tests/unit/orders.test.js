'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { parseDateTime, toJalali, toGregorian } = require('../../server/lib/jalali');
const { parseCsv, guessMapping } = require('../../server/lib/importer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A company whose products are all variable "25 / 100 pieces" (like the owner's example). */
async function setup(t) {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 6, seed: 12, variableRatio: 1 });
  const company = await addCompany(ctx, api, s);
  const parent = s.products[0];
  const [w25, w100] = parent._variations;
  const p25 = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', w25.id);
  const p100 = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', w100.id);
  return { ctx, api, s, company, p25, p100, w25, w100, digikala: 1 };
}

test('jalali: conversion both ways and parsing typed or exported dates as Tehran time', () => {
  assert.deepEqual(toJalali(2026, 11, 5), [1405, 8, 14]);
  assert.deepEqual(toGregorian(1405, 8, 14), [2026, 11, 5]);
  assert.deepEqual(toGregorian(1403, 12, 30), [2025, 3, 20], 'leap year 1403');
  assert.equal(parseDateTime('۱۴۰۵/۰۸/۱۴ ۱۴:۲۰'), '2026-11-05T10:50:00.000Z');
  assert.equal(parseDateTime('1405-8-14'), '2026-11-04T20:30:00.000Z');
  assert.equal(parseDateTime('2026-11-05 14:20'), '2026-11-05T10:50:00.000Z');
  assert.equal(parseDateTime('14:20 1405/08/14'), '2026-11-05T10:50:00.000Z');
  assert.equal(parseDateTime('1404/12/30'), null, '1404 is not a leap year');
  assert.equal(parseDateTime('hello'), null);
});

test('order: the site price at the order time, a quarter of a 100-pack for a 25-piece listing', async (t) => {
  const { ctx, api, s, p100, w100 } = await setup(t);
  const before = new Date().toISOString();
  const original = Number(w100.regular_price);
  await sleep(1100);
  await s.setPrice(w100.id, original + 10000);
  await ctx.app.ctx.sync.incrementalSync(p100.company_id);
  const now = new Date().toISOString();

  // A Digikala listing that sells 25 pieces of the 100-piece product
  const li = await api.post('/api/listings', { platform_id: 1, product_id: p100.id, code: 'DKPC-111', title: 'لیوان ۲۵ عددی', units: 25 });
  assert.equal(li.status, 200, JSON.stringify(li.body));
  const listingId = li.body.listing.id;

  const old = await api.post('/api/orders', { platform_id: 1, order_number: 'D-1', ordered_at: before, lines: [{ listing_id: listingId, qty: 2, platform_price: '150000' }] });
  assert.equal(old.status, 200, JSON.stringify(old.body));
  const l1 = old.body.lines[0];
  assert.equal(l1.site_price, p100.regular_price, 'price before the change');
  assert.equal(l1.settle_unit_price, Math.round(p100.regular_price / 4));
  assert.equal(l1.units_total, 50);
  assert.equal(l1.platform_price, 1500000, 'platform prices are typed in tomans');

  const fresh = await api.post('/api/orders', { platform_id: 1, order_number: 'D-2', ordered_at: now, lines: [{ listing_id: listingId, qty: 1 }] });
  assert.equal(fresh.body.lines[0].site_price, (original + 10000) * 10, 'price after the change');

  const dupe = await api.post('/api/orders', { platform_id: 1, order_number: 'D-1', ordered_at: now, lines: [{ listing_id: listingId, qty: 1 }] });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.code, 'duplicate_order');
  assert.ok(dupe.body.existing_id);

  // Before we ever read the site: the price must be typed, with a reason
  const early = new Date(Date.now() - 3 * 864e5).toISOString();
  const unknown = await api.post('/api/orders', { platform_id: 1, order_number: 'D-3', ordered_at: early, lines: [{ listing_id: listingId, qty: 1 }] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'needs_manual_price');
  const noReason = await api.post('/api/orders', { platform_id: 1, order_number: 'D-3', ordered_at: early, lines: [{ listing_id: listingId, qty: 1, site_price_manual: '400000' }] });
  assert.equal(noReason.status, 400);
  const manual = await api.post('/api/orders', { platform_id: 1, order_number: 'D-3', ordered_at: early, lines: [{ listing_id: listingId, qty: 1, site_price_manual: '400000', reason: 'سفارش قبل از راه‌اندازی' }] });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.lines[0].site_price, 4000000);
  assert.equal(manual.body.lines[0].settle_unit_price, 1000000);
  assert.equal(manual.body.lines[0].site_price_source, 'manual');

  // The quote endpoint reads the site again for a recent order
  const q = await api.post('/api/orders/quote', { listing_id: listingId, ordered_at: now });
  assert.equal(q.body.refreshed, true);
  assert.equal(q.body.price.regular_price, (original + 10000) * 10);
  assert.equal(q.body.uncertain, false);

  const list = await api.get('/api/orders?q=D-1');
  assert.equal(list.body.total, 1);
});

test('receiving: ok, excess into stock, short filled from the company surplus, undo rules', async (t) => {
  const { ctx, api, p25, p100 } = await setup(t);
  const now = new Date().toISOString();
  const mk = async (number, productId, qty) => (await api.post('/api/orders', { platform_id: 1, order_number: number, ordered_at: now, lines: [{ product_id: productId, qty }] })).body.lines[0];

  // Case 1: everything right
  const a = await mk('R-1', p25.id, 1);
  assert.equal((await api.post(`/api/order-lines/${a.id}/receive`, { outcome: 'ok' })).status, 200);

  // Case 3: ordered one 25-pack, the company sent a 100-pack → 75 into our warehouse, still theirs
  const b = await mk('R-2', p25.id, 1);
  const r = await api.post(`/api/order-lines/${b.id}/receive`, { outcome: 'excess', arrived_units: 100, arrived_product_id: p100.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let stock = (await api.get('/api/stock')).body;
  assert.equal(stock.items.length, 1);
  assert.equal(stock.items[0].units, 75);
  assert.equal(stock.items[0].owner_company_id, p25.company_id);
  assert.equal(stock.items[0].product_id, p100.id);
  assert.equal(stock.totals.consigned, 75);

  // Case 4: next order nothing arrives; sent from our warehouse, the company surplus first
  const c = await mk('R-3', p25.id, 2);
  const avail = await api.get(`/api/order-lines/${c.id}/stock`);
  assert.equal(avail.body.suggestion.missing, 0);
  assert.equal(avail.body.suggestion.picks[0].units, 50);
  const short = await api.post(`/api/order-lines/${c.id}/receive`, { outcome: 'short', arrived_units: 0, rest: 'stock' });
  assert.equal(short.status, 200, JSON.stringify(short.body));
  assert.equal(short.body.line.units_from_stock, 50);
  const out = ctx.db.get("SELECT * FROM stock_moves WHERE kind = 'ship_out'");
  assert.equal(out.units, -50);
  assert.equal(out.value, c.settle_unit_price * 2, 'company-owned units carry their value for the settlement');
  stock = (await api.get('/api/stock')).body;
  assert.equal(stock.items[0].units, 25);

  // Not enough stock for the next one: picking more than there is fails
  const d = await mk('R-4', p25.id, 2);
  const tooMuch = await api.post(`/api/order-lines/${d.id}/receive`, { outcome: 'short', arrived_units: 0, rest: 'stock' });
  assert.equal(tooMuch.status, 400);
  const cancel = await api.post(`/api/order-lines/${d.id}/receive`, { outcome: 'short', arrived_units: 25, rest: 'cancel' });
  assert.equal(cancel.body.line.units_cancelled, 25);
  assert.equal(cancel.body.line.status, 'done');

  // The surplus of R-2 was partly used by R-3: undoing R-2 must wait for R-3
  assert.equal((await api.post(`/api/order-lines/${b.id}/undo`)).status, 409);
  assert.equal((await api.post(`/api/order-lines/${c.id}/undo`)).status, 200);
  assert.equal((await api.post(`/api/order-lines/${b.id}/undo`)).status, 200);
  stock = (await api.get('/api/stock')).body;
  assert.equal(stock.items.length, 0, 'everything reversed');
  assert.ok(ctx.db.get("SELECT COUNT(*) AS n FROM stock_moves WHERE kind = 'reversal'").n >= 2, 'reversals are new rows, nothing deleted');
  const pending = await api.get(`/api/receiving?company=${p25.company_id}`);
  assert.equal(pending.body.lines.filter((l) => l.status === 'pending').length, 2);
  assert.ok(pending.body.companies.find((x) => x.id === p25.company_id).pending >= 2);

  // Activity log speaks Persian about each step
  const log = ctx.db.all("SELECT summary FROM audit_log WHERE entity = 'order_line' ORDER BY id").map((x) => x.summary);
  assert.ok(log.some((s) => s.includes('اضافه رسید') && s.includes('75 عدد به انبار رفت')));
  assert.ok(log.some((s) => s.includes('برگرداندن دریافت')));
});

test('receiving: a wrong item goes into stock and the order is cancelled; bulk ok; cancelling an order', async (t) => {
  const { api, p25, p100 } = await setup(t);
  const now = new Date().toISOString();
  const o = (await api.post('/api/orders', { platform_id: 2, order_number: 'B-1', ordered_at: now, lines: [{ product_id: p25.id, qty: 1 }, { product_id: p100.id, qty: 1 }] })).body;
  const [l25, l100] = o.lines;
  const wrongNoProduct = await api.post(`/api/order-lines/${l25.id}/receive`, { outcome: 'wrong', arrived_units: 10, wrong_to: 'stock', rest: 'cancel' });
  assert.equal(wrongNoProduct.status, 400, 'stock needs a known product');
  const wrong = await api.post(`/api/order-lines/${l25.id}/receive`, { outcome: 'wrong', arrived_units: 100, arrived_product_id: p100.id, wrong_to: 'stock', rest: 'cancel' });
  assert.equal(wrong.status, 200, JSON.stringify(wrong.body));
  assert.equal(wrong.body.line.status, 'cancelled');
  assert.equal((await api.get('/api/stock')).body.items[0].units, 100);

  const bulk = await api.post('/api/receiving/ok', { ids: [l100.id, l25.id] });
  assert.equal(bulk.body.done, 1);
  assert.equal(bulk.body.errors.length, 1, 'an already received line is reported, not changed');

  const o2 = (await api.post('/api/orders', { platform_id: 2, order_number: 'B-2', ordered_at: now, lines: [{ product_id: p25.id, qty: 3 }] })).body;
  assert.equal((await api.post(`/api/orders/${o2.order.id}/cancel`, {})).status, 400, 'a reason is required');
  const c = await api.post(`/api/orders/${o2.order.id}/cancel`, { reason: 'مشتری لغو کرد' });
  assert.equal(c.body.lines[0].status, 'cancelled');
  assert.equal((await api.post(`/api/orders/${o.order.id}/cancel`, { reason: 'x' })).status, 409, 'received lines block cancelling');
});

test('stock: own goods in, back to the company, transfer, corrections never below zero', async (t) => {
  const { api, p25, p100 } = await setup(t);
  assert.equal((await api.post('/api/stock/own-in', { product_id: p25.id, warehouse_id: 2, units: 40, note: 'خرید' })).status, 200);
  const now = new Date().toISOString();
  const line = (await api.post('/api/orders', { platform_id: 1, order_number: 'S-1', ordered_at: now, lines: [{ product_id: p25.id, qty: 1 }] })).body.lines[0];
  await api.post(`/api/order-lines/${line.id}/receive`, { outcome: 'excess', arrived_units: 100 });
  let s = (await api.get('/api/stock')).body;
  assert.equal(s.totals.own, 40);
  assert.equal(s.totals.consigned, 75);

  const back = await api.post('/api/stock/return', { product_id: p25.id, warehouse_id: 1, owner_company_id: p25.company_id, units: 70 });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal((await api.post('/api/stock/return', { product_id: p25.id, warehouse_id: 1, owner_company_id: p25.company_id, units: 6 })).status, 409);
  assert.equal((await api.post('/api/stock/transfer', { product_id: p25.id, warehouse_id: 2, to_warehouse_id: 1, owner_company_id: 'own', units: 15 })).status, 200);
  assert.equal((await api.post('/api/stock/adjust', { product_id: p25.id, warehouse_id: 1, owner_company_id: 'own', units: -1 })).status, 400, 'a reason is required');
  assert.equal((await api.post('/api/stock/adjust', { product_id: p25.id, warehouse_id: 1, owner_company_id: 'own', units: -16, note: 'شمارش' })).status, 409);
  assert.equal((await api.post('/api/stock/adjust', { product_id: p25.id, warehouse_id: 1, owner_company_id: 'own', units: -1, note: 'شکسته بود' })).status, 200);
  s = (await api.get('/api/stock')).body;
  const own = s.items.filter((i) => i.owner_company_id === null);
  assert.deepEqual(own.map((i) => [i.warehouse_name, i.units]).sort(), [['رادلوس', 25], ['سندلوس', 14]]);
  const moves = await api.get(`/api/stock/moves?product=${p25.id}`);
  assert.ok(moves.body.items.some((m) => m.kind_label === 'برگشت به شرکت'));
  void p100;
});

test('manual price on a line with reason; company-stock values follow', async (t) => {
  const { ctx, api, p25 } = await setup(t);
  const now = new Date().toISOString();
  const first = (await api.post('/api/orders', { platform_id: 1, order_number: 'M-1', ordered_at: now, lines: [{ product_id: p25.id, qty: 1 }] })).body.lines[0];
  await api.post(`/api/order-lines/${first.id}/receive`, { outcome: 'excess', arrived_units: 75 });
  const line = (await api.post('/api/orders', { platform_id: 1, order_number: 'M-2', ordered_at: now, lines: [{ product_id: p25.id, qty: 2 }] })).body.lines[0];
  await api.post(`/api/order-lines/${line.id}/receive`, { outcome: 'short', arrived_units: 0, rest: 'stock' });
  assert.equal((await api.put(`/api/order-lines/${line.id}/price`, { settle_unit_price: '12000' })).status, 400);
  const r = await api.put(`/api/order-lines/${line.id}/price`, { settle_unit_price: '12000', reason: 'توافق با شرکت' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lines[0].settle_unit_price, 120000);
  assert.equal(r.body.lines[0].settle_manual, 1);
  assert.equal(ctx.db.get("SELECT value FROM stock_moves WHERE kind = 'ship_out'").value, 240000);
  const log = ctx.db.get("SELECT * FROM audit_log WHERE action = 'price' AND entity = 'order_line'");
  assert.match(log.summary, /توافق با شرکت/);
  assert.equal(JSON.parse(log.changes)[0].to, 120000);
});

test('import: Persian CSV with Jalali dates, link unknown codes, skip cancelled and duplicates', async (t) => {
  const { api, p100, p25 } = await setup(t);
  const [jy, jm, jd] = toJalali(...new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' }).split('-').map(Number));
  const date = `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
  // One minute ahead (rounded to the minute, "now" could fall before the shop was first read)
  const time = new Date(Date.now() + 60e3).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });
  const csv = [
    'کد سفارش,تاریخ ثبت سفارش,ساعت,کد تنوع,عنوان تنوع,تعداد,قیمت فروش (ریال),وضعیت',
    `9001,${date},${time},DKPC-25,لیوان ۲۵ عددی,2,"1,200,000",ارسال شده`,
    `9001,${date},${time},DKPC-100,لیوان ۱۰۰ عددی,1,"4,000,000",ارسال شده`,
    `9002,${date},${time},DKPC-25,لیوان ۲۵ عددی,1,"1,200,000",لغو شده`,
    `9003,${date},${time},DKPC-25,لیوان ۲۵ عددی,1,"1,200,000",ارسال شده`
  ].join('\n');
  const rows = parseCsv(csv);
  assert.equal(rows[1][6], '1,200,000');
  const guessed = guessMapping(rows[0]);
  assert.equal(guessed.order_number, 0);
  assert.equal(guessed.code, 3);
  assert.equal(guessed.price, 6);

  const parsed = await api.post('/api/imports/parse', { platform_id: 1, file_name: 'orders.csv', data: Buffer.from(csv).toString('base64') });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.body));
  assert.equal(parsed.body.rows, 4);
  assert.equal(parsed.body.price_unit, 'rial', 'Digikala exports are in rials');
  const body = { token: parsed.body.token, platform_id: 1, mapping: parsed.body.mapping, price_unit: 'rial' };
  const pre = await api.post('/api/imports/preview', body);
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.skipped, 1, 'the cancelled row');
  assert.deepEqual(pre.body.unmatched.map((u) => u.key).sort(), ['DKPC-100', 'DKPC-25']);

  const commit = await api.post('/api/imports/commit', { ...body, links: { 'DKPC-25': { product_id: p100.id, units: 25 }, 'DKPC-100': { product_id: p100.id, units: 100 } } });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  assert.equal(commit.body.listings_created, 2, JSON.stringify(commit.body));
  assert.equal(commit.body.orders_created, 2, JSON.stringify(commit.body));
  assert.equal(commit.body.lines_created, 3);
  assert.deepEqual(commit.body.errors, []);
  const o = (await api.get('/api/orders?q=9001')).body.items[0];
  assert.equal(o.lines, 2);
  const detail = (await api.get(`/api/orders/${o.id}`)).body;
  const quarter = detail.lines.find((l) => l.units_per_sale === 25);
  assert.equal(quarter.platform_price, 1200000);
  assert.equal(quarter.settle_unit_price, Math.round(p100.regular_price / 4));

  // The same file again: everything is already there; the mapping was remembered
  const again = await api.post('/api/imports/parse', { platform_id: 1, file_name: 'orders.csv', data: Buffer.from(csv).toString('base64') });
  assert.equal(again.body.from_saved, true);
  const pre2 = await api.post('/api/imports/preview', { ...body, token: again.body.token });
  assert.equal(pre2.body.ready, 0);
  assert.equal(pre2.body.skipped, 4);
  void p25;
});

test('an order a few minutes before we first read a product takes that first price, marked uncertain', async (t) => {
  const { ctx, api, p25 } = await setup(t);
  const first = ctx.db.get('SELECT effective_at FROM price_history WHERE product_id = ? ORDER BY id LIMIT 1', p25.id).effective_at;
  const fewMinutesBefore = new Date(new Date(first).getTime() - 5 * 60e3).toISOString();
  const ok = await api.post('/api/orders', { platform_id: 1, order_number: 'G-1', ordered_at: fewMinutesBefore, lines: [{ product_id: p25.id, qty: 1 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.lines[0].price_uncertain, 1);
  const q = await api.post('/api/orders/quote', { product_id: p25.id, ordered_at: fewMinutesBefore });
  assert.equal(q.body.uncertain, true);
  assert.equal(q.body.price.before_first_seen, true);
  const hourBefore = new Date(new Date(first).getTime() - 60 * 60e3).toISOString();
  const no = await api.post('/api/orders', { platform_id: 1, order_number: 'G-2', ordered_at: hourBefore, lines: [{ product_id: p25.id, qty: 1 }] });
  assert.equal(no.body.code, 'needs_manual_price');
});
