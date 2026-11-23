'use strict';

const { dayStart, tehranDay } = require('./jalali');
const { badRequest, conflict, searchKey } = require('./util');

const DAY = 86_400_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
const HISTORY_CACHE_MS = 12 * 60_000;
const ORDER_SECTIONS = ['active', 'processed', 'returned', 'canceled'];
const iso = (value) => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const number = (value) => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const idOf = (value) => {
  const id = number(value);
  return id ? String(id) : null;
};
const label = (value) => typeof value === 'string' ? value : value?.title || value?.key || null;
const inRange = (value, { from, to }) => value && value >= from && value < to;

function reportRange(from, to, now = new Date()) {
  const start = dayStart(tehranDay(now.toISOString()).date);
  const end = new Date(Date.parse(start) + DAY).toISOString();
  if (!from && !to) return { from: start, to: end };
  const range = { from: iso(from), to: iso(to) };
  if (!range.from || !range.to || range.from >= range.to || Date.parse(range.to) - Date.parse(range.from) > 31 * DAY) {
    throw badRequest('بازهٔ گزارش باید معتبر و حداکثر ۳۱ روز باشد.');
  }
  return range;
}

function pageOf(result, page) {
  if (!Array.isArray(result?.items)) throw new Error('Invalid Digikala list');
  const total = number(result.pager?.total_pages);
  const per = number(result.pager?.item_per_page) || PAGE_SIZE;
  const complete = total !== null ? page >= total : result.items.length < per;
  if (!complete && !result.items.length) throw new Error('Incomplete Digikala pagination');
  return { items: result.items, total, complete };
}

async function paged(fetchPage) {
  const items = [];
  const signal = AbortSignal.timeout(25_000);
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = pageOf(await fetchPage(page, signal), page);
    items.push(...result.items);
    if (result.complete) return items;
  }
  throw new Error('Digikala pagination limit reached');
}

function orderLine(raw, kind) {
  return {
    order_id: idOf(raw.order_id),
    variant_id: idOf(raw.product_variant_id),
    ordered_at: iso(raw.order_created_at),
    commitment_date: iso(raw.commitment_date),
    shipment_id: idOf(raw.shipment_id),
    title: raw.product_variant_title || null,
    code: raw.supplier_code ?? raw.product_supplier_code ?? null,
    status: label(raw.order_status),
    qty: number(raw.quantity) || null,
    unit_price: number(kind === 'active' ? raw.selling_price : raw.unit_price),
    total_price: number(raw.total_price)
  };
}

function uniqueOrderLines(rawItems, kind, window) {
  const found = new Map();
  let undated = 0;
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid Digikala order item');
    const row = orderLine(raw, kind);
    if (!row.order_id || !row.variant_id || !row.ordered_at) { undated++; continue; }
    if (!inRange(row.ordered_at, window)) continue;
    const serials = Object.values(raw.serials || {}).map(s => s?.serial).filter(Boolean).sort();
    // Shipment or serial identity distinguishes split lines for the same variant.
    const key = JSON.stringify([row.order_id, row.variant_id, row.shipment_id,
      raw.id ?? raw.order_item_id ?? null, serials, row.qty, row.unit_price, row.total_price]);
    if (!found.has(key)) found.set(key, row);
  }
  return { rows: [...found.values()], invalid: undated };
}

function errorFor(err) {
  if (err.status === 403) return 'دسترسی این بخش در اتصال دیجیکالا فعال نیست.';
  if (err.status === 401 || err.code === 'no_token') return 'اتصال دیجیکالا نیاز به ورود دوباره دارد.';
  if (err.status === 429) return 'سقف درخواست‌های دیجیکالا پر شده است. کمی بعد دوباره تلاش کنید.';
  if (err.code === 'timeout' || err.name === 'TimeoutError' || err.name === 'AbortError') return 'دیجیکالا در زمان مقرر پاسخ کامل نداد. دوباره تلاش کنید.';
  if (err.status === 404) return 'دیجیکالا جزئیات این مورد را در API پیدا نکرد.';
  if (err.status === 400) return 'دیجیکالا درخواست خواندن این بخش را نپذیرفت.';
  return 'پاسخ کامل از دیجیکالا دریافت نشد. دوباره تلاش کنید.';
}

function salesSummary({ active, processed }) {
  if (active.error || processed.error || (processed.progress && !processed.progress.complete)) return null;
  const key = row => `${row.order_id}:${row.variant_id}`;
  const activeKeys = new Set(active.rows.map(key));
  const contested = new Set(processed.rows.map(key).filter(id => activeKeys.has(id)));
  const all = [...active.rows, ...processed.rows];
  // The active endpoint has no shipment identity. An overlap may be a split or a
  // transition between endpoints, so neither side can be added to the combined sum.
  const priced = all.filter(row => row.total_price !== null && !contested.has(key(row)));
  const omitted = all.length - priced.length + active.invalid + processed.invalid + active.excluded_unmatched + processed.excluded_unmatched;
  return { orders: new Set(all.map(row => row.order_id)).size,
    total: priced.length || !omitted ? priced.reduce((sum, row) => sum + row.total_price, 0) : null,
    overlaps: contested.size, omitted };
}

function createOrderReport({ db, client, connection, variantIdOf, log }) {
  const cache = new Map();
  let historyScans = 0;

  function read(key, fetch, lifetime) {
    const c = connection();
    if (!c.access_token_enc) throw conflict('ابتدا اتصال حساب فروشندگی دیجیکالا را برقرار کنید.');
    if (process.env.NODE_ENV === 'production' && !/^https:\/\/seller\.digikala\.com\/?$/i.test(c.base_url)) {
      throw conflict('برای نمایش سفارش واقعی، آدرس اتصال باید پنل رسمی فروشندگان دیجیکالا باشد.');
    }
    const now = Date.now();
    const cacheKey = JSON.stringify([c.base_url, c.client_code, c.connected_at, key]);
    for (const [k, entry] of cache) if (entry.expires <= now) cache.delete(k);
    const existing = cache.get(cacheKey);
    if (existing && !(existing.result?.progress?.retry_at <= now)) return existing.promise;
    if (existing) cache.delete(cacheKey);
    const entry = { expires: Infinity };
    entry.promise = fetch(client()).then(result => {
      entry.result = result;
      entry.expires = Date.now() + lifetime;
      return result;
    }, error => {
      entry.expires = Date.now() + 30_000;
      throw error;
    });
    if (cache.size < 48) cache.set(cacheKey, entry);
    return entry.promise;
  }

  async function section(key, fetch, lifetime = 30_000) {
    try { return await read(key, fetch, lifetime); }
    catch (err) {
      if (err.statusCode === 409) return { error: err.message };
      log?.warn({ source: key[0], upstreamStatus: err.status, upstreamCode: err.code,
        validationFields: Object.keys(err.errors || {}) }, 'Could not read Digikala order report');
      return { error: errorFor(err) };
    }
  }

  async function history(api, kind, window) {
    if (historyScans >= 3) throw conflict('چند بخش تاریخچه در حال خواندن است. کمی بعد دوباره تلاش کنید.');
    historyScans++;
    const request = (page, signal) => api.orders({ page, size: PAGE_SIZE, signal,
      type: kind, from: window.from, to: window.to });
    let state;
    try {
      const first = pageOf(await request(1, AbortSignal.timeout(25_000)), 1);
      state = { raw: first.items.slice(), fetched_at: new Date().toISOString(),
        progress: { pages: 1, total: first.total, complete: first.complete, error: null } };
    } catch (error) {
      historyScans--;
      throw error;
    }
    if (state.progress.complete) {
      historyScans--;
      return state;
    }
    void (async () => {
      const signal = AbortSignal.timeout(10 * 60_000);
      try {
        for (let page = 2; page <= MAX_PAGES; page++) {
          const next = pageOf(await request(page, signal), page);
          state.raw.push(...next.items);
          state.fetched_at = new Date().toISOString();
          state.progress = { pages: page, total: next.total, complete: next.complete, error: null };
          if (next.complete) return;
        }
        throw new Error('Digikala history pagination limit reached');
      } catch (error) {
        state.progress.error = errorFor(error);
        state.progress.retry_at = Date.now() + 30_000;
        log?.warn({ source: kind, pages: state.progress.pages, upstreamStatus: error.status,
          upstreamCode: error.code }, 'Digikala history scan stopped');
      } finally {
        historyScans--;
      }
    })();
    return state;
  }

  function listings() {
    const found = new Map();
    const rows = db.all(`SELECT l.code, p.id AS product_id, c.id AS company_id, c.name AS company_name
                         FROM listings l JOIN platforms pl ON pl.id=l.platform_id
                         JOIN products p ON p.id=l.product_id JOIN companies c ON c.id=p.company_id
                         WHERE pl.code='digikala' AND l.code IS NOT NULL`);
    for (const row of rows) {
      const id = variantIdOf(row.code);
      if (!id) continue;
      const key = String(id);
      if (!found.has(key)) found.set(key, row);
      else if (found.get(key)?.product_id !== row.product_id) found.set(key, null);
    }
    return found;
  }

  async function orders({ from, to, company, q, section: requested }) {
    const window = reportRange(from, to);
    const kinds = requested === 'sales' ? ['active', 'processed'] : requested ? [requested] : ORDER_SECTIONS;
    const responses = await Promise.all(kinds.map(kind => {
      const key = [kind, window.from, window.to];
      if (kind !== 'active') return section(key, api => history(api, kind, window), HISTORY_CACHE_MS);
      // The vendor's created_today filter omitted confirmed active orders in production.
      return section(key, async api => ({
        raw: await paged((page, signal) => api.orders({ page, size: PAGE_SIZE, signal })),
        fetched_at: new Date().toISOString()
      }));
    }));
    const mapped = listings();
    const local = new Map(db.all(`SELECT id, order_number FROM orders WHERE source='digikala'
      AND ordered_at>=? AND ordered_at<?`, window.from, window.to).map(row => [row.order_number, row.id]));
    const term = searchKey(q || '');
    const sections = Object.fromEntries(kinds.map((kind, i) => {
      const response = responses[i];
      if (response.error) return [kind, response];
      const { rows: remoteRows, invalid } = uniqueOrderLines(response.raw, kind, window);
      const progress = response.progress ? { ...response.progress } : null;
      const matching = remoteRows.filter(row => !term || searchKey(`${row.order_id} ${row.variant_id} ${row.shipment_id || ''} ${row.code || ''} ${row.title || ''}`).includes(term));
      const rows = matching.flatMap(row => {
        const match = mapped.get(row.variant_id);
        if (company && match?.company_id !== company) return [];
        return [{ ...row, company_name: match?.company_name ?? null, local_order_id: local.get(row.order_id) ?? null }];
      }).sort((a, b) => b.ordered_at.localeCompare(a.ordered_at));
      const known = rows.filter(row => row.total_price !== null);
      const unmatched = matching.filter(row => !mapped.get(row.variant_id)).length;
      const excluded = company ? unmatched : 0;
      return [kind, { rows, fetched_at: response.fetched_at, invalid, progress,
        unmatched, excluded_unmatched: excluded,
        summary: { orders: new Set(rows.map(row => row.order_id)).size,
          shipments: new Set(rows.map(row => row.shipment_id).filter(Boolean)).size,
          rows: rows.length, missing_prices: rows.length - known.length,
          total: known.length || !(rows.length || excluded || invalid || (progress && !progress.complete))
            ? known.reduce((sum, row) => sum + row.total_price, 0) : null } }];
    }));
    return { window, sections, sales: sections.active && sections.processed ? salesSummary(sections) : null };
  }

  async function packages({ from, to }) {
    const window = reportRange(from, to);
    return section(['packages', window.from, window.to], async api => {
      const raw = await paged((page, signal) => api.packages({ page, size: PAGE_SIZE, from: window.from, to: window.to, signal }));
      const items = raw.map(r => ({ id: idOf(r.package_id), number: r.package_number, status: label(r.status),
        created_at: iso(r.created_at), due_at: iso(r.received_at_forecast), received_at: iso(r.effective_received_date || r.received_at),
        warehouse: r.warehouse?.title, delivery: label(r.delivery_type) }));
      const filtered = items.filter(r => r.id && inRange(r.created_at, window));
      return { items: [...new Map(filtered.map(row => [row.id, row])).values()], fetched_at: new Date().toISOString() };
    });
  }

  async function packageDetails(id) {
    return section(['package', id], async api => {
      const raw = await paged((page, signal) => api.packageDetails({ id, page, signal }));
      const mapped = listings();
      const items = raw.flatMap(({ package_products: p }) => Array.isArray(p) ? p : p ? [p] : []).map(r => ({
        id: idOf(r.package_item_id), title: r.title, variant_id: idOf(r.dkpc), expected: number(r.ordered_count),
        delivered: number(r.delivered_count), company: mapped.get(idOf(r.dkpc))?.company_name ?? null
      }));
      const seen = new Set();
      return { items: items.filter(row => {
        if (!row.id) return true;
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      }) };
    });
  }

  return { orders, packages, packageDetails };
}

module.exports = { createOrderReport };
