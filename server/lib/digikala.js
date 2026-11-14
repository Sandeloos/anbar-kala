'use strict';
/**
 * Automatic Digikala pricing (decisions in docs/decisions.md, ADR 0007). The only writer of
 * dk_connection and dk_jobs, and of the Digikala columns of listings.
 *
 * The formula belongs to each listing (set when a Digikala variant is linked to a site product):
 *   site price of one sale = site regular price × units ÷ units per pack     (as for settlement)
 *   Digikala price         = round up( site price × (1 + margin %) + fixed amount, to round_to )
 *
 * Flow: a site price change (sync.onChanges, inside the product transaction) queues one job per
 * auto-priced Digikala listing. A worker — outside any transaction, since it talks to Digikala —
 * takes each job: reads the variant; nothing to do if the price is already right; waits for an
 * admin if the change is above max_change_pct (30 %); in dry-run only records what it would send;
 * otherwise sends the price. When Digikala refuses the price itself (errors.selling_price: outside
 * the reference-price range) it deactivates the variant, sets its seller stock to 0 (remembering
 * the old number), opens a reference-price ticket and marks the listing blocked. An admin turns
 * it back on with one click once the reference price is approved.
 * Every result is written back in one transaction with its audit line.
 *
 * Import: reads every seller variant from Digikala, leaves out those that already have a listing,
 * and suggests the site product of each (same supplier code as the product SKU, else the closest
 * name). Nothing is linked by itself: a person confirms the product and the units of each sale,
 * then the chosen listings are created together.
 */
const crypto = require('crypto');
const { nowIso, badRequest, notFound, conflict, searchKey } = require('./util');
const { createDigikalaClient, decryptChallenge, checkPrivateKey, DigikalaError, DEFAULT_USER_AGENT } = require('./digikala-api');
const { guessUnits } = require('./sync');

const MODES = { off: 'خاموش', dry_run: 'آزمایشی (چیزی فرستاده نمی‌شود)', live: 'فعال' };
const SELF_TOKEN_DAYS = 180;

/** Digikala price of a listing by its formula, in rials (null when it cannot be computed). */
function priceFor(listing, product) {
  if (!listing || !product || product.regular_price === null || product.regular_price === undefined) return null;
  if (listing.margin_pct === null || listing.margin_pct === undefined) return null;
  const base = Math.round((product.regular_price * listing.units) / product.units_per_pack);
  const raw = base * (1 + Number(listing.margin_pct) / 100) + (listing.fixed_add || 0);
  const step = Math.max(1, listing.round_to || 1);
  return { base, price: Math.ceil(Math.round(raw) / step) * step };
}

/** "DKPC-1234", "1234" → 1234 (the Digikala variant id is the listing code). */
function variantIdOf(code) {
  const m = /^\s*(?:dkpc[-\s]?)?(\d{1,12})\s*$/i.exec(String(code || ''));
  return m ? Number(m[1]) : null;
}

function createDigikala({ db, secrets, audit, events, log, fetchImpl, retryBaseMs = 1000 }) {
  const conn = () => db.get('SELECT * FROM dk_connection WHERE id = 1');
  const platformId = () => (db.get("SELECT id FROM platforms WHERE code = 'digikala'") || {}).id;
  const dec = (v) => (v ? secrets.decrypt(v) : null);

  const tokens = {
    get() {
      const c = conn();
      return c.access_token_enc ? { access: dec(c.access_token_enc), refresh: dec(c.refresh_token_enc), expiresAt: c.access_expires_at } : null;
    },
    set({ access, refresh, expiresAt }) {
      db.run('UPDATE dk_connection SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), access_expires_at = ?, updated_at = ? WHERE id = 1',
        secrets.encrypt(access), refresh ? secrets.encrypt(refresh) : null, expiresAt || null, nowIso());
    }
  };
  const client = () => { const c = conn(); return createDigikalaClient({ baseUrl: c.base_url, userAgent: c.user_agent, tokens, fetchImpl, retryBaseMs }); };

  /* ------------------------------------------------------------ connection (manager) */
  function status() {
    const c = conn();
    const expires = c.connected_at ? new Date(new Date(c.connected_at).getTime() + SELF_TOKEN_DAYS * 864e5).toISOString() : null;
    const counts = db.get(`SELECT
        SUM(CASE WHEN status = 'needs_approval' THEN 1 ELSE 0 END) AS approval,
        SUM(CASE WHEN status IN ('pending', 'approved') THEN 1 ELSE 0 END) AS queued FROM dk_jobs`);
    return {
      mode: c.mode, mode_label: MODES[c.mode], base_url: c.base_url, client_code: c.client_code, user_agent: c.user_agent, default_user_agent: DEFAULT_USER_AGENT,
      has_key: !!c.private_key_enc, connected: !!c.access_token_enc, connected_at: c.connected_at, self_token_expires_at: expires,
      self_token_days_left: expires ? Math.floor((new Date(expires).getTime() - Date.now()) / 864e5) : null,
      max_change_pct: c.max_change_pct, ticket_sub_category_id: c.ticket_sub_category_id, last_error: c.last_error, last_ok_at: c.last_ok_at,
      needs_approval: counts.approval || 0, queued: counts.queued || 0,
      blocked: db.get("SELECT COUNT(*) AS n FROM listings WHERE dk_state = 'blocked'").n,
      auto_listings: db.get('SELECT COUNT(*) AS n FROM listings WHERE auto_price = 1 AND active = 1').n
    };
  }

  function setKey(actor, pem) {
    const bits = checkPrivateKey(pem);
    db.tx(() => {
      db.run('UPDATE dk_connection SET private_key_enc = ?, updated_at = ? WHERE id = 1', secrets.encrypt(pem.trim()), nowIso());
      audit(actor, { action: 'update', entity: 'settings', id: null, summary: `ثبت کلید خصوصی دیجی‌کالا (RSA ${bits || ''} بیتی)` });
    });
    return status();
  }

  /** Opens the code from the self-token page with the stored key and gets the tokens. */
  async function connect(actor, { client_code: clientCode, challenge }) {
    const c = conn();
    if (!c.private_key_enc) throw badRequest('اول کلید خصوصی را ثبت کنید.', { private_key: 'لازم است' });
    const code = decryptChallenge(dec(c.private_key_enc), challenge);
    try {
      await client().token(code);
    } catch (err) {
      db.tx(() => db.run('UPDATE dk_connection SET last_error = ?, updated_at = ? WHERE id = 1', err.message, nowIso()));
      // With the wrong key, RSA decryption does not fail (OpenSSL "implicit rejection" returns random
      // bytes); Digikala then refuses the code. Both causes are named for the person.
      throw badRequest(`دیجی‌کالا کد را نپذیرفت (${err.message}). کد اعتبارسنجی فقط چند دقیقه اعتبار دارد: یک کد تازه بگیرید، و مطمئن شوید کلید عمومیِ ثبت‌شده در دیجی‌کالا جفتِ همین کلید خصوصی است.`, { challenge: 'پذیرفته نشد' });
    }
    db.tx(() => {
      db.run('UPDATE dk_connection SET client_code = ?, connected_at = ?, last_error = NULL, last_ok_at = ?, updated_at = ? WHERE id = 1',
        clientCode || c.client_code, nowIso(), nowIso(), nowIso());
      audit(actor, { action: 'update', entity: 'settings', id: null, summary: 'اتصال به API فروشندگان دیجی‌کالا (توکن تازه)' });
    });
    return status();
  }

  function setSettings(actor, { mode, max_change_pct: maxChange, ticket_sub_category_id: ticketSub, base_url: baseUrl, user_agent: userAgent }) {
    const before = conn();
    const after = {
      mode: mode ?? before.mode, max_change_pct: maxChange ?? before.max_change_pct,
      ticket_sub_category_id: ticketSub === undefined ? before.ticket_sub_category_id : ticketSub, base_url: baseUrl || before.base_url,
      user_agent: userAgent === undefined ? before.user_agent : userAgent || null
    };
    if (!MODES[after.mode]) throw badRequest('حالت معتبر نیست.', { mode: 'معتبر نیست' });
    if (after.mode === 'live' && !before.access_token_enc) throw badRequest('برای حالت «فعال» اول به دیجی‌کالا وصل شوید.', { mode: 'وصل نیست' });
    db.tx(() => {
      db.run('UPDATE dk_connection SET mode = ?, max_change_pct = ?, ticket_sub_category_id = ?, base_url = ?, user_agent = ?, updated_at = ? WHERE id = 1',
        after.mode, after.max_change_pct, after.ticket_sub_category_id, after.base_url, after.user_agent, nowIso());
      const changes = audit.diff({ ...before, mode: MODES[before.mode] }, { ...after, mode: MODES[after.mode] },
        { mode: 'حالت قیمت‌گذاری خودکار', max_change_pct: 'سقف تغییر خودکار (٪)', ticket_sub_category_id: 'زیردسته‌ی تیکت قیمت مرجع', base_url: 'آدرس API', user_agent: 'User-Agent' });
      if (changes.length) audit(actor, { action: 'update', entity: 'settings', id: null, summary: 'تنظیمات قیمت‌گذاری خودکار دیجی‌کالا', changes });
      events.emit('digikala', {});
    });
    if (after.mode !== 'off') kick();
    return status();
  }

  /* ------------------------------------------------------------ the queue */
  const listingRow = (id) => db.get(`SELECT l.*, p.regular_price, p.units_per_pack, p.name AS product_name, pl.code AS platform_code
                                     FROM listings l JOIN products p ON p.id = l.product_id JOIN platforms pl ON pl.id = l.platform_id WHERE l.id = ?`, Number(id));

  /** Queues (or refreshes) the open job of a listing. Inside the caller's transaction. */
  function enqueue(listingId, reason) {
    if (conn().mode === 'off') return null;
    const l = listingRow(listingId);
    if (!l || l.platform_code !== 'digikala' || !l.auto_price || !l.active || l.dk_state === 'blocked') return null;
    const f = priceFor(l, l);
    const now = nowIso();
    const open = db.get("SELECT * FROM dk_jobs WHERE listing_id = ? AND status IN ('pending', 'needs_approval', 'approved')", l.id);
    if (open) {
      // A newer site price replaces the one waiting; an approval was for the old number, so it is asked again
      db.run("UPDATE dk_jobs SET status = 'pending', reason = ?, site_price = ?, target_price = ?, attempts = 0, next_at = NULL, error = NULL, updated_at = ? WHERE id = ?",
        reason, f && f.base, f && f.price, now, open.id);
      return open.id;
    }
    return Number(db.run(`INSERT INTO dk_jobs (listing_id, status, reason, site_price, target_price, created_at, updated_at)
                          VALUES (?, 'pending', ?, ?, ?, ?, ?)`, l.id, reason, f && f.base, f && f.price, now, now).lastInsertRowid);
  }

  /** sync.onChanges listener: a site price change queues its auto-priced Digikala listings. */
  function onChanges(changes) {
    if (conn().mode === 'off') return;
    const pid = platformId();
    let queued = 0;
    for (const c of changes) {
      if (!c.priceChanged || c.before.regular_price === c.after.regular_price) continue;
      for (const l of db.all('SELECT id FROM listings WHERE product_id = ? AND platform_id = ? AND auto_price = 1 AND active = 1', c.productId, pid)) {
        if (enqueue(l.id, 'site_price')) queued++;
      }
    }
    if (queued) { events.emit('digikala', { queued }); db.afterCommit(kick); }
  }

  /** Is this listing priced by the robot (so the manual inbox does not need a price task)? */
  const handles = (listing) => conn().mode !== 'off' && listing.auto_price === 1;

  /* ------------------------------------------------------------ the worker */
  let running = null;
  function kick() {
    if (running) return running;
    running = processDue().catch((err) => log.error({ err }, 'digikala worker failed')).finally(() => { running = null; });
    return running;
  }

  async function processDue(limit = 50) {
    let done = 0;
    for (; done < limit; done++) {
      const mode = conn().mode;
      if (mode === 'off') break;
      const job = db.get(`SELECT * FROM dk_jobs WHERE status IN ('pending', 'approved') AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT 1`, nowIso());
      if (!job) break;
      await processJob(job, mode);
    }
    return done;
  }

  function finish(job, fields, summary, extra = {}) {
    db.tx(() => {
      const f = { ...fields, updated_at: nowIso() };
      const cols = Object.keys(f);
      db.run(`UPDATE dk_jobs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => f[c]), job.id);
      if (extra.listing) {
        const lc = Object.keys(extra.listing);
        db.run(`UPDATE listings SET ${lc.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...lc.map((c) => extra.listing[c]), nowIso(), job.listing_id);
      }
      if (extra.ok) db.run('UPDATE dk_connection SET last_ok_at = ?, last_error = NULL WHERE id = 1', nowIso());
      if (extra.error) db.run('UPDATE dk_connection SET last_error = ? WHERE id = 1', extra.error);
      if (summary) audit(null, { action: 'digikala', entity: 'listing', id: job.listing_id, summary, changes: extra.changes });
      events.emit('digikala', { job: job.id, listing: job.listing_id });
      if (extra.listing) events.emit('listings', { ids: [job.listing_id] });
    });
  }

  async function processJob(job, mode) {
    const l = listingRow(job.listing_id);
    const name = l ? `${l.code || ''} «${l.product_name}»` : `#${job.listing_id}`;
    if (!l || !l.auto_price || !l.active || l.dk_state === 'blocked') return finish(job, { status: 'skipped', error: 'آگهی قیمت‌گذاری خودکار ندارد یا متوقف است.' });
    const vid = variantIdOf(l.code);
    if (!vid) return finish(job, { status: 'failed', error: 'کد تنوع دیجی‌کالا (DKPC) برای این آگهی ثبت نشده.' }, null);
    const f = priceFor(l, l);
    if (!f) return finish(job, { status: 'failed', error: 'قیمت سایت یا حاشیه‌ی سود این آگهی معلوم نیست.' });
    const api = client();
    let v;
    try {
      v = await api.variant(vid);
    } catch (err) {
      return failOrRetry(job, err);
    }
    const current = v.price_sale ?? null;
    const change = current ? Math.abs(f.price - current) / current : null;
    const base = { site_price: f.base, target_price: f.price, current_price: current, reference_price: v.price_list ?? null, change_pct: change === null ? null : Math.round(change * 1000) / 10 };
    if (current === f.price) return finish(job, { ...base, status: 'unchanged' }, null, { ok: true });
    const maxPct = conn().max_change_pct;
    if (job.status !== 'approved' && change !== null && change * 100 > maxPct) {
      return finish(job, { ...base, status: 'needs_approval' }, `دیجی‌کالا ${name}: تغییر ${base.change_pct}٪ بیشتر از سقف ${maxPct}٪ است؛ منتظر تأیید`);
    }
    if (mode === 'dry_run') {
      return finish(job, { ...base, status: 'dry_run', result: JSON.stringify({ would_send: f.price, credit_increase_percentage: v.credit_increase_percentage ?? 0 }) }, null, { ok: true });
    }
    try {
      await api.setPrice(vid, f.price, v.credit_increase_percentage ?? 0);
      return finish(job, { ...base, status: 'sent', error: null, result: JSON.stringify({ price: f.price }) },
        `قیمت دیجی‌کالا ${name} خودکار عوض شد`, {
          ok: true, listing: { platform_price: f.price },
          changes: [{ field: 'platform_price', label: 'قیمت در دیجی‌کالا (ریال)', from: current, to: f.price }]
        });
    } catch (err) {
      if (!(err instanceof DigikalaError) || !err.priceRefused) return failOrRetry(job, err, base);
      return refuse(job, l, vid, v, base, err, name);
    }
  }

  /** The price is outside what Digikala accepts: off, stock 0, reference-price ticket. */
  async function refuse(job, l, vid, v, base, err, name) {
    const api = client();
    const done = { refused: err.errors.selling_price.join(' '), deactivated: false, stock_zero: false, ticket: null };
    const stockBefore = v.marketplace_seller_stock ?? null;
    try { await api.setActive(vid, false); done.deactivated = true; } catch (e) { done.deactivate_error = e.message; }
    try { await api.setStock(vid, 0); done.stock_zero = true; } catch (e) { done.stock_error = e.message; }
    done.ticket = await referenceTicket(v, base.target_price).catch((e) => ({ error: e.message }));
    const ticketText = done.ticket && done.ticket.id ? `تیکت قیمت مرجع ${done.ticket.id} ثبت شد` : 'تیکت قیمت مرجع باید دستی ثبت شود';
    return finish(job, { ...base, status: 'rejected', error: done.refused, result: JSON.stringify(done) },
      `دیجی‌کالا قیمت ${name} را نپذیرفت (${done.refused}): ${done.deactivated ? 'غیرفعال شد' : 'غیرفعال نشد!'}، ${done.stock_zero ? 'موجودی صفر شد' : 'موجودی صفر نشد!'}، ${ticketText}`,
      { listing: { dk_state: 'blocked', dk_stock_before: stockBefore } });
  }

  /** Opens the reference-price ticket when its sub-category is configured; null otherwise (manual). */
  async function referenceTicket(variant, price) {
    const sub = conn().ticket_sub_category_id;
    if (!sub) return null;
    const api = client();
    const fields = await api.ticketFields(sub);
    const items = (fields && (fields.items || fields)) || [];
    const modal = items.find((x) => x && x.type === 'dynamic_modal');
    if (!modal || !modal.name) throw new Error('فرم تیکت قیمت مرجع فیلد کالا ندارد.');
    const t = await api.createTicket(sub, { [modal.name]: [{ product_id: variant.product_id, new_reference_price: price, is_registered_in_124: false, link: variant.product_url || '' }] });
    return { id: t && (t.id || t.ticket_id) ? t.id || t.ticket_id : 'ok' };
  }

  function failOrRetry(job, err, base = {}) {
    const attempts = job.attempts + 1;
    const retry = err instanceof DigikalaError && err.retryable && attempts < 5;
    if (retry) {
      const next = new Date(Date.now() + Math.min(3600e3, 60e3 * 2 ** attempts)).toISOString();
      return finish(job, { ...base, attempts, next_at: next, error: err.message }, null, { error: err.message });
    }
    return finish(job, { ...base, status: 'failed', attempts, error: err.message }, `دیجی‌کالا: ارسال قیمت ${job.listing_id} ناموفق بود — ${err.message}`, { error: err.message });
  }

  /* ------------------------------------------------------------ people's decisions */
  function jobRow(id) {
    const j = db.get('SELECT * FROM dk_jobs WHERE id = ?', Number(id));
    if (!j) throw notFound('کار پیدا نشد.');
    return j;
  }

  function approve(actor, id) {
    const j = jobRow(id);
    if (j.status !== 'needs_approval') throw conflict('این مورد منتظر تأیید نیست.');
    db.tx(() => {
      db.run("UPDATE dk_jobs SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'needs_approval'", actor.user.id, nowIso(), nowIso(), j.id);
      audit(actor, { action: 'approve', entity: 'listing', id: j.listing_id, summary: `تأیید تغییر ${j.change_pct}٪ قیمت دیجی‌کالا (به ${j.target_price} ریال)` });
      events.emit('digikala', { job: j.id });
    });
    kick();
  }

  function reject(actor, id) {
    const j = jobRow(id);
    if (j.status !== 'needs_approval') throw conflict('این مورد منتظر تأیید نیست.');
    db.tx(() => {
      db.run("UPDATE dk_jobs SET status = 'cancelled', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'needs_approval'", actor.user.id, nowIso(), nowIso(), j.id);
      audit(actor, { action: 'dismiss', entity: 'listing', id: j.listing_id, summary: `رد تغییر ${j.change_pct}٪ قیمت دیجی‌کالا؛ قیمت دست نخورد` });
      events.emit('digikala', { job: j.id });
    });
  }

  /** The reference price was approved: variant on again, stock back, price sent again. */
  async function reactivate(actor, listingId, { stock } = {}) {
    const l = listingRow(listingId);
    if (!l) throw notFound('آگهی پیدا نشد.');
    if (l.dk_state !== 'blocked') throw conflict('این آگهی متوقف نیست.');
    const vid = variantIdOf(l.code);
    const qty = stock ?? l.dk_stock_before ?? 0;
    if (conn().mode === 'live') {
      const api = client();
      try {
        await api.setActive(vid, true);
        await api.setStock(vid, qty);
      } catch (err) {
        throw badRequest(`دیجی‌کالا فعال‌سازی را نپذیرفت: ${err.message}`);
      }
    }
    db.tx(() => {
      db.run('UPDATE listings SET dk_state = NULL, dk_stock_before = NULL, updated_at = ? WHERE id = ?', nowIso(), l.id);
      audit(actor, { action: 'update', entity: 'listing', id: l.id, summary: `فعال‌سازی دوباره‌ی ${l.code || ''} «${l.product_name}» در دیجی‌کالا با موجودی ${qty}` });
      enqueue(l.id, 'reactivated');
      events.emit('listings', { ids: [l.id] });
      events.emit('digikala', {});
    });
    kick();
    return listingRow(l.id);
  }

  /** "Check this listing now" from its page. */
  function reprice(actor, listingId) {
    const l = listingRow(listingId);
    if (!l) throw notFound('آگهی پیدا نشد.');
    if (conn().mode === 'off') throw conflict('قیمت‌گذاری خودکار دیجی‌کالا خاموش است.');
    if (!l.auto_price) throw conflict('قیمت‌گذاری خودکار این آگهی روشن نیست.');
    const id = db.tx(() => {
      const jid = enqueue(l.id, 'manual');
      audit(actor, { action: 'sync', entity: 'listing', id: l.id, summary: `بررسی دوباره‌ی قیمت دیجی‌کالای ${l.code || ''} «${l.product_name}»` });
      return jid;
    });
    kick();
    return id;
  }

  function jobs({ status, limit = 100 } = {}) {
    const where = status === 'attention' ? "WHERE j.status IN ('needs_approval', 'rejected', 'failed')" : status ? 'WHERE j.status = ?' : '';
    return db.all(`SELECT j.*, l.code, l.units, l.margin_pct, l.dk_state, p.name AS product_name, c.name AS company_name, c.currency, u.name AS decided_by_name
                   FROM dk_jobs j JOIN listings l ON l.id = j.listing_id JOIN products p ON p.id = l.product_id JOIN companies c ON c.id = p.company_id
                   LEFT JOIN users u ON u.id = j.decided_by ${where} ORDER BY j.updated_at DESC, j.id DESC LIMIT ?`,
    ...(status && status !== 'attention' ? [status] : []), Math.min(500, limit)).map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
  }

  const blocked = () => db.all(`SELECT l.id, l.code, l.title, l.units, l.dk_stock_before, l.updated_at, p.name AS product_name, c.name AS company_name
                                FROM listings l JOIN products p ON p.id = l.product_id JOIN companies c ON c.id = p.company_id
                                WHERE l.dk_state = 'blocked' ORDER BY l.updated_at DESC`);

  /* ------------------------------------------------------------ import of listings */
  const previews = new Map(); // id → { at, variants: Map(variant id → variant) }
  const PREVIEW_TTL = 60 * 60e3;

  /** Reads every seller variant (network, outside any transaction) and suggests a site product for each. */
  async function importPreview({ maxPages = 200, size = 50 } = {}) {
    const c = conn();
    if (!c.access_token_enc) throw badRequest('اول از صفحه‌ی «قیمت دیجی‌کالا» به دیجی‌کالا وصل شوید.');
    const api = client();
    const all = [];
    let pages = 1;
    try {
      for (let page = 1; page <= Math.min(pages, maxPages); page++) {
        const d = await api.variants({ page, size });
        const items = (d && d.items) || [];
        all.push(...items);
        pages = Number(d && d.pager && d.pager.total_pages) || (items.length < size ? page : page + 1);
        if (!items.length) break;
      }
    } catch (err) {
      db.tx(() => db.run('UPDATE dk_connection SET last_error = ?, updated_at = ? WHERE id = 1', err.message, nowIso()));
      throw badRequest(`خواندن تنوع‌ها از دیجی‌کالا نشد: ${err.message}`);
    }
    db.tx(() => db.run('UPDATE dk_connection SET last_ok_at = ?, last_error = NULL WHERE id = 1', nowIso()));

    const linked = new Set(db.all('SELECT code FROM listings WHERE platform_id = ?', platformId()).map((l) => variantIdOf(l.code)).filter(Boolean));
    const fresh = all.map(variantView).filter((v) => v.variant_id && !linked.has(v.variant_id));
    const match = createMatcher(db.all(`SELECT p.id, p.name, p.sku, p.units_per_pack, p.regular_price, p.company_id, c.name AS company_name, c.currency
                                        FROM products p JOIN companies c ON c.id = p.company_id WHERE p.removed_at IS NULL AND c.active = 1`));
    const items = fresh.map((v) => ({ ...v, suggestions: match(v) }));
    items.sort((a, b) => ((b.suggestions[0] || {}).score || 0) - ((a.suggestions[0] || {}).score || 0));

    for (const [k, p] of previews) if (Date.now() - p.at > PREVIEW_TTL) previews.delete(k);
    const id = crypto.randomBytes(12).toString('base64url');
    previews.set(id, { at: Date.now(), variants: new Map(fresh.map((v) => [v.variant_id, v])) });
    return { preview_id: id, total: all.length, already_linked: all.length - fresh.length, items };
  }

  /** Creates the confirmed listings together: [{ variant_id, product_id, units }]. */
  function importCreate(actor, previewId, rows) {
    const p = previews.get(previewId);
    if (!p || Date.now() - p.at > PREVIEW_TTL) throw conflict('فهرست خوانده‌شده کهنه است؛ دوباره «خواندن از دیجی‌کالا» را بزنید.');
    const pid = platformId();
    const created = [];
    const skipped = [];
    db.tx(() => {
      for (const r of rows) {
        const v = p.variants.get(Number(r.variant_id));
        if (!v) { skipped.push({ variant_id: r.variant_id, reason: 'در فهرست خوانده‌شده نیست' }); continue; }
        const product = db.get('SELECT * FROM products WHERE id = ? AND removed_at IS NULL', Number(r.product_id));
        if (!product) { skipped.push({ variant_id: v.variant_id, reason: 'کالای سایت پیدا نشد' }); continue; }
        const code = String(v.variant_id);
        if (db.get('SELECT 1 FROM listings WHERE platform_id = ? AND code = ?', pid, code)) { skipped.push({ variant_id: v.variant_id, reason: 'آگهی دارد' }); continue; }
        const now = nowIso();
        const title = v.title.slice(0, 300);
        const id = Number(db.run(`INSERT INTO listings (platform_id, product_id, code, title, units, platform_price, note, search_text, created_at, updated_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pid, product.id, code, title, r.units, v.price_sale, v.supplier_code ? `کد تأمین‌کننده: ${v.supplier_code}` : null,
        searchKey([code, title, product.name, product.sku].filter(Boolean).join(' ')), now, now).lastInsertRowid);
        audit(actor, { action: 'create', entity: 'listing', id, summary: `ورود آگهی دیجی‌کالا ${code} برای «${product.name}» — هر فروش ${r.units} عدد از ${product.units_per_pack}` });
        created.push({ id, variant: v.variant_id });
      }
      if (created.length) events.emit('listings', { ids: created.map((x) => x.id) });
    });
    for (const x of created) p.variants.delete(x.variant);
    return { created: created.length, skipped };
  }

  return {
    status, setKey, connect, setSettings, enqueue, onChanges, handles, kick, processDue, approve, reject, reactivate, reprice, jobs, blocked,
    importPreview, importCreate, priceFor, variantIdOf, MODES
  };
}

/** A seller variant as the import page shows it (prices in rials). */
function variantView(v) {
  const product = String(v.product_title || '').trim();
  const own = String(v.title || '').trim();
  const title = own && product && !own.includes(product) ? `${product} — ${own}` : own || product;
  const extra = v.sku_config ? [v.sku_config.color, v.sku_config.size].filter((x) => typeof x === 'string' && x).join(' ') : '';
  return {
    variant_id: Number(v.id || v.product_variant_id) || null, product_id: v.product_id ?? null, title: title || `تنوع ${v.id}`, extra,
    supplier_code: v.supplier_code ? String(v.supplier_code).trim() : null, price_sale: v.price_sale ?? null, price_list: v.price_list ?? null,
    active: v.active !== false, stock: v.marketplace_seller_stock ?? null, image_src: v.image_src || null, product_url: v.product_url || null,
    units_guess: guessUnits(`${title} ${extra}`)
  };
}

const STOP = new Set(['مدل', 'بسته', 'عددی', 'عدد', 'تایی', 'و', 'با', 'برای', 'از', 'به', 'در', 'کد', 'رنگ', 'سایز', 'طرح', 'مناسب', 'مجموعه', 'یک', 'دو', 'سه']);
const words = (s) => searchKey(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
const codeKey = (s) => searchKey(s).replace(/[\s\-_./]/g, '');

/**
 * Suggests site products for a Digikala variant: the same supplier code as a product's SKU first
 * (score 1), then names sharing the most words (Dice coefficient). At most three, best first.
 */
function createMatcher(products) {
  const bySku = new Map();
  const index = new Map();
  const toks = new Map();
  for (const p of products) {
    if (p.sku) {
      const k = codeKey(p.sku);
      if (k) bySku.set(k, [...(bySku.get(k) || []), p]);
    }
    const w = new Set(words(p.name));
    toks.set(p.id, w);
    for (const t of w) index.set(t, [...(index.get(t) || []), p]);
  }
  const view = (p, score, why) => ({
    product_id: p.id, name: p.name, sku: p.sku, company_id: p.company_id, company_name: p.company_name, currency: p.currency,
    units_per_pack: p.units_per_pack, regular_price: p.regular_price, score: Math.round(score * 100) / 100, why
  });
  return (v) => {
    const out = new Map();
    if (v.supplier_code) for (const p of bySku.get(codeKey(v.supplier_code)) || []) out.set(p.id, view(p, 1, 'sku'));
    const mine = new Set(words(`${v.title} ${v.extra || ''}`));
    const shared = new Map();
    for (const t of mine) for (const p of index.get(t) || []) shared.set(p, (shared.get(p) || 0) + 1);
    const byName = [...shared].map(([p, n]) => [p, (2 * n) / (mine.size + toks.get(p.id).size)])
      .filter(([, s]) => s >= 0.25).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [p, s] of byName) if (!out.has(p.id)) out.set(p.id, view(p, s, 'name'));
    return [...out.values()].slice(0, 3);
  };
}

module.exports = { createDigikala, priceFor, variantIdOf, createMatcher, variantView, MODES };
