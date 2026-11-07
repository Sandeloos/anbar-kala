'use strict';
/**
 * Platforms (Digikala, Basalam, …) and listings: what a platform sells as one item and which
 * company product (and how many units of it) that is. Also the search behind every product picker.
 */
const { z, text, optText, intIn, bool, amount } = require('./validate');
const { nowIso, notFound, conflict, badRequest, searchKey, clampInt, toRial } = require('../lib/util');

const FIELDS = { platform: 'پلتفرم', product: 'کالای سایت', code: 'کد در پلتفرم', title: 'عنوان در پلتفرم', units: 'تعداد عدد در هر فروش', platform_price: 'قیمت در پلتفرم (ریال)', active: 'فعال', note: 'یادداشت' };

module.exports = async function listingRoutes(app) {
  const { db, audit, events, concurrency } = app.ctx;

  /* ------------------------------------------------------------ platforms */
  app.get('/platforms', async () => ({ items: db.all('SELECT * FROM platforms ORDER BY active DESC, sort, id').map((p) => ({ ...p, active: !!p.active })) }));

  app.post('/platforms', async (req) => {
    const body = z.object({ name: text('نام پلتفرم', 60) }).parse(req.body || {});
    if (db.get('SELECT 1 FROM platforms WHERE name = ?', body.name)) throw conflict('پلتفرمی با این نام هست.', { name: 'تکراری است.' });
    const code = 'p' + Date.now().toString(36);
    const sort = db.get('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM platforms').n;
    db.tx(() => {
      const id = Number(db.run('INSERT INTO platforms (code, name, sort, created_at) VALUES (?, ?, ?, ?)', code, body.name, sort, nowIso()).lastInsertRowid);
      audit(req, { action: 'create', entity: 'platform', id, summary: `افزودن پلتفرم «${body.name}»` });
    });
    return { items: db.all('SELECT * FROM platforms ORDER BY active DESC, sort, id') };
  });

  /* ------------------------------------------------------------ listings */
  const COLS = `l.*, pl.name AS platform_name, p.name AS product_name, p.units_per_pack, p.regular_price, p.stock_status, p.stock_quantity, p.permalink,
    p.company_id, c.name AS company_name, c.currency`;
  const one = (id) => {
    const l = db.get(`SELECT ${COLS} FROM listings l JOIN platforms pl ON pl.id = l.platform_id JOIN products p ON p.id = l.product_id
                      JOIN companies c ON c.id = p.company_id WHERE l.id = ?`, Number(id));
    if (!l) throw notFound('آگهی پیدا نشد.');
    return l;
  };
  const search = (l, p) => searchKey([l.code, l.title, p.name, p.sku].filter(Boolean).join(' '));

  app.get('/listings', async (req) => {
    const q = req.query || {};
    const where = [];
    const params = [];
    if (q.platform) { where.push('l.platform_id = ?'); params.push(Number(q.platform)); }
    if (q.company) { where.push('p.company_id = ?'); params.push(Number(q.company)); }
    if (q.product) { where.push('l.product_id = ?'); params.push(Number(q.product)); }
    if (q.partial === '1') where.push('l.units <> p.units_per_pack');
    for (const tok of searchKey(q.q || '').split(' ').filter(Boolean).slice(0, 6)) { where.push('l.search_text LIKE ?'); params.push(`%${tok}%`); }
    const per = clampInt(q.per, 10, 200, 50);
    const page = clampInt(q.page, 1, 100000, 1);
    const sql = `FROM listings l JOIN platforms pl ON pl.id = l.platform_id JOIN products p ON p.id = l.product_id JOIN companies c ON c.id = p.company_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const total = db.get(`SELECT COUNT(*) AS n ${sql}`, ...params).n;
    const items = db.all(`SELECT ${COLS} ${sql} ORDER BY l.active DESC, l.updated_at DESC LIMIT ? OFFSET ?`, ...params, per, (page - 1) * per);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / per)) };
  });

  const listingBody = z.object({
    platform_id: intIn('پلتفرم', 1, 1e9),
    product_id: intIn('کالا', 1, 1e12),
    code: optText(120).optional(),
    title: optText(300).optional(),
    units: intIn('تعداد عدد در هر فروش', 1, 100000),
    platform_price: z.preprocess((v) => (v === '' || v === null || v === undefined ? null : v), amount('قیمت در پلتفرم').nullable()).optional(),
    note: optText(1000).optional(),
    active: bool.optional()
  });

  function checkCode(platformId, code, exceptId) {
    if (!code) return;
    const dupe = db.get('SELECT id FROM listings WHERE platform_id = ? AND code = ? AND id <> ?', platformId, code, exceptId || 0);
    if (dupe) throw conflict('این کد در همین پلتفرم برای آگهی دیگری ثبت شده است.', { code: 'تکراری است.' });
  }

  app.post('/listings', async (req) => {
    const b = listingBody.parse(req.body || {});
    const p = db.get('SELECT * FROM products WHERE id = ?', b.product_id);
    if (!p) throw badRequest('کالا پیدا نشد.', { product_id: 'پیدا نشد.' });
    if (!db.get('SELECT 1 FROM platforms WHERE id = ?', b.platform_id)) throw badRequest('پلتفرم پیدا نشد.');
    checkCode(b.platform_id, b.code);
    const now = nowIso();
    const price = b.platform_price === null || b.platform_price === undefined ? null : toRial(b.platform_price, 'toman');
    const l = db.tx(() => {
      const id = Number(db.run(`INSERT INTO listings (platform_id, product_id, code, title, units, platform_price, note, search_text, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.platform_id, b.product_id, b.code ?? null, b.title ?? null, b.units, price, b.note ?? null, search(b, p), now, now).lastInsertRowid);
      const row = one(id);
      audit(req, { action: 'create', entity: 'listing', id, summary: `افزودن آگهی ${row.platform_name}${row.code ? ` (${row.code})` : ''} برای «${p.name}» — هر فروش ${b.units} عدد از ${p.units_per_pack}` });
      events.emit('listings', { ids: [id] });
      return row;
    });
    return { listing: l };
  });

  app.put('/listings/:id', async (req) => {
    const before = one(req.params.id);
    concurrency.check(req, before, { entity: 'listing', label: 'این آگهی' });
    const b = listingBody.parse(req.body || {});
    const p = db.get('SELECT * FROM products WHERE id = ?', b.product_id);
    if (!p) throw badRequest('کالا پیدا نشد.', { product_id: 'پیدا نشد.' });
    checkCode(b.platform_id, b.code, before.id);
    const price = b.platform_price === null || b.platform_price === undefined ? null : toRial(b.platform_price, 'toman');
    const after = { ...before, ...b, code: b.code ?? null, title: b.title ?? null, note: b.note ?? null, platform_price: price, active: b.active === undefined ? before.active : b.active ? 1 : 0 };
    const pname = (pid) => (db.get('SELECT name FROM platforms WHERE id = ?', pid) || {}).name;
    const prname = (pid) => (db.get('SELECT name FROM products WHERE id = ?', pid) || {}).name;
    const label = (r) => ({ ...r, platform: pname(r.platform_id), product: prname(r.product_id), active: r.active ? 'بله' : 'خیر' });
    const changes = audit.diff(label(before), label(after), FIELDS);
    if (changes.length) db.tx(() => {
      db.run(`UPDATE listings SET platform_id = ?, product_id = ?, code = ?, title = ?, units = ?, platform_price = ?, note = ?, active = ?, search_text = ?, updated_at = ?,
              version = version + 1 WHERE id = ? AND version = ?`, after.platform_id, after.product_id, after.code, after.title, after.units, after.platform_price, after.note, after.active,
      search(after, p), nowIso(), before.id, before.version).changes || concurrency.stale(one(before.id), { entity: 'listing', label: 'این آگهی' });
      audit(req, { action: 'update', entity: 'listing', id: before.id, summary: `ویرایش آگهی ${after.code || ''} «${p.name}»`, changes });
      events.emit('listings', { ids: [before.id] });
    });
    return { listing: one(before.id) };
  });

  /**
   * The search behind product pickers: listings of the chosen platform first (by code, title or
   * product name), then company products. A pasted listing code matches exactly.
   */
  app.get('/pick', async (req) => {
    const q = String(req.query.q || '').trim();
    const platformId = Number(req.query.platform || 0);
    const companyId = Number(req.query.company || 0);
    if (!q) return { items: [] };
    const toks = searchKey(q).split(' ').filter(Boolean).slice(0, 6);
    const out = [];
    if (platformId && !req.query.products_only) {
      const exact = db.all(`SELECT ${COLS} FROM listings l JOIN platforms pl ON pl.id = l.platform_id JOIN products p ON p.id = l.product_id
                            JOIN companies c ON c.id = p.company_id WHERE l.platform_id = ? AND l.code = ? AND l.active = 1`, platformId, q);
      const like = db.all(`SELECT ${COLS} FROM listings l JOIN platforms pl ON pl.id = l.platform_id JOIN products p ON p.id = l.product_id
                           JOIN companies c ON c.id = p.company_id WHERE l.platform_id = ? AND l.active = 1 ${toks.map(() => 'AND l.search_text LIKE ?').join(' ')}
                           ${companyId ? 'AND p.company_id = ?' : ''} ORDER BY l.updated_at DESC LIMIT 8`,
      platformId, ...toks.map((t) => `%${t}%`), ...(companyId ? [companyId] : []));
      const seen = new Set();
      for (const l of [...exact, ...like]) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        out.push({ kind: 'listing', id: l.id, listing_id: l.id, product_id: l.product_id, name: l.title || l.product_name, product_name: l.product_name, code: l.code,
          company_id: l.company_id, company_name: l.company_name, currency: l.currency, units: l.units, units_per_pack: l.units_per_pack, regular_price: l.regular_price,
          stock_status: l.stock_status, platform_price: l.platform_price });
      }
    }
    const products = db.all(`SELECT p.id, p.name, p.sku, p.units_per_pack, p.regular_price, p.stock_status, p.stock_quantity, p.company_id, p.configured_at,
                               c.name AS company_name, c.currency FROM products p JOIN companies c ON c.id = p.company_id
                             WHERE p.removed_at IS NULL ${toks.map(() => 'AND p.search_text LIKE ?').join(' ')} ${companyId ? 'AND p.company_id = ?' : ''}
                             ORDER BY p.name LIMIT ?`, ...toks.map((t) => `%${t}%`), ...(companyId ? [companyId] : []), out.length ? 8 : 12);
    for (const p of products) {
      out.push({ kind: 'product', id: p.id, product_id: p.id, name: p.name, product_name: p.name, code: p.sku, company_id: p.company_id, company_name: p.company_name,
        currency: p.currency, units: p.units_per_pack, units_per_pack: p.units_per_pack, regular_price: p.regular_price, stock_status: p.stock_status, configured: !!p.configured_at });
    }
    return { items: out };
  });
};
