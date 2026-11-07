'use strict';
/**
 * WooCommerce REST API (v3) client for one company site, read-only.
 *
 *  - Auth: Basic header by default; some hosts strip the Authorization header,
 *    so the consumer key/secret can also travel in the query string (HTTPS only
 *    in production, which WooCommerce accepts).
 *  - Address style: /wp-json/wc/v3/… or ?rest_route=/wc/v3/… for sites
 *    without "pretty" permalinks. detect() finds the combination that works.
 *  - Only the fields we need are requested (_fields) to keep 1000+ products fast.
 *
 * Errors carry a Persian `message` an admin can act on and a `code`.
 */

const PRODUCT_FIELDS = [
  'id', 'name', 'slug', 'type', 'status', 'permalink', 'sku', 'regular_price', 'sale_price', 'price',
  'stock_status', 'stock_quantity', 'manage_stock', 'date_modified_gmt', 'parent_id', 'variations', 'attributes'
].join(',');
const VARIATION_FIELDS = [
  'id', 'name', 'status', 'permalink', 'sku', 'regular_price', 'sale_price', 'price',
  'stock_status', 'stock_quantity', 'manage_stock', 'date_modified_gmt', 'attributes'
].join(',');

class WooError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'WooError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/** Failures worth another try: the site was slow or overloaded, or the network dropped. */
const RETRYABLE = new Set(['timeout', 'network', 'dns']);
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createWooClient({ siteUrl, key, secret, apiStyle = 'wp-json', authMode = 'header', timeoutMs = 20000, fetchImpl, retries = 2, metrics, retryBaseMs = 500 }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let requests = 0;
  let retried = 0;

  function buildUrl(route, params = {}) {
    const q = new URLSearchParams();
    let url;
    if (apiStyle === 'rest_route') {
      url = `${siteUrl}/`;
      q.set('rest_route', `/wc/v3${route}`);
    } else {
      url = `${siteUrl}/wp-json/wc/v3${route}`;
    }
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    if (authMode === 'query') { q.set('consumer_key', key); q.set('consumer_secret', secret); }
    return `${url}?${q.toString()}`;
  }

  /**
   * One API call, retried with exponential back-off and jitter on time-outs, dropped
   * connections and 429/5xx answers (honouring Retry-After, at most 30 s). Wrong keys,
   * missing products and HTML pages are not retried: another try would not help.
   */
  async function request(route, params) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await once(route, params);
        if (metrics) metrics.inc('anbar_woo_requests_total', { outcome: 'ok' });
        return res;
      } catch (err) {
        const retryable = err instanceof WooError && (RETRYABLE.has(err.code) || (err.status && RETRY_STATUS.has(err.status)));
        if (metrics) metrics.inc('anbar_woo_requests_total', { outcome: retryable && attempt < retries ? 'retry' : err.code || 'error' });
        if (!retryable || attempt >= retries) throw err;
        retried++;
        const wait = err.retryAfter ? Math.min(30000, err.retryAfter * 1000) : retryBaseMs * 2 ** attempt + Math.floor(Math.random() * retryBaseMs);
        await sleep(wait);
      }
    }
  }

  async function once(route, params) {
    const url = buildUrl(route, params);
    const headers = { Accept: 'application/json', 'User-Agent': 'Anbar/1.0 (+warehouse sync)' };
    if (authMode === 'header') headers.Authorization = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    requests++;
    let res;
    try {
      res = await doFetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    } catch (err) {
      if (err.name === 'AbortError') throw new WooError('timeout', `سایت در ${Math.round(timeoutMs / 1000)} ثانیه جواب نداد.`);
      const cause = err.cause && (err.cause.code || err.cause.message);
      if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') throw new WooError('dns', 'نشانی سایت پیدا نشد؛ آدرس را بررسی کنید.');
      if (/certificate|SSL|TLS/i.test(String(cause))) throw new WooError('tls', 'گواهی امنیتی (SSL) سایت معتبر نیست.');
      throw new WooError('network', 'اتصال به سایت برقرار نشد' + (cause ? ` (${cause})` : '') + '.');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = undefined; }
    if (data === undefined) {
      // HTML instead of JSON: a firewall page, a maintenance page or REST turned off
      throw new WooError('not_json', res.status === 404
        ? 'آدرس API ووکامرس در این سایت پیدا نشد.'
        : `سایت به‌جای جواب API یک صفحه‌ی وب برگرداند (کد ${res.status}). ممکن است فایروال یا افزونه‌ی امنیتی جلوی API را گرفته باشد.`,
      { status: res.status });
    }
    if (!res.ok) {
      const wcCode = data && data.code;
      if (res.status === 401 || res.status === 403) {
        throw new WooError('auth', wcCode === 'woocommerce_rest_cannot_view'
          ? 'کلید API دسترسی خواندن ندارد؛ در ووکامرس کلید با دسترسی «خواندن» بسازید.'
          : 'کلید یا رمز API ووکامرس درست نیست.', { status: res.status, wcCode });
      }
      if (res.status === 404) {
        throw new WooError(wcCode === 'rest_no_route' ? 'no_route' : 'not_found',
          wcCode === 'rest_no_route' ? 'ووکامرس روی این سایت فعال نیست یا API آن در دسترس نیست.' : 'این مورد در سایت پیدا نشد.',
          { status: 404, wcCode });
      }
      const retryAfter = Number(res.headers.get('retry-after')) || undefined;
      throw new WooError('http', `سایت خطای ${res.status} برگرداند${data && data.message ? `: ${data.message}` : ''}.`, { status: res.status, wcCode, retryAfter });
    }
    return { data, totalPages: Number(res.headers.get('x-wp-totalpages') || 1), total: Number(res.headers.get('x-wp-total') || 0) };
  }

  return {
    get requests() { return requests; },
    get retried() { return retried; },
    request,
    /** Store currency as WooCommerce reports it (IRT = toman, IRR = rial, …). */
    async storeCurrency() {
      try {
        const { data } = await request('/settings/general/woocommerce_currency');
        return data && data.value ? String(data.value) : null;
      } catch (err) {
        if (err.code === 'auth' || err.code === 'not_found' || err.code === 'http') return null; // read keys may not see settings
        throw err;
      }
    },
    /** One page of products (all statuses). modifiedAfter: ISO time (UTC). */
    async products({ page = 1, perPage = 100, modifiedAfter, include, slug } = {}) {
      return request('/products', {
        page, per_page: perPage, orderby: 'id', order: 'asc', status: 'any', _fields: PRODUCT_FIELDS,
        modified_after: modifiedAfter, dates_are_gmt: modifiedAfter ? 'true' : undefined,
        include: include && include.length ? include.join(',') : undefined, slug
      });
    },
    async product(id) { return (await request(`/products/${id}`, { _fields: PRODUCT_FIELDS })).data; },
    async variations(parentId, { page = 1, perPage = 100 } = {}) {
      return request(`/products/${parentId}/variations`, { page, per_page: perPage, orderby: 'id', order: 'asc', _fields: VARIATION_FIELDS });
    },
    async variation(parentId, id) { return (await request(`/products/${parentId}/variations/${id}`, { _fields: VARIATION_FIELDS })).data; }
  };
}

/**
 * Tries the address styles and auth modes until one works; returns the
 * working settings plus what the site reports (currency, product count).
 */
async function detect({ siteUrl, key, secret, timeoutMs, fetchImpl }) {
  const attempts = [
    { apiStyle: 'wp-json', authMode: 'header' },
    { apiStyle: 'wp-json', authMode: 'query' },
    { apiStyle: 'rest_route', authMode: 'header' },
    { apiStyle: 'rest_route', authMode: 'query' }
  ];
  let firstError = null;
  for (const a of attempts) {
    const client = createWooClient({ siteUrl, key, secret, timeoutMs, fetchImpl, retries: 0, ...a });
    try {
      const page = await client.products({ perPage: 1 });
      const siteCurrency = await client.storeCurrency();
      return { ok: true, ...a, productCount: page.total, siteCurrency };
    } catch (err) {
      if (!(err instanceof WooError)) throw err;
      // Unreachable sites will not get better with another style
      if (['dns', 'network', 'timeout', 'tls'].includes(err.code)) throw err;
      // Prefer the most telling error: a wrong key beats "not found"
      if (!firstError || (err.code === 'auth' && firstError.code !== 'auth')) firstError = err;
    }
  }
  throw firstError;
}

/** Store currency code → the unit its prices are written in (see PRICE_UNITS), or null when unknown. */
function unitFromSite(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'IRT' || c === 'TOMAN') return 'toman';
  if (c === 'IRR' || c === 'RIAL') return 'rial';
  if (c === 'IRHT') return 'thousand_toman';
  if (c === 'IRHR') return 'thousand_rial';
  return null;
}

module.exports = { createWooClient, detect, unitFromSite, WooError };
