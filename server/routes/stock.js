'use strict';
/**
 * Stock in our warehouses by product, warehouse and owner (a partner company or us), its
 * movements (read side), and the manual operations, which the ledger (lib/stock.js) carries out:
 * our own goods in, surplus back to the company, transfer between warehouses, stocktake, correction.
 */
const { z, text, optText, intIn } = require('./validate');
const { clampInt, searchKey } = require('../lib/util');

const { KIND_LABEL } = require('../lib/stock');

module.exports = async function stockRoutes(app) {
  const { db, stock } = app.ctx;

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

  const base = {
    product_id: intIn('کالا', 1, 1e12),
    warehouse_id: intIn('انبار', 1, 1e9),
    units: intIn('تعداد', 1, 10000000),
    note: optText(500).optional()
  };
  const owner = z.preprocess((v) => (v === 'own' || v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().nullable());
  const ok = () => ({ ok: true, summary: 'ثبت شد' });

  /** Our own goods (bought, not consigned) into a warehouse. */
  app.post('/stock/own-in', async (req) => { stock.ownIn(req, z.object(base).parse(req.body || {})); return ok(); });

  /** Surplus that belongs to a company goes back to it. */
  app.post('/stock/return', async (req) => {
    stock.returnToCompany(req, z.object({ ...base, owner_company_id: intIn('صاحب کالا', 1, 1e9) }).parse(req.body || {}));
    return ok();
  });

  app.post('/stock/transfer', async (req) => {
    stock.transfer(req, z.object({ ...base, to_warehouse_id: intIn('انبار مقصد', 1, 1e9), owner_company_id: owner }).parse(req.body || {}));
    return ok();
  });

  /** Stocktake of one warehouse (see stock.count). */
  app.post('/stock/count', async (req) => stock.count(req, z.object({
    warehouse_id: base.warehouse_id,
    note: optText(500).optional(),
    counts: z.array(z.object({ product_id: z.number().int(), owner_company_id: z.number().int().nullable(), counted: z.number().int().min(0) })).min(1, 'هیچ شمارشی وارد نشده.').max(5000)
  }).parse(req.body || {})));

  /** A correction after counting (+ or −), always with a reason. */
  app.post('/stock/adjust', async (req) => {
    stock.adjust(req, z.object({
      product_id: base.product_id, warehouse_id: base.warehouse_id, owner_company_id: owner,
      units: z.preprocess((v) => Number(v), z.number().int().refine((n) => n !== 0, 'تغییر نمی‌تواند صفر باشد.')),
      note: text('دلیل اصلاح', 500)
    }).parse(req.body || {}));
    return ok();
  });
};

module.exports.KIND_LABEL = KIND_LABEL;
