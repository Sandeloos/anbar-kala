'use strict';
/**
 * Daily receiving: the list of what each company should send (from the orders), recording
 * what arrived per line (the five cases), bulk "all fine", undo, and items that arrived
 * without an order.
 */
const { z, optText, intIn } = require('./validate');
const { badRequest, nowIso } = require('../lib/util');
const { dayStart } = require('../lib/jalali');

const pick = z.object({
  product_id: z.number().int(), warehouse_id: z.number().int(),
  owner_company_id: z.number().int().nullable(), units: z.number().int().min(0)
});

module.exports = async function receivingRoutes(app) {
  const { db, orders, audit, events } = app.ctx;

  /** Summary per company + the lines of one company. until = 'YYYY-MM-DD' (Tehran day; orders before it). */
  app.get('/receiving', async (req) => {
    const q = req.query || {};
    const until = /^\d{4}-\d{2}-\d{2}$/.test(q.until || '') ? dayStart(q.until) : null;
    const companies = db.all(`SELECT c.id, c.name,
        SUM(CASE WHEN l.status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN l.status = 'pending' AND o.ordered_at < ? THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN l.status <> 'pending' AND l.received_at >= ? THEN 1 ELSE 0 END) AS done_today
      FROM companies c LEFT JOIN order_lines l ON l.company_id = c.id LEFT JOIN orders o ON o.id = l.order_id AND o.cancelled_at IS NULL
      WHERE c.active = 1 GROUP BY c.id ORDER BY pending DESC, c.name`, until || nowIso(), dayStart(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' })));
    const companyId = Number(q.company) || null;
    let lines = [];
    if (companyId) {
      const pending = orders.receivingList({ companyId, until, status: 'pending' });
      // Lines received today stay visible (with undo) so the day's work can be checked
      const done = orders.receivingList({ companyId, status: 'done' }).filter((l) => l.received_at && l.received_at >= dayStart(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' })));
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
    return { line: l, available: orders.available(l.product_id), suggestion: orders.suggestPicks(l.product_id, units), siblings };
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
    const comp = db.get('SELECT * FROM companies WHERE id = ?', b.company_id);
    if (!comp) throw badRequest('شرکت پیدا نشد.');
    const p = b.product_id ? db.get('SELECT * FROM products WHERE id = ? AND company_id = ?', b.product_id, comp.id) : null;
    if (b.product_id && !p) throw badRequest('کالا مال این شرکت نیست.');
    if (!p && !b.description) throw badRequest('کالا را انتخاب کنید یا بنویسید چه رسید.', { description: 'لازم است' });
    if (b.disposition === 'stock' && !p) throw badRequest('برای بردن به انبار، کالا را از کالاهای شرکت انتخاب کنید.');
    const wh = b.warehouse_id || (p && p.warehouse_id) || comp.warehouse_id || 1;
    db.tx(() => {
      const aid = Number(db.run(`INSERT INTO arrivals (company_id, product_id, description, units, disposition, warehouse_id, wrong, user_id, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`, comp.id, p ? p.id : null, b.description ?? null, b.units, b.disposition,
      b.disposition === 'stock' ? wh : null, req.user.id, nowIso()).lastInsertRowid);
      if (b.disposition === 'stock') orders.move({ productId: p.id, warehouseId: wh, ownerId: comp.id, units: b.units, kind: 'surplus_in', arrivalId: aid, userId: req.user.id, note: b.note || 'رسیده بدون سفارش' });
      audit(req, {
        action: 'receive', entity: 'company', id: comp.id,
        summary: `رسیدن ${b.units} عدد «${p ? p.name : b.description}» از ${comp.name} بدون سفارش — ${b.disposition === 'stock' ? 'به انبار رفت' : 'برگشت داده شد'}${b.note ? ` — ${b.note}` : ''}`
      });
    });
    events.emit('stock', { companyId: comp.id });
    return { ok: true };
  });
};
