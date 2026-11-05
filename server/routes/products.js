'use strict';
/**
 * Products read from the company sites: the searchable list, one product with
 * its price history, our own settings for it (units per pack, surplus
 * warehouse), refresh-from-site, manual price, "find by link", and the feed of
 * price/stock changes.
 */
const { z, optText, intIn, amount, bool, isoTime, text } = require('./validate');
const { searchKey, nowIso, notFound, badRequest, clampInt, toRial, toLatinDigits } = require('../lib/util');

const SORTS = {
  name: 'p.name COLLATE NOCASE',
  price: 'p.regular_price',
  changed: 'p.last_changed_at',
  stock: 'p.stock_quantity',
  company: 'c.name, p.name'
};
const SETTING_FIELDS = { units_per_pack: 'تعداد در هر بسته', warehouse: 'انبار اضافه‌ها', tracked: 'پیگیری', note: 'یادداشت' };

module.exports = async function productRoutes(app) {
  const { db, audit, sync } = app.ctx;

  const COLS = `p.id, p.company_id, p.woo_id, p.parent_woo_id, p.type, p.name, p.parent_name, p.attributes, p.sku, p.permalink,
    p.site_status, p.regular_price, p.sale_price, p.stock_status, p.stock_quantity, p.manage_stock, p.price_source,
    p.units_per_pack, p.units_guessed, p.warehouse_id, p.tracked, p.note, p.configured_at, p.last_checked_at, p.last_changed_at, p.removed_at,
    p.site_modified_at, c.name AS company_name, c.currency, c.warehouse_id AS company_warehouse_id`;

  function filters(q) {
    const where = [];
    const params = [];
    const status = q.status || 'active';
    if (status === 'active') where.push('p.removed_at IS NULL');
    else if (status === 'removed') where.push('p.removed_at IS NOT NULL');
    if (q.company) { where.push('p.company_id = ?'); params.push(Number(q.company)); }
    if (['instock', 'outofstock', 'onbackorder'].includes(q.stock)) { where.push('p.stock_status = ?'); params.push(q.stock); }
    if (q.setup === 'todo') where.push('p.configured_at IS NULL');
    if (q.setup === 'done') where.push('p.configured_at IS NOT NULL');
    if (q.setup === 'guessed') where.push('p.configured_at IS NULL AND p.units_guessed = 1');
    if (q.packs === 'multi') where.push('p.units_per_pack > 1');
    if (q.changed === '24h' || q.changed === '7d') {
      where.push('p.last_changed_at >= ?');
      params.push(new Date(Date.now() - (q.changed === '24h' ? 1 : 7) * 864e5).toISOString());
    }
    if (q.manual === '1') where.push("p.price_source = 'manual'");
    const term = String(q.q || '').trim();
    if (term) {
      if (/^https?:\/\//i.test(term)) {
        // A pasted link: match its path (Persian slugs may be percent-encoded either way)
        let path = term;
        try { const u = new URL(term); path = u.pathname.replace(/\/+$/, ''); } catch { /* keep */ }
        where.push('(p.permalink LIKE ? OR p.permalink LIKE ?)');
        params.push(`%${path}%`, `%${encodeURI(decodeURIComponent(path)).toLowerCase()}%`);
      } else {
        for (const tok of searchKey(term).split(' ').filter(Boolean).slice(0, 6)) {
          where.push('p.search_text LIKE ?');
          params.push(`%${tok}%`);
        }
      }
    }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
  }

  app.get('/products', async (req) => {
    const q = req.query || {};
    const per = clampInt(q.per, 10, 200, 50);
    const page = clampInt(q.page, 1, 100000, 1);
    const sortKey = SORTS[q.sort] ? q.sort : 'name';
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
    const { sql, params } = filters(q);
    const total = db.get(`SELECT COUNT(*) AS n FROM products p JOIN companies c ON c.id = p.company_id ${sql}`, ...params).n;
    const items = db.all(`SELECT ${COLS} FROM products p JOIN companies c ON c.id = p.company_id ${sql}
                          ORDER BY ${SORTS[sortKey]} ${dir} NULLS LAST, p.id LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / per)), per };
  });

  /** Several products by id (the list refreshes rows that changed live). */
  app.get('/products/by-ids', async (req) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Number.isInteger).slice(0, 500);
    if (!ids.length) return { items: [] };
    return { items: db.all(`SELECT ${COLS} FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids) };
  });

  function detail(id) {
    const p = db.get(`SELECT ${COLS}, c.site_url, c.price_unit FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id = ?`, Number(id));
    if (!p) throw notFound('کالا پیدا نشد.');
    const history = db.all(`SELECT h.*, u.name AS user_name FROM price_history h LEFT JOIN users u ON u.id = h.user_id
                            WHERE h.product_id = ? ORDER BY h.effective_at DESC, h.id DESC LIMIT 300`, p.id);
    const activity = db.all(`SELECT a.id, a.action, a.summary, a.changes, a.created_at, u.name AS user_name FROM audit_log a
                             LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'product' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 50`, String(p.id))
      .map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : [] }));
    const siblings = p.parent_woo_id
      ? db.all(`SELECT id, name, attributes, regular_price, stock_status, units_per_pack FROM products
                WHERE company_id = ? AND parent_woo_id = ? AND id <> ? AND removed_at IS NULL ORDER BY woo_id`, p.company_id, p.parent_woo_id, p.id)
      : [];
    const listings = db.all(`SELECT l.id, l.code, l.title, l.units, l.active, pl.name AS platform_name FROM listings l JOIN platforms pl ON pl.id = l.platform_id
                             WHERE l.product_id = ? ORDER BY l.active DESC, pl.sort`, p.id);
    const stock = db.all(`SELECT m.warehouse_id, m.owner_company_id, SUM(m.units) AS units, w.name AS warehouse_name, oc.name AS owner_name
                          FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN companies oc ON oc.id = m.owner_company_id
                          WHERE m.product_id = ? GROUP BY m.warehouse_id, m.owner_company_id HAVING SUM(m.units) <> 0`, p.id);
    return { product: p, history, activity, siblings, listings, stock };
  }

  app.get('/products/:id', async (req) => detail(req.params.id));

  const warehouseLabel = (id) => (id ? (db.get('SELECT name FROM warehouses WHERE id = ?', id) || {}).name : 'پیش‌فرض شرکت');
  function saveSettings(req, before, values) {
    const after = { ...before, ...values };
    const label = (r) => ({ ...r, warehouse: warehouseLabel(r.warehouse_id), tracked: r.tracked ? 'بله' : 'خیر' });
    const changes = audit.diff(label(before), label(after), SETTING_FIELDS);
    const now = nowIso();
    db.run(`UPDATE products SET units_per_pack = ?, warehouse_id = ?, tracked = ?, note = ?, units_guessed = 0, configured_at = COALESCE(configured_at, ?), updated_at = ?
            WHERE id = ?`, after.units_per_pack, after.warehouse_id, after.tracked ? 1 : 0, after.note, now, now, before.id);
    if (changes.length || !before.configured_at) {
      audit(req, {
        action: 'update', entity: 'product', id: before.id,
        summary: changes.length ? `تنظیم کالا «${before.name}»` : `تأیید تنظیمات کالا «${before.name}» (${after.units_per_pack} عدد در هر بسته)`, changes
      });
    }
  }
  const warehouseId = z.preprocess((v) => (v === '' || v === undefined || v === 'company' ? null : v), intIn('انبار', 1, 1e9).nullable());
  const checkWarehouse = (id) => {
    if (id && !db.get('SELECT 1 FROM warehouses WHERE id = ? AND active = 1', id)) throw badRequest('انبار انتخاب‌شده فعال نیست.', { warehouse_id: 'فعال نیست.' });
  };

  app.put('/products/:id', async (req) => {
    const before = db.get('SELECT * FROM products WHERE id = ?', Number(req.params.id));
    if (!before) throw notFound('کالا پیدا نشد.');
    const body = z.object({
      units_per_pack: intIn('تعداد در هر بسته', 1, 100000),
      warehouse_id: warehouseId,
      tracked: bool,
      note: optText(1000).optional()
    }).parse(req.body || {});
    checkWarehouse(body.warehouse_id);
    saveSettings(req, before, { ...body, note: body.note ?? null, tracked: body.tracked ? 1 : 0 });
    return detail(before.id);
  });

  /** The same settings for many products at once (only the fields sent change). */
  app.put('/products/bulk', async (req) => {
    const body = z.object({
      ids: z.array(z.number().int()).min(1, 'هیچ کالایی انتخاب نشده.').max(1000, 'حداکثر ۱۰۰۰ کالا در یک بار.'),
      units_per_pack: intIn('تعداد در هر بسته', 1, 100000).optional(),
      warehouse_id: warehouseId.optional(),
      tracked: bool.optional(),
      confirm_only: bool.optional()
    }).parse(req.body || {});
    if (body.warehouse_id !== undefined) checkWarehouse(body.warehouse_id);
    let n = 0;
    db.tx(() => {
      for (const id of body.ids) {
        const before = db.get('SELECT * FROM products WHERE id = ?', id);
        if (!before) continue;
        const values = {};
        if (body.units_per_pack !== undefined) values.units_per_pack = body.units_per_pack;
        if (body.warehouse_id !== undefined) values.warehouse_id = body.warehouse_id;
        if (body.tracked !== undefined) values.tracked = body.tracked ? 1 : 0;
        saveSettings(req, before, values);
        n++;
      }
    });
    return { updated: n };
  });

  /**
   * Accepts every "units per pack" read from product names that is still waiting
   * (optionally for one company). One activity row per product, like a manual confirm.
   */
  app.post('/products/confirm-guessed', async (req) => {
    const company = req.body && req.body.company ? Number(req.body.company) : null;
    const rows = db.all(`SELECT * FROM products WHERE configured_at IS NULL AND units_guessed = 1 AND removed_at IS NULL
                         ${company ? 'AND company_id = ?' : ''}`, ...(company ? [company] : []));
    db.tx(() => { for (const p of rows) saveSettings(req, p, {}); });
    return { updated: rows.length };
  });

  app.post('/products/:id/refresh', async (req) => {
    await sync.refreshProduct(Number(req.params.id), { userId: req.user.id });
    return detail(req.params.id);
  });

  app.post('/products/:id/manual-price', async (req) => {
    const p = db.get('SELECT p.*, c.currency FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id = ?', Number(req.params.id));
    if (!p) throw notFound('کالا پیدا نشد.');
    const body = z.object({
      regular_price: amount('قیمت'),
      sale_price: z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), amount('قیمت با تخفیف').nullable()).optional(),
      effective_at: isoTime.optional(),
      note: text('دلیل', 500)
    }).parse(req.body || {});
    const regular = toRial(body.regular_price, p.currency);
    const sale = body.sale_price ? toRial(body.sale_price, p.currency) : null;
    const at = body.effective_at ? new Date(body.effective_at).toISOString() : undefined;
    const before = p.regular_price;
    sync.manualPrice(p.id, { regular, sale, effectiveAt: at, note: body.note, userId: req.user.id });
    audit(req, {
      action: 'price', entity: 'product', id: p.id, summary: `ثبت دستی قیمت «${p.name}» — دلیل: ${body.note}`,
      changes: [{ field: 'regular_price', label: 'قیمت (ریال)', from: before, to: regular }]
    });
    return detail(p.id);
  });

  /** The site price that applied at a moment (used by order entry in phase 2). */
  app.get('/products/:id/price-at', async (req) => {
    const at = req.query.at ? new Date(toLatinDigits(req.query.at)) : new Date();
    if (Number.isNaN(at.getTime())) throw badRequest('زمان معتبر نیست.');
    return { at: at.toISOString(), price: sync.priceAt(Number(req.params.id), at.toISOString()) };
  });

  app.post('/products/lookup', async (req) => {
    const body = z.object({ url: text('لینک کالا', 2000) }).parse(req.body || {});
    const r = await sync.lookupUrl(body.url, { userId: req.user.id });
    const items = db.all(`SELECT ${COLS} FROM products p JOIN companies c ON c.id = p.company_id
                          WHERE p.id IN (${r.ids.map(() => '?').join(',') || 'NULL'}) ORDER BY p.woo_id`, ...r.ids);
    return { company: r.company, items, matched: r.matched };
  });

  /** Feed of price (and optionally stock) changes, newest first, with the previous value. */
  app.get('/changes', async (req) => {
    const q = req.query || {};
    const per = clampInt(q.per, 10, 200, 50);
    const page = clampInt(q.page, 1, 100000, 1);
    const where = ["h.source <> 'import'"];
    const params = [];
    if (q.kind === 'stock') where.push('h.stock_changed = 1');
    else if (q.kind !== 'all') where.push('h.price_changed = 1');
    if (q.company) { where.push('p.company_id = ?'); params.push(Number(q.company)); }
    if (q.since) { where.push('h.observed_at >= ?'); params.push(new Date(q.since).toISOString()); }
    if (q.direction === 'up' || q.direction === 'down') {
      where.push(`h.regular_price ${q.direction === 'up' ? '>' : '<'} (SELECT h2.regular_price FROM price_history h2 WHERE h2.product_id = h.product_id
                 AND (h2.effective_at < h.effective_at OR (h2.effective_at = h.effective_at AND h2.id < h.id)) ORDER BY h2.effective_at DESC, h2.id DESC LIMIT 1)`);
    }
    const sql = `FROM price_history h JOIN products p ON p.id = h.product_id JOIN companies c ON c.id = p.company_id
                 LEFT JOIN users u ON u.id = h.user_id WHERE ${where.join(' AND ')}`;
    const total = db.get(`SELECT COUNT(*) AS n ${sql}`, ...params).n;
    const items = db.all(`SELECT h.*, p.name, p.company_id, p.permalink, p.units_per_pack, c.name AS company_name, c.currency, u.name AS user_name,
        (SELECT h2.regular_price FROM price_history h2 WHERE h2.product_id = h.product_id
           AND (h2.effective_at < h.effective_at OR (h2.effective_at = h.effective_at AND h2.id < h.id)) ORDER BY h2.effective_at DESC, h2.id DESC LIMIT 1) AS prev_regular_price,
        (SELECT h2.stock_status FROM price_history h2 WHERE h2.product_id = h.product_id
           AND (h2.effective_at < h.effective_at OR (h2.effective_at = h.effective_at AND h2.id < h.id)) ORDER BY h2.effective_at DESC, h2.id DESC LIMIT 1) AS prev_stock_status,
        (SELECT h2.stock_quantity FROM price_history h2 WHERE h2.product_id = h.product_id
           AND (h2.effective_at < h.effective_at OR (h2.effective_at = h.effective_at AND h2.id < h.id)) ORDER BY h2.effective_at DESC, h2.id DESC LIMIT 1) AS prev_stock_quantity
      ${sql} ORDER BY h.observed_at DESC, h.id DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / per)) };
  });
};
