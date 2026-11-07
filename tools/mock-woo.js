'use strict';
/**
 * A fake WooCommerce shop for development, the demo and the tests.
 * It speaks the parts of the WooCommerce REST API (v3) that Anbar uses, with
 * the same quirks: string prices, X-WP-Total headers, _fields, modified_after,
 * variations under their parent, stock changes that do not touch date_modified,
 * and optionally ?rest_route= addresses only (sites without pretty links).
 * It can also push signed changes to Anbar exactly like the WordPress plugin.
 *
 *   node tools/mock-woo.js --port 8091 --products 300 --name "فروشگاه نمونه"
 */
const http = require('http');
const crypto = require('crypto');

/* ------------------------------------------------------------ deterministic data */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ITEMS = [
  ['لیوان کاغذی', ['۲۲۰ سی‌سی', '۲۵۰ سی‌سی', '۳۶۰ سی‌سی']],
  ['لیوان یکبار مصرف شفاف', ['۲۰۰ سی‌سی', '۳۰۰ سی‌سی']],
  ['ظرف یکبار مصرف گیاهی', ['۵۰۰ گرمی', '۷۵۰ گرمی', '۱۰۰۰ گرمی']],
  ['قاشق چوبی', ['۱۴ سانتی', '۱۶ سانتی']],
  ['چنگال یکبار مصرف', ['سفید', 'مشکی']],
  ['دستمال کاغذی رولی', ['۲ لایه', '۳ لایه']],
  ['کیسه فریزر', ['کوچک', 'متوسط', 'بزرگ']],
  ['سلفون غذا', ['۳۰ متری', '۱۰۰ متری']],
  ['فویل آلومینیوم', ['۱۰ متری', '۲۵ متری']],
  ['نی کاغذی', ['ساده', 'راه‌راه']],
  ['پاکت کرافت', ['سایز ۱', 'سایز ۲', 'سایز ۳']],
  ['دستکش یکبار مصرف', ['نایلونی', 'لاتکس', 'نیتریل']],
  ['کاسه کاغذی', ['۳۵۰ سی‌سی', '۵۰۰ سی‌سی']],
  ['درب لیوان', ['تخت', 'گنبدی']],
  ['جعبه پیتزا', ['۲۶ سانت', '۳۰ سانت', '۳۶ سانت']]
];
const BRANDS = ['ایران‌پک', 'سبزینه', 'پارس', 'آوا', 'نیکان', 'ستاره', 'زاگرس', 'البرز'];
const PACKS = [25, 50, 100];

function slugify(s) { return s.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').toLowerCase(); }
const enc = (s) => encodeURIComponent(s).toLowerCase();

function generate({ count, seed, base, variableRatio = 0.3 }) {
  const rnd = prng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const products = [];
  let id = 1000 + Math.floor(rnd() * 1000);
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const [item, sizes] = ITEMS[i % ITEMS.length];
    const brand = BRANDS[Math.floor(i / ITEMS.length) % BRANDS.length];
    const size = pick(sizes);
    const name = `${item} ${size} ${brand}`;
    const slug = slugify(name) + '-' + (i + 1);
    const pid = ++id;
    const modified = new Date(now - Math.floor(rnd() * 30) * 864e5).toISOString();
    const unitPrice = Math.round((200 + rnd() * 4000) / 10) * 10;
    if (rnd() < variableRatio) {
      // A variable product: "تعداد در بسته" 25 / 100 (the case the owner described)
      const variations = [25, 100].map((pack) => {
        const vid = ++id;
        const regular = String(Math.round(unitPrice * pack * (pack === 100 ? 0.92 : 1) / 100) * 100);
        return {
          id: vid, parent_id: pid, status: 'publish', sku: `${pid}-${pack}`,
          permalink: `${base}/product/${enc(slug)}/?attribute_pa_pack=${pack}`,
          regular_price: regular, sale_price: '', price: regular,
          stock_status: 'instock', manage_stock: true, stock_quantity: Math.floor(rnd() * 80),
          date_modified_gmt: modified.slice(0, 19),
          attributes: [{ id: 1, name: 'تعداد در بسته', slug: 'pa_pack', option: `${pack} عددی` }]
        };
      });
      products.push({
        id: pid, name, slug, type: 'variable', status: 'publish', sku: `P${pid}`,
        permalink: `${base}/product/${enc(slug)}/`, regular_price: '', sale_price: '', price: variations[0].price,
        stock_status: 'instock', manage_stock: false, stock_quantity: null, date_modified_gmt: modified.slice(0, 19),
        attributes: [{ id: 1, name: 'تعداد در بسته', options: ['25 عددی', '100 عددی'], variation: true }],
        variations: variations.map((v) => v.id), _variations: variations
      });
    } else {
      const pack = pick(PACKS);
      const regular = String(Math.round(unitPrice * pack / 100) * 100);
      const onSale = rnd() < 0.15;
      products.push({
        id: pid, name: `${name} بسته ${pack} عددی`, slug, type: 'simple', status: rnd() < 0.03 ? 'draft' : 'publish', sku: `P${pid}`,
        permalink: `${base}/product/${enc(slug)}/`, regular_price: regular,
        sale_price: onSale ? String(Math.round(Number(regular) * 0.9 / 100) * 100) : '', price: regular,
        stock_status: rnd() < 0.1 ? 'outofstock' : 'instock', manage_stock: true, stock_quantity: Math.floor(rnd() * 200),
        date_modified_gmt: modified.slice(0, 19), attributes: [], variations: []
      });
    }
  }
  return products;
}

/* ------------------------------------------------------------ the shop */
function createMockWoo({
  name = 'فروشگاه نمونه', count = 50, seed = 1, key = 'ck_mock_key_0000000001', secret = 'cs_mock_secret_000000001',
  currency = 'IRT', pretty = true, acceptHeaderAuth = true, variableRatio = 0.3
} = {}) {
  let base = 'http://127.0.0.1';
  let products = [];
  const stats = { requests: 0 };
  let push = null; // { url, secret }
  let failNext = 0;
  let listsNothing = false; // a broken site (cache, plugin conflict) that answers 200 with an empty list

  const all = () => {
    const out = [];
    for (const p of products) { out.push(p); if (p._variations) out.push(...p._variations); }
    return out;
  };
  const find = (id) => all().find((p) => p.id === Number(id));
  const parentOf = (v) => products.find((p) => p.id === v.parent_id);
  const strip = (p, fields) => {
    const o = {};
    for (const [k, v] of Object.entries(p)) if (!k.startsWith('_') && (!fields || fields.includes(k))) o[k] = v;
    return o;
  };
  const stamp = () => new Date().toISOString().slice(0, 19);

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', ...headers });
    res.end(JSON.stringify(body));
  }
  function authorised(req, q) {
    if (acceptHeaderAuth) {
      const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
      if (m) {
        const [k, s] = Buffer.from(m[1], 'base64').toString().split(':');
        return k === key && s === secret;
      }
    }
    return q.get('consumer_key') === key && q.get('consumer_secret') === secret;
  }

  async function notify(items, deleted = []) {
    if (!push) return;
    const body = JSON.stringify({
      items: items.map((p) => {
        const o = strip(p);
        if (p.parent_id) { const parent = parentOf(p); o.parent = { id: parent.id, name: parent.name, slug: parent.slug, permalink: parent.permalink }; }
        return o;
      }),
      deleted
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', push.secret).update(`${ts}.${body}`).digest('hex');
    try {
      await fetch(push.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Anbar-Timestamp': String(ts), 'X-Anbar-Signature': 'sha256=' + sig }, body });
    } catch { /* the plugin also ignores failures; the next sync catches up */ }
  }

  const server = http.createServer((req, res) => {
    stats.requests++;
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    // Test/demo control: change a price from outside (e2e tests)
    if (url.pathname === '/__mock/price' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const { id, regular } = JSON.parse(body || '{}');
        const p = find(id);
        if (!p) return send(res, 404, { error: 'no such product' });
        await shop.setPrice(id, regular);
        send(res, 200, { ok: true });
      });
      return;
    }
    let route = null;
    if (url.pathname.startsWith('/wp-json/wc/v3') && pretty) route = url.pathname.slice('/wp-json/wc/v3'.length);
    else if (url.pathname === '/' && q.get('rest_route') && q.get('rest_route').startsWith('/wc/v3')) route = q.get('rest_route').slice('/wc/v3'.length);
    if (route === null) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Not found</body></html>');
    }
    if (failNext > 0) { failNext--; return send(res, 500, { code: 'internal_server_error', message: 'Simulated failure' }); }
    if (!authorised(req, q)) return send(res, 401, { code: 'woocommerce_rest_authentication_error', message: 'Invalid signature', data: { status: 401 } });
    const fields = q.get('_fields') ? q.get('_fields').split(',') : null;
    const page = Math.max(1, Number(q.get('page') || 1));
    const per = Math.min(100, Math.max(1, Number(q.get('per_page') || 10)));
    const paged = (list) => {
      const total = list.length;
      return send(res, 200, list.slice((page - 1) * per, page * per).map((p) => strip(p, fields)),
        { 'X-WP-Total': String(total), 'X-WP-TotalPages': String(Math.max(1, Math.ceil(total / per))) });
    };
    let m;
    if (route === '/settings/general/woocommerce_currency') return send(res, 200, { id: 'woocommerce_currency', value: currency });
    if (route === '/products') {
      let list = (listsNothing ? [] : products).slice().sort((a, b) => a.id - b.id);
      if (q.get('slug')) list = list.filter((p) => p.slug === q.get('slug'));
      if (q.get('include')) { const ids = q.get('include').split(',').map(Number); list = list.filter((p) => ids.includes(p.id)); }
      if (q.get('modified_after')) {
        const after = new Date(q.get('modified_after') + (q.get('modified_after').endsWith('Z') ? '' : 'Z')).getTime();
        list = list.filter((p) => new Date(p.date_modified_gmt + 'Z').getTime() > after);
      }
      return paged(list);
    }
    if ((m = /^\/products\/(\d+)$/.exec(route))) {
      const p = products.find((x) => x.id === Number(m[1]));
      return p ? send(res, 200, strip(p, fields)) : send(res, 404, { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' });
    }
    if ((m = /^\/products\/(\d+)\/variations$/.exec(route))) {
      const p = products.find((x) => x.id === Number(m[1]));
      return p ? paged(p._variations || []) : send(res, 404, { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' });
    }
    if ((m = /^\/products\/(\d+)\/variations\/(\d+)$/.exec(route))) {
      const p = products.find((x) => x.id === Number(m[1]));
      const v = p && (p._variations || []).find((x) => x.id === Number(m[2]));
      return v ? send(res, 200, strip(v, fields)) : send(res, 404, { code: 'woocommerce_rest_product_invalid_id', message: 'Invalid ID.' });
    }
    return send(res, 404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
  });

  const shop = {
    name, key, secret, stats,
    get url() { return base; },
    get products() { return products; },
    all,
    find,
    async listen(port = 0) {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      products = generate({ count, seed, base, variableRatio });
      return shop;
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
    /** Change a price like an admin editing the product (updates date_modified). */
    async setPrice(id, regular, sale = '') {
      const p = find(id);
      p.regular_price = String(regular); p.sale_price = sale === '' ? '' : String(sale); p.price = p.sale_price || p.regular_price;
      p.date_modified_gmt = stamp();
      if (p.parent_id) parentOf(p).date_modified_gmt = stamp();
      await notify([p]);
      return p;
    },
    /** Stock changes from orders do not touch date_modified in WooCommerce. */
    async setStock(id, qty) {
      const p = find(id);
      p.stock_quantity = qty; p.stock_status = qty > 0 ? 'instock' : 'outofstock';
      await notify([p]);
      return p;
    },
    async rename(id, newName) { const p = find(id); p.name = newName; p.date_modified_gmt = stamp(); await notify([p]); return p; },
    async remove(id) { products = products.filter((p) => p.id !== Number(id)); await notify([], [Number(id)]); },
    /** Random price changes (demo): returns the changed items. */
    async randomChanges(n = 3, rnd = Math.random) {
      const sellable = all().filter((p) => p.type !== 'variable');
      const changed = [];
      for (let i = 0; i < n; i++) {
        const p = sellable[Math.floor(rnd() * sellable.length)];
        const factor = 1 + (rnd() < 0.7 ? 1 : -1) * (0.03 + rnd() * 0.12);
        const regular = Math.max(1000, Math.round(Number(p.regular_price) * factor / 100) * 100);
        await shop.setPrice(p.id, regular);
        changed.push(p);
      }
      return changed;
    },
    pushTo(target) { push = target; },
    failRequests(n) { failNext = n; },
    listNothing(on = true) { listsNothing = on; }
  };
  return shop;
}

module.exports = { createMockWoo, generate };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  createMockWoo({ name: arg('name', 'فروشگاه نمونه'), count: Number(arg('products', 300)), seed: Number(arg('seed', 1)) })
    .listen(Number(arg('port', 8091)))
    .then((s) => console.log(`Mock WooCommerce "${s.name}" at ${s.url}  key=${s.key}  secret=${s.secret}  (${s.all().length} items)`));
}
