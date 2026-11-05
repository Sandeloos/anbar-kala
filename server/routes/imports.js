'use strict';
/**
 * Order import from a spreadsheet, in three calls:
 *   POST /imports/parse    { platform_id, file_name, data (base64) } → token, headers, sample, mapping
 *   POST /imports/preview  { token, platform_id, mapping, price_unit } → every row with its status
 *   POST /imports/commit   { token, platform_id, mapping, price_unit, links } → orders created, problems
 * links: { "<code or title>": { product_id, units } } creates the missing listings first.
 */
const crypto = require('crypto');
const { z, intIn } = require('./validate');
const { badRequest, nowIso, toRial, searchKey, toLatinDigits } = require('../lib/util');
const { parseDateTime } = require('../lib/jalali');
const { FIELDS, parseFile, guessMapping, num, cellText } = require('../lib/importer');

const uploads = new Map(); // token → { headers, rows, fileName, at }
setInterval(() => { const t = Date.now(); for (const [k, v] of uploads) if (t - v.at > 30 * 60e3) uploads.delete(k); }, 60e3).unref();

const mappingSchema = z.record(z.string(), z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().int().min(0).optional()));

module.exports = async function importRoutes(app) {
  const { db, orders, audit, events } = app.ctx;

  app.get('/imports/fields', async () => ({ fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.label])) }));

  app.post('/imports/parse', { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const b = z.object({ platform_id: intIn('پلتفرم', 1, 1e9), file_name: z.string().max(300), data: z.string().min(1, 'فایل خالی است.') }).parse(req.body || {});
    let parsed;
    try { parsed = await parseFile(Buffer.from(b.data, 'base64'), b.file_name); } catch (err) { throw badRequest(err.message); }
    if (!parsed.rows.length) throw badRequest('در فایل ردیفی پیدا نشد.');
    const token = crypto.randomBytes(12).toString('base64url');
    uploads.set(token, { ...parsed, fileName: b.file_name, at: Date.now() });
    const saved = db.get('SELECT mapping FROM import_mappings WHERE platform_id = ?', b.platform_id);
    let mapping = saved ? JSON.parse(saved.mapping) : null;
    // A saved mapping is used only when the file still has the same columns
    if (mapping && mapping._headers && JSON.stringify(mapping._headers) !== JSON.stringify(parsed.headers)) mapping = null;
    const guessed = guessMapping(parsed.headers);
    const platform = db.get('SELECT code FROM platforms WHERE id = ?', b.platform_id) || {};
    return {
      token, headers: parsed.headers, rows: parsed.rows.length,
      sample: parsed.rows.slice(0, 5).map((r) => r.map((v) => (v instanceof Date ? v.toISOString() : v))),
      mapping: mapping ? mapping.columns : guessed,
      price_unit: mapping ? mapping.price_unit : platform.code === 'digikala' ? 'rial' : 'toman',
      from_saved: !!mapping
    };
  });

  /** Reads every row with the mapping and matches it to listings. */
  function readRows(token, platformId, mapping, priceUnit) {
    const up = uploads.get(token);
    if (!up) throw badRequest('فایل منقضی شده؛ دوباره بارگذاری کنید.');
    for (const f of ['order_number', 'date', 'qty']) {
      if (mapping[f] === undefined) throw badRequest(`ستون «${FIELDS[f].label}» را مشخص کنید.`);
    }
    if (mapping.code === undefined && mapping.title === undefined) throw badRequest('ستون «کد کالا در پلتفرم» یا «عنوان کالا» را مشخص کنید.');
    const listings = db.all('SELECT l.*, p.name AS product_name, p.company_id FROM listings l JOIN products p ON p.id = l.product_id WHERE l.platform_id = ? AND l.active = 1', platformId);
    const byCode = new Map(listings.filter((l) => l.code).map((l) => [String(l.code).trim(), l]));
    const byTitle = new Map(listings.filter((l) => l.title).map((l) => [searchKey(l.title), l]));
    const get = (r, f) => (mapping[f] === undefined ? '' : cellText(r[mapping[f]]));
    return up.rows.map((r, i) => {
      const row = { n: i + 1, problems: [] };
      row.order_number = toLatinDigits(String(get(r, 'order_number') || '')).trim();
      const d = get(r, 'date');
      const t = get(r, 'time');
      row.ordered_at = parseDateTime(d instanceof Date ? d : `${toLatinDigits(String(d)).trim()}${t ? ' ' + toLatinDigits(String(t)).trim() : ''}`);
      row.code = toLatinDigits(String(get(r, 'code') || '')).trim();
      row.title = String(get(r, 'title') || '').trim();
      row.qty = num(get(r, 'qty'));
      const price = num(get(r, 'price'));
      row.platform_price = price === null ? null : toRial(price, priceUnit);
      row.status = String(get(r, 'status') || '');
      row.key = row.code || row.title;
      const listing = (row.code && byCode.get(row.code)) || (row.title && byTitle.get(searchKey(row.title))) || null;
      row.listing = listing ? { id: listing.id, product_name: listing.product_name, units: listing.units, title: listing.title, code: listing.code } : null;
      if (/لغو|cancel|مرجوع|returned/i.test(row.status)) row.skip = 'لغوشده';
      if (!row.order_number) row.problems.push('شماره‌ی سفارش ندارد');
      if (!row.ordered_at) row.problems.push('تاریخ قابل خواندن نیست');
      if (!row.qty || row.qty < 1 || !Number.isInteger(row.qty)) row.problems.push('تعداد معتبر نیست');
      if (!row.key) row.problems.push('کد یا عنوان کالا ندارد');
      if (row.order_number && !row.skip) {
        const o = db.get('SELECT id FROM orders WHERE platform_id = ? AND order_number = ?', platformId, row.order_number);
        if (o && listing && db.get('SELECT 1 FROM order_lines WHERE order_id = ? AND listing_id = ?', o.id, listing.id)) row.skip = 'قبلاً ثبت شده';
        row.existing_order_id = o ? o.id : null;
      }
      return row;
    });
  }

  const commonBody = {
    token: z.string(), platform_id: intIn('پلتفرم', 1, 1e9), mapping: mappingSchema,
    price_unit: z.enum(['toman', 'rial']).default('toman')
  };

  app.post('/imports/preview', async (req) => {
    const b = z.object(commonBody).parse(req.body || {});
    const rows = readRows(b.token, b.platform_id, b.mapping, b.price_unit);
    const unmatched = new Map();
    for (const r of rows) if (!r.listing && !r.skip && r.key) {
      const u = unmatched.get(r.key) || { key: r.key, code: r.code, title: r.title, rows: 0 };
      u.rows++;
      unmatched.set(r.key, u);
    }
    return {
      rows: rows.slice(0, 500),
      total: rows.length,
      ready: rows.filter((r) => r.listing && !r.skip && !r.problems.length).length,
      skipped: rows.filter((r) => r.skip).length,
      problems: rows.filter((r) => r.problems.length).length,
      unmatched: [...unmatched.values()]
    };
  });

  app.post('/imports/commit', async (req) => {
    const b = z.object({
      ...commonBody,
      links: z.record(z.string(), z.object({ product_id: z.number().int(), units: z.number().int().min(1) })).optional()
    }).parse(req.body || {});
    const up = uploads.get(b.token);
    if (!up) throw badRequest('فایل منقضی شده؛ دوباره بارگذاری کنید.');
    const pl = db.get('SELECT * FROM platforms WHERE id = ?', b.platform_id);
    // 1) Listings the admin linked during the preview
    const now = nowIso();
    let listingsCreated = 0;
    for (const [key, link] of Object.entries(b.links || {})) {
      const p = db.get('SELECT * FROM products WHERE id = ?', link.product_id);
      if (!p) continue;
      const sample = readRows(b.token, b.platform_id, b.mapping, b.price_unit).find((r) => r.key === key);
      const code = sample && sample.code ? sample.code : null;
      if (code && db.get('SELECT 1 FROM listings WHERE platform_id = ? AND code = ?', pl.id, code)) continue;
      const title = sample ? sample.title || null : key;
      const id = Number(db.run(`INSERT INTO listings (platform_id, product_id, code, title, units, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        pl.id, p.id, code, title, link.units, searchKey([code, title, p.name].filter(Boolean).join(' ')), now, now).lastInsertRowid);
      audit(req, { action: 'create', entity: 'listing', id, summary: `افزودن آگهی ${pl.name}${code ? ` (${code})` : ''} برای «${p.name}» هنگام ورود از فایل` });
      listingsCreated++;
    }
    // 2) Orders, grouped by order number
    const rows = readRows(b.token, b.platform_id, b.mapping, b.price_unit).filter((r) => !r.skip && !r.problems.length && r.listing);
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.order_number)) groups.set(r.order_number, []);
      groups.get(r.order_number).push(r);
    }
    const importId = Number(db.run('INSERT INTO imports (platform_id, file_name, rows, user_id, created_at) VALUES (?, ?, ?, ?, ?)', pl.id, up.fileName, up.rows.length, req.user.id, now).lastInsertRowid);
    let ordersCreated = 0, linesCreated = 0;
    const errors = [];
    for (const [number, list] of groups) {
      const lines = list.map((r) => ({ listing_id: r.listing.id, qty: r.qty, platform_price: r.platform_price }));
      try {
        const existing = db.get('SELECT id FROM orders WHERE platform_id = ? AND order_number = ?', pl.id, number);
        if (existing) orders.addLines(req, existing.id, lines);
        else { orders.createOrder(req, { platform_id: pl.id, order_number: number, ordered_at: list[0].ordered_at, lines }, { source: 'import', importId }); ordersCreated++; }
        linesCreated += lines.length;
      } catch (err) {
        errors.push({ order_number: number, error: err.message });
      }
    }
    const skipped = up.rows.length - linesCreated;
    db.run('UPDATE imports SET orders_created = ?, lines_created = ?, skipped = ? WHERE id = ?', ordersCreated, linesCreated, skipped, importId);
    db.run(`INSERT INTO import_mappings (platform_id, mapping, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(platform_id) DO UPDATE SET mapping = excluded.mapping, updated_at = excluded.updated_at`,
    pl.id, JSON.stringify({ columns: b.mapping, price_unit: b.price_unit, _headers: up.headers }), now);
    audit(req, { action: 'import', entity: 'import', id: importId, summary: `ورود سفارش‌های ${pl.name} از «${up.fileName}»: ${ordersCreated} سفارش، ${linesCreated} قلم${listingsCreated ? `، ${listingsCreated} آگهی جدید` : ''}${errors.length ? `، ${errors.length} سفارش ناموفق` : ''}` });
    events.emit('orders', { import: importId });
    return { orders_created: ordersCreated, lines_created: linesCreated, listings_created: listingsCreated, skipped, errors };
  });
};
