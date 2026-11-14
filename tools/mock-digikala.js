'use strict';
/**
 * A fake Digikala seller Open API for tests and the demo (same paths and shapes as the Swagger
 * spec, only what Anbar uses). Rules like the real one:
 *  - auth/token accepts only the authorization code the fake "self-token page" encrypted;
 *  - access tokens expire (refreshTokens rotate);
 *  - a selling price more than `band` (default 20 %) away from the variant's reference price
 *    (price_list) is refused with errors.selling_price;
 *  - optional rate limit (429 with reset_time);
 *  - access tokens are JWT-shaped with the seller's `seller_id` (as the real ones);
 *  - optional `userAgent`: authenticated calls with any other User-Agent get 401 "Invalid User-Agent!"
 *    (`'trusted'` = the real rule, DigikalaTrustedBot/SelfToken/<seller id>).
 *
 *   const dk = await createMockDigikala({ publicKey }).listen(0);
 *   dk.challenge()  → base64 code to paste in the settings page;  dk.variants, dk.tickets, dk.calls
 */
const http = require('http');
const crypto = require('crypto');

function createMockDigikala({ publicKey = null, band = 0.2, accessTtlMs = 3600e3, userAgent = null, sellerId = 4242 } = {}) {
  const variants = new Map();
  const tickets = [];
  const calls = [];
  const codes = new Set();
  const access = new Map(); // token → expiresAt
  const refresh = new Set();
  let failNext = [];
  let server;
  let base = '';

  const issue = () => {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const a = `${part({ typ: 'JWT', alg: 'HS256' })}.${part({ token_id: access.size + 1, seller_id: sellerId, client_code: 'mock', exp: Math.floor((Date.now() + accessTtlMs) / 1000) })}.${crypto.randomBytes(24).toString('base64url')}`;
    const r = crypto.randomBytes(24).toString('base64url');
    access.set(a, Date.now() + accessTtlMs);
    refresh.add(r);
    return { access_token: a, refresh_token: r, access_token_expires_at: { date: new Date(Date.now() + accessTtlMs).toISOString().replace('Z', '000Z'), timezone: 'UTC' } };
  };
  const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  const ok = (res, data) => send(res, 200, { status: 'ok', data });
  const err = (res, status, message, errors) => send(res, status, { status: 'error', code: status, message, errors });

  function handle(req, res, body) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/open-api\/v1/, '');
    calls.push({ method: req.method, path, body, userAgent: req.headers['user-agent'] || null });
    if (failNext.length) {
      const f = failNext.shift();
      if (f === 429) return send(res, 429, { status: 'error', message: 'rate limit', reset_time: 1 }, { 'retry-after': '0' });
      return err(res, f, 'Server Issue');
    }
    if (req.method === 'POST' && path === '/auth/token') {
      if (!codes.has(body.authorization_code)) return err(res, 400, 'Validation failed', { authorization_code: ['کد نامعتبر است'] });
      codes.delete(body.authorization_code);
      return ok(res, issue());
    }
    if (req.method === 'POST' && path === '/auth/refresh-token') {
      if (!refresh.has(body.refresh_token)) return err(res, 401, 'invalid refresh token');
      refresh.delete(body.refresh_token);
      access.delete(body.access_token);
      return ok(res, issue());
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const exp = access.get(token);
    if (!exp || exp < Date.now()) return err(res, 401, 'Your access is denied. Please get a new access_token.!');
    const wanted = api.userAgent === 'trusted' ? `DigikalaTrustedBot/SelfToken/${sellerId}` : api.userAgent;
    if (wanted && req.headers['user-agent'] !== wanted) return err(res, 401, 'Invalid User-Agent!');

    let m;
    if (req.method === 'GET' && path === '/variants') {
      const size = Math.min(100, Number(url.searchParams.get('size')) || 50);
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const all = [...variants.values()].sort((a, b) => a.id - b.id);
      return ok(res, { sort_data: {}, pager: { page, item_per_page: size, total_pages: Math.max(1, Math.ceil(all.length / size)), total_rows: all.length },
        form_data: [], items: all.slice((page - 1) * size, page * size).map((v) => ({ ...v, product_variant_id: v.id })) });
    }
    if (req.method === 'GET' && (m = /^\/variants\/(\d+)$/.exec(path))) {
      const v = variants.get(Number(m[1]));
      return v ? ok(res, { ...v }) : err(res, 404, 'Data is not exist for your request.');
    }
    if (req.method === 'PATCH' && path === '/variants/selling-price') {
      const v = variants.get(Number(body.variant_id));
      if (!v) return err(res, 400, 'Validation failed', { variant_id: ['تنوع پیدا نشد'] });
      if (body.credit_increase_percentage === undefined) return err(res, 400, 'Validation failed', { credit_increase_percentage: ['این قسمت نباید خالی باشد'] });
      const lo = Math.round(v.price_list * (1 - band)), hi = Math.round(v.price_list * (1 + band));
      if (body.selling_price < lo || body.selling_price > hi) {
        return err(res, 400, 'Validation failed', { selling_price: [`قیمت باید بین ${lo} و ${hi} ریال باشد (قیمت مرجع)`] });
      }
      v.price_sale = body.selling_price;
      v.credit_increase_percentage = body.credit_increase_percentage;
      return ok(res, { variant_id: v.id, selling_price: v.price_sale, credit_increase_percentage: v.credit_increase_percentage });
    }
    if (req.method === 'PUT' && (m = /^\/variants\/(\d+)\/activation$/.exec(path))) {
      const v = variants.get(Number(m[1]));
      if (!v) return err(res, 404, 'not found');
      v.active = !!body.activation;
      return ok(res, { id: v.id, active: v.active });
    }
    if (req.method === 'PATCH' && (m = /^\/variants\/(\d+)\/seller-stock$/.exec(path))) {
      const v = variants.get(Number(m[1]));
      if (!v) return err(res, 404, 'not found');
      v.marketplace_seller_stock = Number(body.seller_stock);
      return ok(res, { selling_stock: v.marketplace_seller_stock, marketplace_seller_stock: v.marketplace_seller_stock });
    }
    if (req.method === 'GET' && /^\/tickets\/sub-categories\/\d+\/fields$/.test(path)) {
      return ok(res, { items: [{ type: 'string', name: 'ticketing_input_1' }, { type: 'dynamic_modal', name: 'ticketing_input_1214' }] });
    }
    if (req.method === 'POST' && path === '/tickets/requests') {
      const t = { id: 9000 + tickets.length, ...body };
      tickets.push(t);
      return ok(res, { id: t.id });
    }
    return err(res, 404, 'Data is not exist for your request.');
  }

  const api = {
    variants, tickets, calls, userAgent,
    get url() { return base; },
    /** Adds a seller variant (prices in rials). */
    addVariant(v) {
      const full = { id: v.id, product_id: v.product_id || v.id + 100000, title: v.title || (v.product_title ? '' : `تنوع ${v.id}`), product_title: v.product_title || '', supplier_code: v.supplier_code || '',
        active: true, price_list: v.price_list, price_sale: v.price_sale ?? v.price_list,
        credit_increase_percentage: v.credit_increase_percentage ?? 0, marketplace_seller_stock: v.marketplace_seller_stock ?? 10, product_url: `https://www.digikala.com/product/dkp-${v.product_id || v.id}/` };
      variants.set(v.id, full);
      return full;
    },
    /** What the seller panel's self-token page shows: an authorization code encrypted with the seller's public key. */
    challenge() {
      const code = crypto.randomBytes(18).toString('base64url');
      codes.add(code);
      return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(code)).toString('base64');
    },
    expireTokens() { for (const k of access.keys()) access.set(k, 0); },
    failRequests(...statuses) { failNext = statuses; },
    async listen(port = 0) {
      server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* */ } handle(req, res, body); });
      });
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
      return api;
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); })
  };
  return api;
}

module.exports = { createMockDigikala };
