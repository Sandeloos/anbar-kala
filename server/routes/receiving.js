'use strict';
/**
 * Daily receiving: the list of what each company should send (from the orders), recording
 * what arrived per line (the five cases), bulk "all fine", undo, and items that arrived
 * without an order.
 */
const { z, optText, intIn } = require('./validate');
const { nowIso } = require('../lib/util');
const { dayStart, tehranDay } = require('../lib/jalali');

const pick = z.object({
  product_id: z.number().int(), warehouse_id: z.number().int(),
  owner_company_id: z.number().int().nullable(), units: z.number().int().min(0)
});

module.exports = async function receivingRoutes(app) {
  const { db, orders, stock } = app.ctx;

  /** Summary per company + the lines of one company. until = 'YYYY-MM-DD' (Tehran day; orders before it). */
  app.get('/receiving', async (req) => {
    const q = req.query || {};
    const until = /^\d{4}-\d{2}-\d{2}$/.test(q.until || '') ? dayStart(q.until) : null;
    const today = dayStart(tehranDay(nowIso()).date);
    // Only pending lines and today's receipts are read (indexes order_lines_pending / order_lines_received),
    // not every line the company ever had
    const companies = db.all(`SELECT c.id, c.name,
        (SELECT COUNT(*) FROM order_lines l JOIN orders o ON o.id = l.order_id
           WHERE l.company_id = c.id AND l.status = 'pending' AND o.cancelled_at IS NULL) AS pending,
        (SELECT COUNT(*) FROM order_lines l JOIN orders o ON o.id = l.order_id
           WHERE l.company_id = c.id AND l.status = 'pending' AND o.cancelled_at IS NULL AND o.ordered_at < ?) AS due,
        (SELECT COUNT(*) FROM order_lines l WHERE l.company_id = c.id AND l.received_at >= ? AND l.status <> 'pending') AS done_today
      FROM companies c WHERE c.active = 1 ORDER BY pending DESC, c.name`, until || nowIso(), today);
    const companyId = Number(q.company) || null;
    let lines = [];
    if (companyId) {
      const pending = orders.receivingList({ companyId, until, status: 'pending' });
      // Lines received today stay visible (with undo) so the day's work can be checked
      const done = orders.receivingList({ companyId, status: 'done', receivedSince: today });
      lines = [...pending, ...done];
    }
    return { companies, lines };
  });

  /** Stock that can fill a line + the default pick for n units. */
  app.get('/order-lines/:id/stock', async (req) => {
    const l = orders.lineRow(req.params.id);
    const units = Number(req.query.units || l.units_total);
    const siblings = db.all(`SELECT id, name, attributes, units_per_pack FROM products WHERE company_id = ? AND removed_at IS NULL AND id <> ?
                             AND parent_woo_id IS ? AND parent_woo_id IS NOT NULL ORDER BY woo_id`,
    l.company_id, l.product_id, db.get('SELECT parent_woo_id FROM products WHERE id = ?', l.product_id).parent_woo_id);
    return { line: l, available: stock.available(l.product_id), suggestion: stock.suggestPicks(l.product_id, units), siblings };
  });

  app.post('/order-lines/:id/receive', async (req) => {
    const b = z.object({
      outcome: z.enum(['ok', 'excess', 'short', 'wrong', 'cancelled'], { error: 'نتیجه را انتخاب کنید.' }),
      arrived_units: z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), intIn('تعداد رسیده', 0, 1000000).optional()),
      arrived_product_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      arrived_description: optText(300).optional(),
      warehouse_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      wrong_to: z.enum(['stock', 'returned']).optional(),
      rest: z.enum(['stock', 'cancel']).optional(),
      picks: z.array(pick).max(50).optional(),
      note: optText(500).optional()
    }).parse(req.body || {});
    return { line: orders.receive(req, req.params.id, b) };
  });

  /** "Everything arrived right" for many lines at once (the usual case). */
  app.post('/receiving/ok', async (req) => {
    const b = z.object({ ids: z.array(z.number().int()).min(1, 'هیچ ردیفی انتخاب نشده.').max(500) }).parse(req.body || {});
    let n = 0;
    const errors = [];
    for (const id of b.ids) {
      try { orders.receive(req, id, { outcome: 'ok' }); n++; } catch (err) { errors.push({ id, error: err.message }); }
    }
    return { done: n, errors };
  });

  app.post('/order-lines/:id/undo', async (req) => {
    orders.undoReceive(req, req.params.id);
    return { ok: true };
  });

  /** Something arrived that no order asked for: into stock (still the company's) or straight back. */
  app.post('/arrivals', async (req) => {
    const b = z.object({
      company_id: intIn('شرکت', 1, 1e9),
      product_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      description: optText(300).optional(),
      units: intIn('تعداد', 1, 1000000),
      disposition: z.enum(['stock', 'returned'], { error: 'مقصد را انتخاب کنید.' }),
      warehouse_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      note: optText(500).optional()
    }).parse(req.body || {});
    orders.receiveUnordered(req, b);
    return { ok: true };
  });
};
