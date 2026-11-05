'use strict';
/**
 * Stock in our warehouses by product, warehouse and owner (a partner company or us), its
 * movements, and the manual operations: our own goods in, surplus back to the company,
 * transfer between warehouses, correction.
 */
const { z, text, optText, intIn } = require('./validate');
const { badRequest, notFound, clampInt, searchKey } = require('../lib/util');

const KIND_LABEL = {
  surplus_in: 'اضافه‌ی رسیده', wrong_in: 'کالای اشتباه رسیده', own_in: 'ورود کالای خودمان', ship_out: 'ارسال برای سفارش',
  return_to_company: 'برگشت به شرکت', transfer_out: 'انتقال (خروج)', transfer_in: 'انتقال (ورود)', adjust: 'اصلاح موجودی', reversal: 'برگرداندن',
  return_in: 'مرجوعی مشتری', write_off: 'معیوب (حذف از موجودی)', count: 'انبارگردانی'
};

module.exports = async function stockRoutes(app) {
  const { db, orders, audit, events } = app.ctx;

  app.get('/stock', async (req) => {
    const q = req.query || {};
    const where = [];
    const params = [];
    if (q.warehouse) { where.push('m.warehouse_id = ?'); params.push(Number(q.warehouse)); }
    if (q.owner === 'own') where.push('m.owner_company_id IS NULL');
    else if (q.owner) { where.push('m.owner_company_id = ?'); params.push(Number(q.owner)); }
    if (q.company) { where.push('p.company_id = ?'); params.push(Number(q.company)); }
    for (const tok of searchKey(q.q || '').split(' ').filter(Boolean).slice(0, 6)) { where.push('p.search_text LIKE ?'); params.push(`%${tok}%`); }
    const rows = db.all(`SELECT m.product_id, m.warehouse_id, m.owner_company_id, SUM(m.units) AS units, MAX(m.created_at) AS last_move_at,
        p.name AS product_name, p.units_per_pack, p.regular_price, p.company_id, c.name AS company_name, c.currency, w.name AS warehouse_name, oc.name AS owner_name
      FROM stock_moves m JOIN products p ON p.id = m.product_id JOIN companies c ON c.id = p.company_id JOIN warehouses w ON w.id = m.warehouse_id
      LEFT JOIN companies oc ON oc.id = m.owner_company_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY m.product_id, m.warehouse_id, m.owner_company_id HAVING SUM(m.units) <> 0 ORDER BY p.name LIMIT 2000`, ...params);
    const totals = db.get(`SELECT SUM(CASE WHEN owner_company_id IS NULL THEN units ELSE 0 END) AS own, SUM(CASE WHEN owner_company_id IS NOT NULL THEN units ELSE 0 END) AS consigned FROM stock_moves`);
    return { items: rows, totals: { own: totals.own || 0, consigned: totals.consigned || 0 } };
  });

  app.get('/stock/moves', async (req) => {
    const q = req.query || {};
    const where = [];
    const params = [];
    if (q.product) { where.push('m.product_id = ?'); params.push(Number(q.product)); }
    if (q.warehouse) { where.push('m.warehouse_id = ?'); params.push(Number(q.warehouse)); }
    if (q.owner === 'own') where.push('m.owner_company_id IS NULL');
    else if (q.owner) { where.push('m.owner_company_id = ?'); params.push(Number(q.owner)); }
    const per = clampInt(q.per, 10, 200, 50);
    const page = clampInt(q.page, 1, 100000, 1);
    const sql = `FROM stock_moves m JOIN products p ON p.id = m.product_id JOIN companies c ON c.id = p.company_id JOIN warehouses w ON w.id = m.warehouse_id
                 LEFT JOIN companies oc ON oc.id = m.owner_company_id LEFT JOIN users u ON u.id = m.user_id
                 LEFT JOIN order_lines l ON l.id = m.order_line_id LEFT JOIN orders o ON o.id = l.order_id LEFT JOIN platforms pl ON pl.id = o.platform_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = db.get(`SELECT COUNT(*) AS n ${sql}`, ...params).n;
    const items = db.all(`SELECT m.*, p.name AS product_name, w.name AS warehouse_name, oc.name AS owner_name, u.name AS user_name, o.id AS order_id,
        o.order_number, pl.name AS platform_name, c.currency ${sql} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return { items: items.map((m) => ({ ...m, kind_label: KIND_LABEL[m.kind] || m.kind })), total, page, pages: Math.max(1, Math.ceil(total / per)) };
  });

  const product = (id) => {
    const p = db.get('SELECT p.*, c.name AS company_name FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id = ?', id);
    if (!p) throw notFound('کالا پیدا نشد.');
    return p;
  };
  const warehouse = (id) => {
    const w = db.get('SELECT * FROM warehouses WHERE id = ?', id);
    if (!w) throw badRequest('انبار پیدا نشد.', { warehouse_id: 'پیدا نشد.' });
    return w;
  };
  const ownerName = (id) => (id ? (db.get('SELECT name FROM companies WHERE id = ?', id) || {}).name : 'خودمان');
  const base = {
    product_id: intIn('کالا', 1, 1e12),
    warehouse_id: intIn('انبار', 1, 1e9),
    units: intIn('تعداد', 1, 10000000),
    note: optText(500).optional()
  };
  const owner = z.preprocess((v) => (v === 'own' || v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().nullable());
  function done(req, summary, companyId) {
    events.emit('stock', { companyId });
    return { ok: true, summary };
  }

  /** Our own goods (bought, not consigned) into a warehouse. */
  app.post('/stock/own-in', async (req) => {
    const b = z.object(base).parse(req.body || {});
    const p = product(b.product_id);
    const w = warehouse(b.warehouse_id);
    db.tx(() => {
      orders.move({ productId: p.id, warehouseId: w.id, ownerId: null, units: b.units, kind: 'own_in', note: b.note, userId: req.user.id });
      audit(req, { action: 'stock', entity: 'product', id: p.id, summary: `ورود ${b.units} عدد «${p.name}» (کالای خودمان) به انبار ${w.name}${b.note ? ` — ${b.note}` : ''}` });
    });
    return done(req, 'ثبت شد', p.company_id);
  });

  /** Surplus that belongs to a company goes back to it. */
  app.post('/stock/return', async (req) => {
    const b = z.object({ ...base, owner_company_id: intIn('صاحب کالا', 1, 1e9) }).parse(req.body || {});
    const p = product(b.product_id);
    const w = warehouse(b.warehouse_id);
    db.tx(() => {
      orders.move({ productId: p.id, warehouseId: w.id, ownerId: b.owner_company_id, units: -b.units, kind: 'return_to_company', note: b.note, userId: req.user.id });
      audit(req, { action: 'stock', entity: 'product', id: p.id, summary: `برگشت ${b.units} عدد «${p.name}» از انبار ${w.name} به ${ownerName(b.owner_company_id)}${b.note ? ` — ${b.note}` : ''}` });
    });
    return done(req, 'ثبت شد', p.company_id);
  });

  app.post('/stock/transfer', async (req) => {
    const b = z.object({ ...base, to_warehouse_id: intIn('انبار مقصد', 1, 1e9), owner_company_id: owner }).parse(req.body || {});
    if (b.to_warehouse_id === b.warehouse_id) throw badRequest('انبار مبدأ و مقصد یکی است.', { to_warehouse_id: 'همان انبار مبدأ است.' });
    const p = product(b.product_id);
    const from = warehouse(b.warehouse_id);
    const to = warehouse(b.to_warehouse_id);
    db.tx(() => {
      orders.move({ productId: p.id, warehouseId: from.id, ownerId: b.owner_company_id, units: -b.units, kind: 'transfer_out', note: b.note, userId: req.user.id });
      orders.move({ productId: p.id, warehouseId: to.id, ownerId: b.owner_company_id, units: b.units, kind: 'transfer_in', note: b.note, userId: req.user.id });
      audit(req, { action: 'stock', entity: 'product', id: p.id, summary: `انتقال ${b.units} عدد «${p.name}» (مال ${ownerName(b.owner_company_id)}) از ${from.name} به ${to.name}` });
    });
    return done(req, 'ثبت شد', p.company_id);
  });

  /**
   * Stocktake of one warehouse: the counted units of each (product, owner) row. Every difference
   * becomes one 'count' correction; rows not sent are left as they are.
   */
  app.post('/stock/count', async (req) => {
    const b = z.object({
      warehouse_id: base.warehouse_id,
      note: optText(500).optional(),
      counts: z.array(z.object({ product_id: z.number().int(), owner_company_id: z.number().int().nullable(), counted: z.number().int().min(0) })).min(1, 'هیچ شمارشی وارد نشده.').max(5000)
    }).parse(req.body || {});
    const w = warehouse(b.warehouse_id);
    let changed = 0, plus = 0, minus = 0;
    db.tx(() => {
      for (const c of b.counts) {
        const p = product(c.product_id);
        const have = orders.balance(p.id, w.id, c.owner_company_id);
        const diff = c.counted - have;
        if (!diff) continue;
        orders.move({ productId: p.id, warehouseId: w.id, ownerId: c.owner_company_id, units: diff, kind: 'count', userId: req.user.id, note: `انبارگردانی${b.note ? ` — ${b.note}` : ''} (سیستم ${have}، شمارش ${c.counted})` });
        changed++;
        if (diff > 0) plus += diff; else minus -= diff;
      }
      audit(req, { action: 'stock', entity: 'warehouse', id: w.id, summary: `انبارگردانی ${w.name}: ${b.counts.length} ردیف شمرده شد، ${changed} ردیف اصلاح شد (${plus} عدد اضافه، ${minus} عدد کم)${b.note ? ` — ${b.note}` : ''}` });
    });
    events.emit('stock', {});
    return { counted: b.counts.length, changed, plus, minus };
  });

  /** A correction after counting (+ or −), always with a reason. */
  app.post('/stock/adjust', async (req) => {
    const b = z.object({
      product_id: base.product_id, warehouse_id: base.warehouse_id, owner_company_id: owner,
      units: z.preprocess((v) => Number(v), z.number().int().refine((n) => n !== 0, 'تغییر نمی‌تواند صفر باشد.')),
      note: text('دلیل اصلاح', 500)
    }).parse(req.body || {});
    const p = product(b.product_id);
    const w = warehouse(b.warehouse_id);
    db.tx(() => {
      orders.move({ productId: p.id, warehouseId: w.id, ownerId: b.owner_company_id, units: b.units, kind: 'adjust', note: b.note, userId: req.user.id });
      audit(req, { action: 'stock', entity: 'product', id: p.id, summary: `اصلاح موجودی «${p.name}» (مال ${ownerName(b.owner_company_id)}) در ${w.name}: ${b.units > 0 ? '+' : ''}${b.units} عدد — دلیل: ${b.note}` });
    });
    return done(req, 'ثبت شد', p.company_id);
  });
};

module.exports.KIND_LABEL = KIND_LABEL;
