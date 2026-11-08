'use strict';
/** The "amount for the company" of an order is the money its statement will pay, not qty × price. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, addUser, client, shop, addCompany } = require('./helpers');
const { monthOf } = require('../../server/lib/jalali');

test('order amounts: cancelled units count nothing, received lines match the statement', async (t) => {
  const ctx = await makeApp();
  t.after(ctx.cleanup);
  await addUser(ctx.db);
  const api = client(ctx.app);
  await api.login();
  const s = await shop(ctx, { count: 3, seed: 31, variableRatio: 0 });
  const comp = await addCompany(ctx, api, s);
  const [p1, p2] = ctx.db.all("SELECT * FROM products WHERE company_id = ? AND type = 'simple' ORDER BY id LIMIT 2", comp.id);
  const at = new Date().toISOString();
  const o = (await api.post('/api/orders', { platform_id: 1, order_number: 'A-1', ordered_at: at, lines: [{ product_id: p1.id, qty: 2 }, { product_id: p2.id, qty: 1 }] })).body;
  const [l1, l2] = o.lines;
  const full = l1.qty * l1.settle_unit_price + l2.qty * l2.settle_unit_price;
  const listed = async () => (await api.get('/api/orders?q=A-1')).body.items[0].settle_total;
  assert.equal(await listed(), full, 'waiting: the expected amount');

  // Line 1 arrived; line 2 did not and was cancelled
  assert.equal((await api.post(`/api/order-lines/${l1.id}/receive`, { outcome: 'ok' })).status, 200);
  assert.equal((await api.post(`/api/order-lines/${l2.id}/receive`, { outcome: 'short', arrived_units: 0, rest: 'cancel' })).status, 200);
  const expected = l1.qty * l1.settle_unit_price;
  assert.equal(await listed(), expected, 'the cancelled line is worth nothing');
  const detail = (await api.get(`/api/orders/${o.order.id}`)).body;
  assert.deepEqual(detail.lines.map((l) => l.company_amount), [expected, 0]);

  // The same money the statement pays for these lines
  const draft = ctx.app.ctx.statements.compute(comp.id, monthOf(at));
  const billed = draft.sections.sales.filter((i) => [l1.id, l2.id].includes(i.order_line_id)).reduce((a, i) => a + i.amount, 0);
  assert.equal(billed, expected);

  // A cancelled order is worth nothing
  const o2 = (await api.post('/api/orders', { platform_id: 1, order_number: 'A-2', ordered_at: at, lines: [{ product_id: p1.id, qty: 3 }] })).body;
  assert.equal((await api.post(`/api/orders/${o2.order.id}/cancel`, { reason: 'لغو مشتری' })).status, 200);
  assert.equal((await api.get('/api/orders?q=A-2')).body.items[0].settle_total, 0);
});
