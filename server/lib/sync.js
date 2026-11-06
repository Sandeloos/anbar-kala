'use strict';
/**
 * Keeps our copy of every company's products in step with its WooCommerce site.
 *
 *  full         every product and variation; also notices products that disappeared
 *  incremental  only products modified since the last run (cheap, every few minutes)
 *  refresh      one product, on demand (product page, order entry)
 *  webhook      the WordPress plugin pushes changed items the moment they change
 *
 * Every price or stock change becomes a price_history row. effective_at is our
 * best estimate of when the change happened on the site: the product's own
 * "modified" time when it falls between our previous check and now, otherwise
 * the time we noticed. priceAt() answers "what was the site price at time T".
 */
const { createWooClient, detect, WooError } = require('./woo');
const { searchKey, nowIso, conflict, notFound, badRequest, normaliseSiteUrl, toRial, toLatinDigits } = require('./util');

/* ------------------------------------------------------------ helpers */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', zwnj: '‌' };
/** WooCommerce returns names with HTML entities ("A &amp; B", "&#8211;"). */
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/<[^>]*>/g, '')
    .trim();
}
function gmt(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
async function mapLimit(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) { const item = list[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

/**
 * A raw WooCommerce product/variation → the columns we keep.
 * Returns null for variable parents (their variations are the sellable items).
 */
function normalise(raw, unit, parent) {
  if (!parent && raw.type === 'variable') return null;
  const attrs = parent && Array.isArray(raw.attributes)
    ? raw.attributes.filter((a) => a && a.option).map((a) => `${decodeEntities(a.name)}: ${decodeEntities(a.option)}`).join('، ')
    : null;
  const parentName = parent ? decodeEntities(parent.name) : null;
  let name = decodeEntities(raw.name);
  if (parent) {
    const options = Array.isArray(raw.attributes) ? raw.attributes.map((a) => decodeEntities(a.option)).filter(Boolean) : [];
    // Newer WooCommerce already names variations "Parent - Option"; build it when missing
    if (!name || name === parentName) name = options.length ? `${parentName} - ${options.join('، ')}` : parentName;
  }
  const regular = toRial(raw.regular_price, unit) ?? toRial(raw.price, unit);
  const sale = toRial(raw.sale_price, unit);
  const manage = raw.manage_stock === true || raw.manage_stock === 'parent';
  let qty = intOrNull(raw.stock_quantity);
  if (qty === null && raw.manage_stock === 'parent' && parent) qty = intOrNull(parent.stock_quantity);
  return {
    woo_id: Number(raw.id),
    parent_woo_id: parent ? Number(parent.id) : null,
    type: parent ? 'variation' : String(raw.type || 'simple'),
    name: name || `#${raw.id}`,
    parent_name: parentName,
    attributes: attrs || null,
    sku: raw.sku ? String(raw.sku) : null,
    permalink: raw.permalink || (parent && parent.permalink) || null,
    slug: (parent ? parent.slug : raw.slug) || null,
    site_status: raw.status || null,
    regular_price: regular,
    sale_price: sale !== null && sale > 0 && sale !== regular ? sale : null,
    stock_status: raw.stock_status || null,
    stock_quantity: manage ? qty : null,
    manage_stock: manage ? 1 : 0,
    site_modified_at: gmt(raw.date_modified_gmt)
  };
}

/**
 * Units in one item, read from its name: "بسته ۱۰۰ عددی", "100 تایی", "۲۵عدد".
 * The match nearest the end wins ("لیوان ۲۲۰ سی‌سی بسته ۵۰ عددی" → 50). null when unsure.
 * Only a suggestion: the product stays "waiting for setup" until an admin confirms it.
 */
function guessUnits(text) {
  const s = toLatinDigits(String(text || '')).replace(/[٬,](?=\d{3})/g, '');
  const re = /(\d{1,6})\s*(?:عددی|تایی|عدد|تا\b|pcs\b|pieces\b)/gi;
  let m, last = null;
  while ((m = re.exec(s))) last = Number(m[1]);
  return last && last >= 2 && last <= 100000 ? last : null;
}

/** When did a change we just noticed happen? See the header comment. */
function effectiveTime(siteModified, lastChecked, now) {
  if (!siteModified || !lastChecked) return now;
  const t = new Date(siteModified).getTime();
  const lo = new Date(lastChecked).getTime();
  const hi = new Date(now).getTime();
  if (t > lo && t <= hi) return siteModified;
  if (t > hi && t - hi < 5 * 60e3) return now; // small clock difference between servers
  return now;
}

/* ------------------------------------------------------------ the engine */
/** Wait after the n-th failed run in a row: 2, 4, 8 … minutes, at most an hour. */
function backoffMinutes(failures) {
  return Math.min(60, 2 ** Math.max(1, failures));
}

function createSync({ db, config, secrets, events, log, fetchImpl, metrics }) {
  const running = new Map(); // companyId → run kind
  const runPromises = new Set();

  function clientFor(company) {
    if (!company.woo_key_enc || !company.woo_secret_enc) {
      throw new WooError('no_keys', 'کلید API ووکامرس برای این شرکت ثبت نشده است.');
    }
    return createWooClient({
      siteUrl: company.site_url,
      key: secrets.decrypt(company.woo_key_enc),
      secret: secrets.decrypt(company.woo_secret_enc),
      apiStyle: company.api_style,
      authMode: company.auth_mode,
      timeoutMs: config.wooTimeoutMs,
      fetchImpl,
      metrics
    });
  }

  function company(id) {
    const c = db.get('SELECT * FROM companies WHERE id = ?', id);
    if (!c) throw notFound('شرکت پیدا نشد.');
    return c;
  }

  /**
   * Writes normalised items: new products, changed prices/stock (with history)
   * and refreshed names/links. Returns counts and the ids that changed.
   *
   * fetchedAt: when the request that produced `items` was sent. A product written after that
   * (by the plugin's push, a refresh, another run) holds newer data than this snapshot, so the
   * snapshot does not overwrite it — unless the site itself marks the item as modified later.
   * Without this, a full sync that read page 3 before a price change and wrote it after the
   * plugin's push would put the old price back and record a change that never happened.
   *
   * The inbox (change listeners) is updated in the same transaction: a product change and the
   * task it causes commit together.
   */
  const changeListeners = [];
  const newerOnSite = (it, existing) => !!(it.site_modified_at && existing.site_modified_at && it.site_modified_at > existing.site_modified_at);
  function apply(comp, items, { source, now = nowIso(), userId = null, fetchedAt = null } = {}) {
    const stats = { seen: 0, created: 0, priceChanges: 0, stockChanges: 0, stale: 0, ids: [] };
    const changes = [];
    if (!items.length) return stats;
    db.tx(() => {
      for (const it of items) {
        stats.seen++;
        const search = searchKey([it.name, it.sku, it.attributes, it.woo_id].filter(Boolean).join(' '));
        const existing = db.get('SELECT * FROM products WHERE company_id = ? AND woo_id = ?', comp.id, it.woo_id);
        if (!existing) {
          const guess = guessUnits(`${it.name} ${it.attributes || ''}`);
          const info = db.run(`INSERT INTO products (company_id, woo_id, parent_woo_id, type, name, parent_name, attributes, sku, permalink, slug,
              site_status, regular_price, sale_price, stock_status, stock_quantity, manage_stock, site_modified_at, search_text,
              units_per_pack, units_guessed, last_checked_at, last_changed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          comp.id, it.woo_id, it.parent_woo_id, it.type, it.name, it.parent_name, it.attributes, it.sku, it.permalink, it.slug,
          it.site_status, it.regular_price, it.sale_price, it.stock_status, it.stock_quantity, it.manage_stock, it.site_modified_at, search,
          guess || 1, guess ? 1 : 0, now, now, now, now);
          const id = Number(info.lastInsertRowid);
          db.run(`INSERT INTO price_history (product_id, regular_price, sale_price, stock_status, stock_quantity, price_changed, stock_changed,
                    source, effective_at, observed_at, user_id) VALUES (?, ?, ?, ?, ?, 1, 1, 'import', ?, ?, ?)`,
          id, it.regular_price, it.sale_price, it.stock_status, it.stock_quantity, now, now, userId);
          stats.created++;
          stats.ids.push(id);
          continue;
        }
        if (fetchedAt && existing.last_checked_at && existing.last_checked_at > fetchedAt && !newerOnSite(it, existing)) {
          stats.stale++;
          continue;
        }
        const priceChanged = existing.regular_price !== it.regular_price || existing.sale_price !== it.sale_price;
        const stockChanged = existing.stock_status !== it.stock_status || existing.stock_quantity !== it.stock_quantity;
        if (priceChanged || stockChanged) {
          const effective = priceChanged ? effectiveTime(it.site_modified_at, existing.last_checked_at, now) : now;
          db.run(`INSERT INTO price_history (product_id, regular_price, sale_price, stock_status, stock_quantity, price_changed, stock_changed,
                    source, effective_at, observed_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          existing.id, it.regular_price, it.sale_price, it.stock_status, it.stock_quantity, priceChanged ? 1 : 0, stockChanged ? 1 : 0,
          source, effective, now, userId);
          if (priceChanged) stats.priceChanges++;
          if (stockChanged) stats.stockChanges++;
          stats.ids.push(existing.id);
          changes.push({
            productId: existing.id, companyId: comp.id, priceChanged, stockChanged,
            before: { regular_price: existing.regular_price, stock_status: existing.stock_status, stock_quantity: existing.stock_quantity },
            after: { regular_price: it.regular_price, stock_status: it.stock_status, stock_quantity: it.stock_quantity }
          });
        }
        db.run(`UPDATE products SET parent_woo_id = ?, type = ?, name = ?, parent_name = ?, attributes = ?, sku = ?, permalink = ?, slug = ?,
                  site_status = ?, regular_price = ?, sale_price = ?, stock_status = ?, stock_quantity = ?, manage_stock = ?,
                  site_modified_at = ?, search_text = ?, last_checked_at = ?, removed_at = NULL,
                  price_source = CASE WHEN ? THEN 'site' ELSE price_source END,
                  last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END,
                  updated_at = CASE WHEN ? THEN ? ELSE updated_at END
                WHERE id = ?`,
        it.parent_woo_id, it.type, it.name, it.parent_name, it.attributes, it.sku, it.permalink, it.slug,
        it.site_status, it.regular_price, it.sale_price, it.stock_status, it.stock_quantity, it.manage_stock,
        it.site_modified_at, search, now, priceChanged ? 1 : 0,
        priceChanged || stockChanged ? 1 : 0, now,
        priceChanged || stockChanged || existing.name !== it.name ? 1 : 0, now,
        existing.id);
        if (!priceChanged && !stockChanged && existing.removed_at) stats.ids.push(existing.id);
      }
      for (const fn of changeListeners) fn(changes);
      if (stats.ids.length) {
        events.emit('products', { companyId: comp.id, ids: stats.ids, created: stats.created, priceChanges: stats.priceChanges, stockChanges: stats.stockChanges, source });
      }
    });
    return stats;
  }

  function markRemoved(comp, wooIds, now) {
    let n = 0;
    const ids = [];
    db.tx(() => {
      for (const wooId of wooIds) {
        const p = db.get('SELECT id FROM products WHERE company_id = ? AND woo_id = ? AND removed_at IS NULL', comp.id, wooId);
        if (!p) continue;
        db.run('UPDATE products SET removed_at = ?, updated_at = ? WHERE id = ?', now, now, p.id);
        ids.push(p.id);
        n++;
      }
    });
    if (ids.length) events.emit('products', { companyId: comp.id, ids, removed: n });
    return n;
  }

  /* ------------------------------------------------------------ runs */
  function startRun(comp, kind, userId) {
    if (running.has(comp.id)) throw conflict('همگام‌سازی این شرکت همین حالا در حال انجام است.');
    running.set(comp.id, kind);
    const startedAt = nowIso();
    const info = db.run('INSERT INTO sync_runs (company_id, kind, status, started_at, user_id) VALUES (?, ?, ?, ?, ?)',
      comp.id, kind, 'running', startedAt, userId || null);
    const run = { id: Number(info.lastInsertRowid), kind, startedAt, requests: 0, seen: 0, created: 0, priceChanges: 0, stockChanges: 0, removed: 0 };
    events.emit('sync', { companyId: comp.id, state: 'running', kind });
    return run;
  }
  function add(run, s) {
    run.seen += s.seen; run.created += s.created; run.priceChanges += s.priceChanges; run.stockChanges += s.stockChanges;
  }
  function finishRun(comp, run, err, client) {
    const now = nowIso();
    run.requests = client ? client.requests : run.requests;
    db.run(`UPDATE sync_runs SET status = ?, finished_at = ?, requests = ?, seen = ?, created = ?, price_changes = ?, stock_changes = ?,
              removed = ?, error = ? WHERE id = ?`,
    err ? 'error' : 'ok', now, run.requests, run.seen, run.created, run.priceChanges, run.stockChanges, run.removed,
    err ? err.message : null, run.id);
    if (err) {
      // Back off from a site that keeps failing so the scheduler does not hammer it every minute
      const failures = (db.get('SELECT sync_failures FROM companies WHERE id = ?', comp.id).sync_failures || 0) + 1;
      const next = new Date(Date.now() + backoffMinutes(failures) * 60e3).toISOString();
      db.run("UPDATE companies SET sync_state = 'error', sync_error = ?, sync_failures = ?, next_sync_at = ? WHERE id = ?", err.message, failures, next, comp.id);
    } else {
      const cols = run.kind === 'full'
        ? 'last_full_sync_at = ?, last_incremental_at = ?'
        : 'last_incremental_at = ?, last_full_sync_at = COALESCE(last_full_sync_at, ?)';
      db.run(`UPDATE companies SET sync_state = 'ok', sync_error = NULL, sync_failures = 0, next_sync_at = NULL, ${cols} WHERE id = ?`, run.startedAt, run.startedAt, comp.id);
    }
    if (metrics) {
      metrics.inc('anbar_sync_runs_total', { kind: run.kind, result: err ? 'error' : 'ok' });
      metrics.observe('anbar_sync_duration_seconds', { kind: run.kind }, (Date.now() - new Date(run.startedAt).getTime()) / 1000, [1, 5, 15, 30, 60, 120, 300, 600]);
    }
    running.delete(comp.id);
    events.emit('sync', {
      companyId: comp.id, state: err ? 'error' : 'ok', kind: run.kind, error: err ? err.message : null,
      seen: run.seen, created: run.created, priceChanges: run.priceChanges, stockChanges: run.stockChanges, removed: run.removed
    });
    // Old run rows are only for troubleshooting; keep the last 200 per company
    db.run(`DELETE FROM sync_runs WHERE company_id = ? AND id NOT IN
              (SELECT id FROM sync_runs WHERE company_id = ? ORDER BY id DESC LIMIT 200)`, comp.id, comp.id);
  }

  async function fetchVariations(client, comp, parents, run, source) {
    const seenIds = [];
    await mapLimit(parents, 4, async (parent) => {
      let page = 1, pages;
      do {
        const fetchedAt = nowIso();
        const res = await client.variations(parent.id, { page });
        pages = res.totalPages;
        const items = (res.data || []).map((v) => normalise(v, comp.price_unit, parent)).filter(Boolean);
        items.forEach((i) => seenIds.push(i.woo_id));
        add(run, apply(comp, items, { source, fetchedAt }));
        page++;
      } while (page <= pages);
    });
    return seenIds;
  }

  /** Reads every product and variation of the site. */
  async function fullSyncRun(companyId, { userId } = {}) {
    const comp = company(companyId);
    const run = startRun(comp, 'full', userId);
    let client = null;
    try {
      client = clientFor(comp);
      const seen = new Set();
      const parents = [];
      let page = 1, pages, total = 0;
      do {
        const fetchedAt = nowIso();
        const res = await client.products({ page });
        pages = res.totalPages;
        total = res.total || total;
        const items = [];
        for (const raw of res.data || []) {
          if (raw.type === 'variable') { parents.push(raw); continue; }
          const it = normalise(raw, comp.price_unit);
          if (it) { items.push(it); seen.add(it.woo_id); }
        }
        add(run, apply(comp, items, { source: 'sync', fetchedAt }));
        events.emit('sync', { companyId: comp.id, state: 'progress', kind: 'full', page, pages, total, seen: run.seen });
        page++;
      } while (page <= pages);
      (await fetchVariations(client, comp, parents, run, 'sync')).forEach((id) => seen.add(id));
      // Anything we had that the site no longer lists has been deleted there
      const known = db.all('SELECT woo_id FROM products WHERE company_id = ? AND removed_at IS NULL', comp.id).map((r) => r.woo_id);
      run.removed = markRemoved(comp, known.filter((id) => !seen.has(id)), nowIso());
      finishRun(comp, run, null, client);
      return run;
    } catch (err) {
      finishRun(comp, run, err, client);
      throw err;
    }
  }

  /** Only what changed since the last run (with two minutes of overlap). */
  async function incrementalSyncRun(companyId, { userId } = {}) {
    const comp = company(companyId);
    const since = comp.last_incremental_at || comp.last_full_sync_at;
    if (!since) return fullSyncRun(companyId, { userId });
    const run = startRun(comp, 'incremental', userId);
    let client = null;
    try {
      client = clientFor(comp);
      const modifiedAfter = new Date(new Date(since).getTime() - 120e3).toISOString().replace(/\.\d+Z$/, '');
      const parents = [];
      let page = 1, pages;
      do {
        const fetchedAt = nowIso();
        const res = await client.products({ page, modifiedAfter });
        pages = res.totalPages;
        const items = [];
        for (const raw of res.data || []) {
          if (raw.type === 'variable') { parents.push(raw); continue; }
          const it = normalise(raw, comp.price_unit);
          if (it) items.push(it);
        }
        add(run, apply(comp, items, { source: 'sync', fetchedAt }));
        page++;
      } while (page <= pages);
      await fetchVariations(client, comp, parents, run, 'sync');
      finishRun(comp, run, null, client);
      return run;
    } catch (err) {
      finishRun(comp, run, err, client);
      throw err;
    }
  }

  /** Reads one product from its site right now. */
  async function refreshProduct(productId, { userId } = {}) {
    const p = db.get('SELECT * FROM products WHERE id = ?', productId);
    if (!p) throw notFound('کالا پیدا نشد.');
    const comp = company(p.company_id);
    const client = clientFor(comp);
    const now = nowIso();
    try {
      let item;
      if (p.parent_woo_id) {
        const [parent, v] = await Promise.all([client.product(p.parent_woo_id), client.variation(p.parent_woo_id, p.woo_id)]);
        item = normalise(v, comp.price_unit, parent);
      } else {
        item = normalise(await client.product(p.woo_id), comp.price_unit);
      }
      if (item) apply(comp, [item], { source: 'refresh', userId, fetchedAt: now });
    } catch (err) {
      if (err.code === 'not_found') markRemoved(comp, [p.woo_id], now);
      else throw err;
    }
    return db.get('SELECT * FROM products WHERE id = ?', productId);
  }

  /**
   * Finds (and imports) the product behind a link from one of the company
   * sites. Returns the matching product ids; for a variable product without a
   * chosen variation, all its variations.
   */
  async function lookupUrl(url, { userId } = {}) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : 'https://' + String(url).trim()); } catch {
      throw badRequest('لینک معتبر نیست.', { url: 'لینک معتبر نیست.' });
    }
    const host = u.host.toLowerCase().replace(/^www\./, '');
    const comp = db.all('SELECT * FROM companies WHERE active = 1').find((c) => {
      const site = normaliseSiteUrl(c.site_url);
      return site && new URL(site).host.toLowerCase().replace(/^www\./, '') === host;
    });
    if (!comp) throw badRequest('این لینک مال هیچ‌کدام از سایت‌های شرکت‌های ثبت‌شده نیست.', { url: 'سایت این لینک بین شرکت‌ها نیست.' });
    const segments = u.pathname.split('/').filter(Boolean);
    const slug = segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
    const client = clientFor(comp);
    const fetchedAt = nowIso();
    let raw = null;
    const pid = Number(u.searchParams.get('p') || u.searchParams.get('product_id') || 0);
    if (pid) raw = await client.product(pid).catch(() => null);
    if (!raw && slug) {
      const res = await client.products({ slug, perPage: 5 });
      raw = (res.data || [])[0] || null;
    }
    if (!raw) throw notFound('کالایی با این لینک در سایت پیدا نشد.');
    if (raw.type !== 'variable') {
      apply(comp, [normalise(raw, comp.price_unit)], { source: 'refresh', userId, fetchedAt });
      const p = db.get('SELECT id FROM products WHERE company_id = ? AND woo_id = ?', comp.id, raw.id);
      return { company: { id: comp.id, name: comp.name }, ids: [p.id], matched: p.id };
    }
    const run = { seen: 0, created: 0, priceChanges: 0, stockChanges: 0 };
    await fetchVariations(client, comp, [raw], run, 'refresh');
    const rows = db.all('SELECT id, woo_id, permalink FROM products WHERE company_id = ? AND parent_woo_id = ? AND removed_at IS NULL ORDER BY woo_id', comp.id, raw.id);
    // A variation link carries ?attribute_pa_color=red…; match it to the variation with the same permalink query
    const wanted = [...u.searchParams.entries()].filter(([k]) => k.startsWith('attribute_')).map(([k, v]) => `${k}=${v}`.toLowerCase());
    let matched = null;
    if (wanted.length) {
      const hit = rows.find((r) => {
        try {
          const q = new URL(r.permalink).searchParams;
          return wanted.every((w) => { const [k, v] = w.split('='); return String(q.get(k) || '').toLowerCase() === v; });
        } catch { return false; }
      });
      matched = hit ? hit.id : null;
    }
    return { company: { id: comp.id, name: comp.name }, ids: rows.map((r) => r.id), matched };
  }

  /** Items pushed by the WordPress plugin (already authenticated by the route). */
  function applyPush(comp, payload) {
    const now = nowIso();
    const items = [];
    for (const raw of Array.isArray(payload.items) ? payload.items : []) {
      if (!raw || !raw.id) continue;
      const parent = raw.parent && raw.parent.id ? raw.parent : null;
      const it = normalise(raw, comp.price_unit, parent);
      if (it) items.push(it);
    }
    // A push is the freshest word from the site (sent as the change happens), so it is not
    // checked against fetchedAt; its parts commit together.
    return db.tx(() => {
      const stats = apply(comp, items, { source: 'webhook', now });
      const deleted = (Array.isArray(payload.deleted) ? payload.deleted : []).map(Number).filter(Boolean);
      stats.removed = deleted.length ? markRemoved(comp, deleted, now) : 0;
      db.run('UPDATE companies SET last_webhook_at = ? WHERE id = ?', now, comp.id);
      events.emit('company', { id: comp.id });
      return stats;
    });
  }

  /**
   * An admin records the price by hand (the site was unreachable, or it showed
   * a wrong price). It applies from `effectiveAt` (default now) and stays until
   * the site reports a different price.
   */
  function manualPrice(productId, { regular, sale = null, effectiveAt, note, userId }) {
    const p = db.get('SELECT * FROM products WHERE id = ?', productId);
    if (!p) throw notFound('کالا پیدا نشد.');
    const now = nowIso();
    const at = effectiveAt || now;
    const last = db.get('SELECT MAX(effective_at) AS t FROM price_history WHERE product_id = ?', productId).t;
    if (at > now) throw badRequest('زمان شروع قیمت نمی‌تواند در آینده باشد.', { effective_at: 'زمان آینده مجاز نیست.' });
    if (last && at < last) {
      throw badRequest('زمان شروع باید بعد از آخرین تغییر ثبت‌شده‌ی این کالا باشد.', { effective_at: 'قبل از آخرین تغییر ثبت‌شده است.' });
    }
    db.tx(() => {
      db.run(`INSERT INTO price_history (product_id, regular_price, sale_price, stock_status, stock_quantity, price_changed, stock_changed,
                source, effective_at, observed_at, user_id, note) VALUES (?, ?, ?, ?, ?, 1, 0, 'manual', ?, ?, ?, ?)`,
      productId, regular, sale, p.stock_status, p.stock_quantity, at, now, userId || null, note || null);
      db.run(`UPDATE products SET regular_price = ?, sale_price = ?, price_source = 'manual', last_changed_at = ?, updated_at = ? WHERE id = ?`,
        regular, sale, now, now, productId);
    });
    events.emit('products', { companyId: p.company_id, ids: [productId], priceChanges: 1, source: 'manual' });
    return db.get('SELECT * FROM products WHERE id = ?', productId);
  }

  /**
   * The site price of a product at a moment (ISO time). null when we had not
   * seen the product yet at that time.
   */
  function priceAt(productId, at, { graceMs = 0 } = {}) {
    const cols = 'id, regular_price, sale_price, stock_status, stock_quantity, source, effective_at, observed_at';
    const row = db.get(`SELECT ${cols} FROM price_history WHERE product_id = ? AND effective_at <= ? AND (price_changed = 1 OR source = 'import')
                        ORDER BY effective_at DESC, id DESC LIMIT 1`, productId, at);
    if (row || !graceMs) return row || null;
    // Ordered shortly before we first read the product (or the time was typed to the minute):
    // the first price we saw is the best evidence; the caller marks it uncertain
    const first = db.get(`SELECT ${cols} FROM price_history WHERE product_id = ? ORDER BY effective_at, id LIMIT 1`, productId);
    if (first && new Date(first.effective_at).getTime() - new Date(at).getTime() <= graceMs) return { ...first, before_first_seen: true };
    return null;
  }

  /** Runs are tracked so a shutdown can wait for them instead of cutting a sync in half. */
  function tracked(fn) {
    return (...args) => {
      const p = fn(...args);
      runPromises.add(p);
      const done = () => runPromises.delete(p);
      p.then(done, done);
      return p;
    };
  }
  const fullSync = tracked(fullSyncRun);
  const incrementalSync = tracked(incrementalSyncRun);

  /** Resolves when no sync is running, or after timeoutMs (true = all finished). */
  async function whenIdle(timeoutMs = 25000) {
    if (!runPromises.size) return true;
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); });
    const all = Promise.allSettled([...runPromises]).then(() => true);
    const result = await Promise.race([all, timeout]);
    clearTimeout(timer);
    return result;
  }

  return {
    running, clientFor, whenIdle, apply, normalise, fullSync, incrementalSync, refreshProduct, lookupUrl, applyPush, priceAt, manualPrice,
    /** fn([{ productId, companyId, priceChanged, stockChanged, before, after }]) after every write of site changes */
    onChanges: (fn) => changeListeners.push(fn),
    /** Connection test for the "new company" form (nothing is saved). */
    detect: ({ siteUrl, key, secret }) => detect({ siteUrl, key, secret, timeoutMs: config.wooTimeoutMs, fetchImpl }),
    isRunning: (companyId) => running.has(companyId),
    log
  };
}

module.exports = { createSync, backoffMinutes, normalise, effectiveTime, decodeEntities, guessUnits };
