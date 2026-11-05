'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { monthOf, monthBounds } = require('../../server/lib/jalali');

const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };

/** A company of "25 / 100 pieces" products, read from its site 70 days ago (so last month's orders have prices). */
async function setup(t) {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 4, seed: 21, variableRatio: 1 });
  const company = await addCompany(ctx, api, s);
  ctx.db.run("UPDATE price_history SET effective_at = ? WHERE source = 'import'", new Date(Date.now() - 70 * 864e5).toISOString());
  const [w25, w100] = s.products[0]._variations;
  const p25 = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', w25.id);
  const p100 = ctx.db.get('SELECT * FROM products WHERE woo_id = ?', w100.id);
  const thisMonth = monthOf(new Date().toISOString());
  const last = prevMonth(thisMonth);
  const lastAt = (day, hour = 10) => new Date(new Date(monthBounds(last).start).getTime() + (day - 1) * 864e5 + hour * 3600e3).toISOString();
  const order = async (number, productId, qty, at) => {
    const r = await api.post('/api/orders', { platform_id: 1, order_number: number, ordered_at: at, lines: [{ product_id: productId, qty }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.lines[0];
  };
  return { ctx, api, company, p25, p100, thisMonth, last, lastAt, order };
}

test('statement of last month: sales, sales from the company surplus, pending lines left out; issue freezes it', async (t) => {
  const { ctx, api, company, p25, p100, thisMonth, last, lastAt, order } = await setup(t);
  // A listing that sells 25 pieces of the 100-piece product: a quarter of its price
  const li = (await api.post('/api/listings', { platform_id: 1, product_id: p100.id, code: 'Q-25', units: 25 })).body.listing;
  const a = (await api.post('/api/orders', { platform_id: 1, order_number: 'A', ordered_at: lastAt(3), lines: [{ listing_id: li.id, qty: 2 }] })).body.lines[0];
  await api.post(`/api/order-lines/${a.id}/receive`, { outcome: 'ok' });
  const b = await order('B', p25.id, 1, lastAt(4));
  await api.post(`/api/order-lines/${b.id}/receive`, { outcome: 'excess', arrived_units: 100 });
  const c = await order('C', p25.id, 2, lastAt(5));
  await api.post(`/api/order-lines/${c.id}/receive`, { outcome: 'short', arrived_units: 0, rest: 'stock' });
  const d = await order('D', p25.id, 1, lastAt(6));

  const v = (await api.get(`/api/statements/month?company=${company.id}&month=${last}`)).body;
  assert.equal(v.statement, null, 'a draft');
  assert.equal(v.ended, true);
  assert.equal(v.sections.sales.length, 2, 'A and B');
  const sa = v.sections.sales.find((i) => i.order_number === 'A');
  assert.equal(sa.amount, Math.round(p100.regular_price / 4) * 2);
  assert.equal(sa.sales, 2);
  assert.equal(v.sections.stock.length, 1);
  assert.equal(v.sections.stock[0].amount, c.settle_unit_price * 2);
  assert.equal(v.facts.pending_lines, 1, 'D is not received');
  // Surplus is counted in the month it physically arrived (we received last month's orders today)
  assert.equal(v.facts.surplus_in_units, 0);
  const cur = (await api.get(`/api/statements/month?company=${company.id}&month=${thisMonth}`)).body;
  assert.equal(cur.facts.surplus_in_units, 75);
  assert.equal(cur.facts.consigned_units, 25);
  const total = sa.amount + b.settle_unit_price + c.settle_unit_price * 2;
  assert.equal(v.totals.total, total);

  assert.equal((await api.post('/api/statements', { company_id: company.id, month: thisMonth })).status, 400, 'the month is not over');
  const issued = await api.post('/api/statements', { company_id: company.id, month: last });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.statement.total, total);
  assert.equal((await api.post('/api/statements', { company_id: company.id, month: last })).status, 409);

  // After issuing: D arrives late, A's price is corrected → adjustments on this month's draft
  await api.post(`/api/order-lines/${d.id}/receive`, { outcome: 'ok' });
  await api.put(`/api/order-lines/${a.id}/price`, { settle_unit_price: String(Math.round(p100.regular_price / 40) + 100), reason: 'توافق' });
  const after = (await api.get(`/api/statements/month?company=${company.id}&month=${last}`)).body;
  assert.equal(after.statement.total, total, 'the issued statement does not change');
  assert.notEqual(after.changes_since, 0);
  const now = (await api.get(`/api/statements/month?company=${company.id}&month=${thisMonth}`)).body;
  assert.equal(now.sections.adjust.length, 2);
  const late = now.sections.adjust.find((i) => i.order_number === 'D');
  assert.equal(late.amount, d.settle_unit_price);
  assert.equal(late.previous, 0);
  const corrected = now.sections.adjust.find((i) => i.order_number === 'A');
  assert.equal(corrected.previous, sa.amount);
  assert.equal(corrected.amount, (Math.round(p100.regular_price / 40) + 100) * 10 * 2 - sa.amount);

  // Paid statements cannot be voided; the latest unpaid one can (manager), and then its items are open again
  const sid = issued.body.statement.id;
  const voidNoReason = await api.post(`/api/statements/${sid}/void`, {});
  assert.equal(voidNoReason.status, 400);
  const voided = await api.post(`/api/statements/${sid}/void`, { reason: 'اشتباه در دریافت' });
  assert.equal(voided.body.statement, null, 'back to a draft');
  assert.equal(voided.body.sections.sales.length, 3, 'D is now part of last month');
  const reissued = await api.post('/api/statements', { company_id: company.id, month: last });
  const paid = await api.post(`/api/statements/${reissued.body.statement.id}/paid`, { reference: 'فیش ۱۲۳' });
  assert.equal(paid.body.statement.status, 'paid');
  assert.equal((await api.post(`/api/statements/${reissued.body.statement.id}/void`, { reason: 'x' })).status, 409);
  const log = ctx.db.all("SELECT summary FROM audit_log WHERE entity = 'statement' ORDER BY id").map((r) => r.summary);
  assert.equal(log.length, 4);
  assert.match(log[0], /صدور صورت‌حساب/);
});

test('returns: kept, back to the company (credited this month), damaged; limits and undo rules', async (t) => {
  const { ctx, api, company, p25, thisMonth, last, lastAt, order } = await setup(t);
  const a = await order('RA', p25.id, 4, lastAt(2));
  await api.post(`/api/order-lines/${a.id}/receive`, { outcome: 'ok' });
  await api.post('/api/statements', { company_id: company.id, month: last });

  assert.equal((await api.post(`/api/order-lines/${a.id}/returns`, { units: 101 })).status, 400, 'more than shipped');
  const r1 = (await api.post(`/api/order-lines/${a.id}/returns`, { units: 25, reason: 'مشتری پس داد' })).body.return;
  const r2 = (await api.post(`/api/order-lines/${a.id}/returns`, { units: 25 })).body.return;
  const r3 = (await api.post(`/api/order-lines/${a.id}/returns`, { units: 25 })).body.return;
  let stock = (await api.get('/api/stock?owner=own')).body;
  assert.equal(stock.totals.own, 75, 'returns are our own stock');
  assert.equal((await api.get('/api/returns?status=waiting')).body.items.length, 3);
  assert.equal((await api.post(`/api/order-lines/${a.id}/undo`)).status, 409, 'receiving cannot be undone with returns');

  const back = await api.post(`/api/returns/${r1.id}/decide`, { disposition: 'to_company', note: 'بارنامه ۵۵' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.return.value, a.settle_unit_price);
  await api.post(`/api/returns/${r2.id}/decide`, { disposition: 'kept' });
  await api.post(`/api/returns/${r3.id}/decide`, { disposition: 'damaged' });
  stock = (await api.get('/api/stock?owner=own')).body;
  assert.equal(stock.totals.own, 25, 'only the kept one is left');

  const now = (await api.get(`/api/statements/month?company=${company.id}&month=${thisMonth}`)).body;
  assert.equal(now.sections.returns.length, 1);
  assert.equal(now.sections.returns[0].amount, -a.settle_unit_price);
  assert.equal(now.totals.total, -a.settle_unit_price);

  // Undo a decision, then void the return
  assert.equal((await api.post(`/api/returns/${r3.id}/undo`)).status, 200);
  assert.equal((await api.post(`/api/returns/${r3.id}/void`, {})).status, 400, 'a reason is required');
  assert.equal((await api.post(`/api/returns/${r3.id}/void`, { reason: 'اشتباه ثبت شد' })).status, 200);
  assert.equal((await api.get('/api/returns?status=void')).body.items.length, 1);

  // A line sent from our own stock has nothing to credit to the company
  await api.post('/api/stock/own-in', { product_id: p25.id, warehouse_id: 2, units: 50 });
  const own = await order('RB', p25.id, 1, new Date().toISOString());
  await api.post(`/api/order-lines/${own.id}/receive`, { outcome: 'short', arrived_units: 0, rest: 'stock',
    picks: [{ product_id: p25.id, warehouse_id: 2, owner_company_id: null, units: 25 }] });
  const r4 = (await api.post(`/api/order-lines/${own.id}/returns`, { units: 25 })).body.return;
  const refused = await api.post(`/api/returns/${r4.id}/decide`, { disposition: 'to_company' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /کالای خودمان/);

  // Issue this month later? Not yet over; but once a credit is on an issued statement it cannot be undone
  ctx.db.run(`INSERT INTO statements (company_id, month, status, currency, issued_at) VALUES (?, ?, 'issued', 'toman', ?)`, company.id, thisMonth, new Date().toISOString());
  const sid = ctx.db.get('SELECT MAX(id) AS id FROM statements').id;
  ctx.db.run(`INSERT INTO statement_items (statement_id, key, section, kind, item_month, amount) VALUES (?, ?, 'returns', 'return', ?, ?)`, sid, `R${r1.id}`, thisMonth, -back.body.return.value);
  assert.equal((await api.post(`/api/returns/${r1.id}/undo`)).status, 409);
});

test('stocktake writes one correction per difference; Excel statement opens right-to-left with the total', async (t) => {
  const { ctx, api, company, p25, p100, last, lastAt, order } = await setup(t);
  await api.post('/api/stock/own-in', { product_id: p25.id, warehouse_id: 1, units: 40 });
  await api.post('/api/stock/own-in', { product_id: p100.id, warehouse_id: 1, units: 10 });
  const count = await api.post('/api/stock/count', { warehouse_id: 1, note: 'آخر ماه', counts: [
    { product_id: p25.id, owner_company_id: null, counted: 38 },
    { product_id: p100.id, owner_company_id: null, counted: 10 }
  ] });
  assert.equal(count.status, 200, JSON.stringify(count.body));
  assert.deepEqual([count.body.changed, count.body.minus], [1, 2]);
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM stock_moves WHERE kind = 'count'").n, 1);
  assert.match(ctx.db.get("SELECT summary FROM audit_log WHERE entity = 'warehouse' ORDER BY id DESC").summary, /انبارگردانی/);

  const a = await order('X', p25.id, 3, lastAt(8));
  await api.post(`/api/order-lines/${a.id}/receive`, { outcome: 'ok' });
  const res = await ctx.app.inject({ method: 'GET', url: `/api/statements/excel?company=${company.id}&month=${last}`, headers: { cookie: api.cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.rawPayload);
  const ws = wb.worksheets[0];
  assert.equal(ws.views[0].rightToLeft, true);
  const texts = [];
  ws.eachRow((r) => texts.push(r.values.filter(Boolean).join(' | ')));
  assert.ok(texts[0].includes(company.name));
  const totalRow = texts.find((x) => x.includes('مبلغ قابل پرداخت'));
  assert.ok(totalRow.includes(String(a.settle_unit_price * 3 / 10)), totalRow);

  const overview = await api.get('/api/statements/overview');
  assert.equal(overview.body.companies[0].last_month, last);
  assert.equal(overview.body.companies[0].last_draft_total, a.settle_unit_price * 3);
});
