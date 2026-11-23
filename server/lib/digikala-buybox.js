'use strict';
const { nowIso, conflict, notFound, badRequest } = require('./util');

// Only explicit competition data may generate a suggestion. Reference price is not a competitor price.
function competition(v, suggestion) {
  const winner = typeof v.is_buy_box_winner === 'boolean' ? v.is_buy_box_winner : null;
  const price = Number(v.buy_box_price);
  const current = Number(v.price_sale);
  const valid = Number.isSafeInteger(price) && price > 10 && Number.isSafeInteger(current) && current > 0;
  const proposed = suggestion?.suggested_price;
  const suggested = winner === false && Number.isSafeInteger(proposed) && proposed > 0 && Number.isSafeInteger(current) && proposed < current ? proposed : null;
  return { current_price: Number.isSafeInteger(current) && current > 0 ? current : null,
    winning_price: valid ? price : null, is_winner: winner === null ? null : Number(winner),
    suggested_price: suggested && suggested < current ? suggested : null };
}

function createBuybox({ db, client, connection, audit, events, priceFor, pricingIssue, variantIdOf, onRefused }) {
  const locks = new Set();
  let scanning = null;
  const listing = (id) => db.get(`SELECT l.*, p.regular_price, p.units_per_pack, p.units_guessed, p.configured_at, p.packaging_pending, p.name, p.description, p.category_names, p.pricing_group FROM listings l
    JOIN products p ON p.id = l.product_id JOIN platforms pl ON pl.id = l.platform_id WHERE l.id = ? AND pl.code = 'digikala'`, Number(id));
  const list = () => db.all(`SELECT b.*, l.code, l.dk_state, p.name AS product_name FROM dk_buybox b
    JOIN listings l ON l.id = b.listing_id JOIN products p ON p.id = l.product_id ORDER BY b.is_winner, b.checked_at DESC LIMIT 500`);

  async function check(id, variant = null) {
    const l = listing(id);
    if (!l) throw notFound();
    const v = variant || await client().variant(variantIdOf(l.code));
    const suggestion = v.is_buy_box_winner === false ? await client().buyboxSuggestion(variantIdOf(l.code)) : null;
    const b = competition(v, suggestion);
    const formula = priceFor(l, l)?.price ?? null;
    db.tx(() => {
      db.run(`INSERT INTO dk_buybox (listing_id, current_price, winning_price, is_winner, suggested_price, formula_price, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(listing_id) DO UPDATE SET current_price = excluded.current_price,
        winning_price = excluded.winning_price, is_winner = excluded.is_winner, suggested_price = excluded.suggested_price,
        formula_price = excluded.formula_price, checked_at = excluded.checked_at, error = NULL`,
      l.id, b.current_price, b.winning_price, b.is_winner, b.suggested_price, formula, nowIso());
    });
    return { ...b, formula_price: formula, variant: v };
  }

  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      const listings = new Map(db.all(`SELECT l.id, l.code FROM listings l JOIN platforms p ON p.id = l.platform_id WHERE p.code = 'digikala' AND l.active = 1`).map((l) => [variantIdOf(l.code), l]));
      const seen = new Set();
      for (let page = 1; page <= 200; page++) {
        const data = await client().variants({ page, size: 50 });
        if (!Array.isArray(data?.items)) throw conflict('پاسخ فهرست تنوع‌ها معتبر نیست.');
        for (const v of data.items) {
          const l = listings.get(Number(v.id || v.product_variant_id));
          if (!l || locks.has(l.id)) continue;
          seen.add(l.id);
          try { await check(l.id, v); } catch (err) {
            db.tx(() => db.run(`INSERT INTO dk_buybox (listing_id, checked_at, error) VALUES (?, ?, ?)
              ON CONFLICT(listing_id) DO UPDATE SET error = excluded.error, suggested_price = NULL, checked_at = excluded.checked_at`, l.id, nowIso(), err.message));
          }
        }
        const pages = Number(data.pager?.total_pages);
        if ((pages && page >= pages) || (!pages && data.items.length < 50)) break;
        if (page === 200) throw conflict('فهرست بای‌باکس کامل نشد؛ دوباره بررسی کنید.');
      }
      for (const l of listings.values()) if (!seen.has(l.id) && !locks.has(l.id)) {
        db.tx(() => db.run(`INSERT INTO dk_buybox (listing_id, checked_at, error) VALUES (?, ?, ?)
          ON CONFLICT(listing_id) DO UPDATE SET suggested_price = NULL, error = excluded.error, checked_at = excluded.checked_at`, l.id, nowIso(), 'تنوع در فهرست دیجی‌کالا پیدا نشد.'));
      }
      db.tx(() => events.emit('digikala', {}));
    })().finally(() => { scanning = null; });
    return scanning;
  }

  async function approve(actor, id, expected) {
    id = Number(id);
    if (locks.has(id) || scanning) throw conflict('بررسی یا ارسال در جریان است؛ کمی بعد دوباره امتحان کنید.');
    if (connection().mode !== 'live') throw conflict('ارسال واقعی فقط در حالت فعال انجام می‌شود.');
    const before = listing(id);
    const snapshot = db.get('SELECT * FROM dk_buybox WHERE listing_id = ?', id);
    if (!before || !snapshot) throw notFound();
    if (!before.active || before.packaging_pending || before.dk_state === 'blocked') throw conflict('آگهی غیرفعال یا متوقف است.');
    const issue = pricingIssue(before, before);
    if (issue) throw conflict(issue);
    if (snapshot.error || snapshot.suggested_price !== expected || Date.now() - Date.parse(snapshot.checked_at) > 15 * 60e3) throw conflict('پیشنهاد کهنه است؛ دوباره بررسی کنید.');
    if (db.get("SELECT 1 FROM dk_jobs WHERE listing_id = ? AND status IN ('pending', 'approved', 'needs_approval')", id)) throw conflict('ابتدا کار قیمت‌گذاری این آگهی را تعیین تکلیف کنید.');
    locks.add(id);
    try {
      const fresh = await check(id);
      const current = listing(id);
      if (fresh.suggested_price !== expected || fresh.current_price !== snapshot.current_price || fresh.formula_price !== snapshot.formula_price || current.version !== before.version || !current.active || pricingIssue(current, current) || current.dk_state === 'blocked' || connection().mode !== 'live') throw conflict('قیمت یا آگهی تغییر کرده؛ پیشنهاد تازه را دوباره تأیید کنید.');
      try {
        await client().setPrice(variantIdOf(current.code), expected, fresh.variant.credit_increase_percentage ?? 0);
      } catch (err) {
        if (err.priceRefused) await onRefused(current, fresh.variant, expected, err);
        db.tx(() => {
          db.run('UPDATE dk_buybox SET error = ?, suggested_price = NULL WHERE listing_id = ?', err.message, id);
          events.emit('digikala', {});
        });
        throw badRequest(`ارسال پیشنهاد بای‌باکس انجام نشد: ${err.message}`);
      }
      db.tx(() => {
        db.run('UPDATE dk_buybox SET applied_price = ?, applied_formula_price = ?, current_price = ?, suggested_price = NULL, decided_by = ?, decided_at = ? WHERE listing_id = ?', expected, fresh.formula_price, expected, actor.user.id, nowIso(), id);
        db.run('UPDATE listings SET platform_price = ?, version = version + 1, updated_at = ? WHERE id = ?', expected, nowIso(), id);
        audit(actor, { action: 'digikala', entity: 'listing', id, summary: `تأیید پیشنهاد بای‌باکس: ${snapshot.current_price} ← ${expected} ریال؛ اختلاف با فرمول ${Math.max(0, (fresh.formula_price ?? expected) - expected)} ریال`, changes: audit.diff({ platform_price: snapshot.current_price }, { platform_price: expected }, { platform_price: 'قیمت دیجی‌کالا' }) });
        events.emit('digikala', {});
        events.emit('listings', { ids: [id] });
      });
      // A lower price alone never guarantees the buy box. Refresh its actual status.
      await check(id).catch(() => {});
    } finally { locks.delete(id); }
  }

  // Keep an approved reduction until the base formula changes. The next site-price change expires it.
  function effectivePrice(id, formula) {
    const b = db.get('SELECT * FROM dk_buybox WHERE listing_id = ?', id);
    return b?.applied_price && b.applied_formula_price === formula ? Math.min(formula, b.applied_price) : formula;
  }
  return { list, scan, approve, effectivePrice, isLocked: (id) => locks.has(id) };
}
module.exports = { createBuybox, competition };
