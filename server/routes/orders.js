'use strict';
/** Orders: the list, one order, entering an order (with live site price), cancel, manual prices. */
const { z, optText, intIn, amount, text } = require('./validate');
const { clampInt, searchKey, toRial, badRequest } = require('../lib/util');
const { parseDateTime } = require('../lib/jalali');
const { companyAmountSql } = require('../lib/orders');

const money = (label) => z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), amount(label).nullable()).optional();
const when = z.preprocess((v) => (v ? parseDateTime(v) : null), z.string({ error: 'تاریخ و ساعت سفارش را وارد کنید.' }));

const lineSchema = z.object({
  listing_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
  product_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
  qty: intIn('تعداد', 1, 100000),
  units_per_sale: z.preprocess((v) => (v ? v : undefined), intIn('تعداد عدد در هر فروش', 1, 100000).optional()),
  platform_price: money('قیمت پلتفرم'),         // tomans, per sale
  site_price_manual: money('قیمت سایت'),        // in the company's currency, per product row
  settle_unit_price_manual: money('مبلغ هر فروش'), // in the company's currency, per sale
  reason: optText(500).optional()
});

module.exports = async function orderRoutes(app) {
  const { db, orders } = app.ctx;

  /** Converts amounts typed in tomans (platform) or the company's currency (site, settlement) to rials. */
  function toRials(line) {
    const out = { ...line };
    if (line.platform_price !== null && line.platform_price !== undefined) out.platform_price = toRial(line.platform_price, 'toman');
    const productId = line.listing_id ? (db.get('SELECT product_id FROM listings WHERE id = ?', line.listing_id) || {}).product_id : line.product_id;
    const cur = productId ? (db.get('SELECT c.currency FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id = ?', productId) || {}).currency : 'toman';
    if (line.site_price_manual !== null && line.site_price_manual !== undefined) out.site_price_manual = toRial(line.site_price_manual, cur);
    if (line.settle_unit_price_manual !== null && line.settle_unit_price_manual !== undefined) out.settle_unit_price_manual = toRial(line.settle_unit_price_manual, cur);
    return out;
  }

  app.get('/orders', async (req) => {
    const q = req.query || {};
    const where = [];
    const params = [];
    if (q.platform) { where.push('o.platform_id = ?'); params.push(Number(q.platform)); }
    if (q.company) { where.push('EXISTS (SELECT 1 FROM order_lines x WHERE x.order_id = o.id AND x.company_id = ?)'); params.push(Number(q.company)); }
    if (q.from) { const t = parseDateTime(q.from); if (t) { where.push('o.ordered_at >= ?'); params.push(t); } }
    if (q.to) { const t = parseDateTime(q.to); if (t) { where.push('o.ordered_at < ?'); params.push(t); } }
    if (q.status === 'pending') where.push("o.cancelled_at IS NULL AND EXISTS (SELECT 1 FROM order_lines x WHERE x.order_id = o.id AND x.status = 'pending')");
    if (q.status === 'done') where.push("o.cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM order_lines x WHERE x.order_id = o.id AND x.status = 'pending')");
    if (q.status === 'cancelled') where.push('o.cancelled_at IS NOT NULL');
    if (q.status === 'manual') where.push('EXISTS (SELECT 1 FROM order_lines x WHERE x.order_id = o.id AND (x.settle_manual = 1 OR x.price_uncertain = 1))');
    const term = String(q.q || '').trim();
    if (term) {
      const toks = searchKey(term).split(' ').filter(Boolean).slice(0, 5);
      where.push(`(o.order_number LIKE ? OR (${toks.map(() => 'EXISTS (SELECT 1 FROM order_lines x JOIN products p ON p.id = x.product_id WHERE x.order_id = o.id AND p.search_text LIKE ?)').join(' AND ') || '0'}))`);
      params.push(`%${term}%`, ...toks.map((t) => `%${t}%`));
    }
    const per = clampInt(q.per, 10, 200, 50);
    const page = clampInt(q.page, 1, 100000, 1);
    const sql = `FROM orders o JOIN platforms pl ON pl.id = o.platform_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = db.get(`SELECT COUNT(*) AS n ${sql}`, ...params).n;
    const items = db.all(`SELECT o.*, pl.name AS platform_name,
        (SELECT COUNT(*) FROM order_lines x WHERE x.order_id = o.id) AS lines,
        (SELECT COUNT(*) FROM order_lines x WHERE x.order_id = o.id AND x.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM order_lines x WHERE x.order_id = o.id AND (x.settle_manual = 1 OR x.price_uncertain = 1)) AS flagged,
        (SELECT GROUP_CONCAT(name, '، ') FROM (SELECT DISTINCT c.name FROM order_lines x JOIN companies c ON c.id = x.company_id WHERE x.order_id = o.id)) AS companies,
        (SELECT GROUP_CONCAT(p.name, '، ') FROM order_lines x JOIN products p ON p.id = x.product_id WHERE x.order_id = o.id) AS products,
        (SELECT SUM(${companyAmountSql('x')}) FROM order_lines x WHERE x.order_id = o.id) AS settle_total
      ${sql} ORDER BY o.ordered_at DESC, o.id DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / per)) };
  });

  app.get('/orders/:id', async (req) => orders.orderDetail(req.params.id));

  /** The site price for a product at the order time (reads the site first when the order is recent). */
  app.post('/orders/quote', async (req) => {
    const b = z.object({
      listing_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      product_id: z.preprocess((v) => (v ? Number(v) : undefined), z.number().int().optional()),
      ordered_at: when
    }).parse(req.body || {});
    let productId = b.product_id;
    if (b.listing_id) productId = (db.get('SELECT product_id FROM listings WHERE id = ?', b.listing_id) || {}).product_id;
    if (!productId) throw badRequest('کالا را انتخاب کنید.');
    return orders.quote(productId, b.ordered_at);
  });

  app.post('/orders', async (req) => {
    const b = z.object({
      platform_id: intIn('پلتفرم', 1, 1e9),
      order_number: optText(60).optional(),
      ordered_at: when,
      customer: optText(120).optional(),
      note: optText(1000).optional(),
      lines: z.array(lineSchema, { error: 'کالاهای سفارش را وارد کنید.' }).min(1, 'دست‌کم یک کالا اضافه کنید.').max(200)
    }).parse(req.body || {});
    const id = orders.createOrder(req, { ...b, lines: b.lines.map(toRials) });
    return orders.orderDetail(id);
  });

  app.post('/orders/:id/lines', async (req) => {
    const b = z.object({ lines: z.array(lineSchema).min(1, 'دست‌کم یک کالا اضافه کنید.').max(100) }).parse(req.body || {});
    orders.addLines(req, req.params.id, b.lines.map(toRials));
    return orders.orderDetail(req.params.id);
  });

  app.post('/orders/:id/cancel', async (req) => {
    const b = z.object({ reason: text('دلیل لغو', 500) }).parse(req.body || {});
    orders.cancelOrder(req, req.params.id, b.reason);
    return orders.orderDetail(req.params.id);
  });

  app.put('/order-lines/:id/price', async (req) => {
    const b = z.object({ site_price: money('قیمت سایت'), settle_unit_price: money('مبلغ هر فروش'), reason: text('دلیل', 500) }).parse(req.body || {});
    const l = orders.lineRow(req.params.id);
    const cur = (db.get('SELECT currency FROM companies WHERE id = ?', l.company_id) || {}).currency;
    orders.setLinePrice(req, l.id, {
      site_price: b.site_price === null || b.site_price === undefined ? undefined : toRial(b.site_price, cur),
      settle_unit_price: b.settle_unit_price === null || b.settle_unit_price === undefined ? undefined : toRial(b.settle_unit_price, cur),
      reason: b.reason
    });
    return orders.orderDetail(l.order_id);
  });
};
