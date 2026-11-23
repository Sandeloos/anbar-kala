'use strict';
const { nowIso, conflict, notFound } = require('./util');
const { hasUnitPriceHint, declaredPackUnits } = require('./sync');

function createPackaging({ db, audit, events, guessUnits }) {
  const listeners = [];
  const signal = (p) => ({ quantity: guessUnits(`${p.name} ${p.attributes || ''}`), unit_price: hasUnitPriceHint(p) });
  function observe(before, next, { at, effectiveAt }) {
    const a = signal(before), b = signal(next);
    const factor = before.regular_price > 0 && next.regular_price > 0 ? Math.max(before.regular_price, next.regular_price) / Math.min(before.regular_price, next.regular_price) : 1;
    const quantity = before.sale_pack_units || before.units_per_pack;
    const suspicious = quantity > 1 && factor > 1.5 && Math.abs(factor - quantity) / quantity < 0.15;
    const evidence = next.pack_evidence;
    const basisConflict = (evidence || b.unit_price) && before.units_per_pack > 1;
    const saleConflict = evidence && !evidence.sizes.includes(quantity);
    const changed = a.quantity !== b.quantity || a.unit_price !== b.unit_price || suspicious || basisConflict || saleConflict;
    if (!changed && !before.packaging_pending) return;
    const open = db.get("SELECT * FROM packaging_reviews WHERE product_id = ? AND status = 'pending'", before.id);
    const prior = open && JSON.parse(open.after_json);
    const verified = evidence || (prior?.regular_price === next.regular_price && prior?.name === next.name ? prior.verified_pack : undefined);
    const snapshot = JSON.stringify({ name: next.name, attributes: next.attributes, regular_price: next.regular_price, ...b, verified_pack: verified });
    if (open?.after_json === snapshot) return;
    const reason = verified ? 'مبنای قیمت یا تعداد بستهٔ ثبت‌شده را با اطلاعات خوانده‌شده از صفحهٔ رادن تطبیق دهید.'
      : basisConflict ? 'سایت قیمت را برای یک عدد اعلام کرده ولی مبنای ثبت‌شده چند عدد است؛ تعداد فروش و مبنای قیمت را جداگانه تأیید کنید.'
      : 'تعداد بسته، نشانهٔ قیمت تکی یا نسبت قیمت سایت تغییر کرده؛ مبنای قیمت و تعداد تنوع‌های متصل را دوباره تأیید کنید.';
    if (open) db.run('UPDATE packaging_reviews SET after_json = ?, reason = ? WHERE id = ?', snapshot, reason, open.id);
    else db.run(`INSERT INTO packaging_reviews (product_id, reason, before_json, after_json, effective_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, before.id, reason, JSON.stringify({ name: before.name, price_units: before.units_per_pack, sale_units: quantity, regular_price: before.regular_price }), snapshot, effectiveAt, at);
    db.run('UPDATE products SET packaging_pending = 1, version = version + 1 WHERE id = ?', before.id);
    if (!open) audit(null, { action: 'update', entity: 'product', id: before.id, summary: `نیاز به تأیید دوبارهٔ بسته‌بندی «${next.name}»`, changes: [{ field: 'packaging_pending', label: 'تطبیق بسته‌بندی', from: 'تأییدشده', to: 'نیازمند بررسی' }] });
    events.emit('products', { ids: [before.id] });
    events.emit('digikala', {});
  }
  function recordBasis(before, after, at = nowIso()) {
    const initial = !db.get('SELECT 1 FROM packaging_history WHERE product_id = ?', before.id);
    if (!before.configured_at && initial) at = '0001-01-01T00:00:00.000Z';
    if (initial || before.units_per_pack !== after.units_per_pack || (before.sale_pack_units || before.units_per_pack) !== after.sale_pack_units) {
      db.run('INSERT INTO packaging_history (product_id, price_units, sale_units, effective_at, created_at) VALUES (?, ?, ?, ?, ?)', before.id, after.units_per_pack, after.sale_pack_units, at, nowIso());
      for (const fn of listeners) fn(before.id);
    }
  }
  function at(product, time) {
    const review = db.get("SELECT effective_at FROM packaging_reviews WHERE product_id = ? AND status = 'pending'", product.id);
    if (review && time >= review.effective_at) throw conflict('بسته‌بندی یا مبنای قیمت این کالا تغییر کرده؛ ابتدا تطبیق بسته‌بندی را تأیید کنید.');
    const row = db.get('SELECT * FROM packaging_history WHERE product_id = ? AND effective_at <= ? ORDER BY effective_at DESC, id DESC LIMIT 1', product.id, time);
    return row?.price_units || product.units_per_pack;
  }
  function pending() {
    return db.all(`SELECT r.*, p.name, p.version, p.units_per_pack, p.sale_pack_units, p.regular_price FROM packaging_reviews r JOIN products p ON p.id = r.product_id WHERE r.status = 'pending' ORDER BY r.created_at`).map((r) => {
      const after = JSON.parse(r.after_json);
      if (after.regular_price !== r.regular_price) delete after.verified_pack;
      return { ...r, before: JSON.parse(r.before_json), after, listings: connectedListings(r.product_id) };
    });
  }
  function connectedListings(productId) {
    return db.all('SELECT l.*, pl.name AS platform_name, pl.code AS platform_code FROM listings l JOIN platforms pl ON pl.id = l.platform_id WHERE l.product_id = ?', productId)
      .map((listing) => ({ ...listing, declared_units: listing.platform_code === 'digikala' ? declaredPackUnits(listing.title) : null }));
  }
  function confirm(actor, productId, body) {
    db.tx(() => {
      const p = db.get('SELECT * FROM products WHERE id = ?', productId);
      if (!p) throw notFound();
      if (p.version !== body.version) throw conflict('اطلاعات کالا تغییر کرده؛ صفحه را تازه کنید.');
      const review = db.get("SELECT * FROM packaging_reviews WHERE product_id = ? AND status = 'pending'", p.id);
      if (!review) throw conflict('این بسته‌بندی منتظر تأیید نیست.');
      const snapshot = JSON.parse(review.after_json);
      const verified = snapshot.regular_price === p.regular_price && snapshot.verified_pack;
      if (verified && (body.price_units !== verified.price_units || !verified.sizes.includes(body.sale_units))) {
        throw conflict('صفحهٔ رادن قیمت را برای یک عدد اعلام کرده است. تعداد بستهٔ فروش را از اندازه‌های درج‌شده در همان صفحه انتخاب کنید.');
      }
      const listings = connectedListings(p.id);
      if (body.listings.length !== listings.length || new Set(body.listings.map((r) => r.id)).size !== listings.length) throw conflict('تعداد تمام آگهی‌های متصل را بررسی کنید.');
      for (const l of listings) {
        const row = body.listings.find((r) => r.id === l.id);
        if (!row || row.version !== l.version) throw conflict('یکی از آگهی‌ها تغییر کرده؛ صفحه را تازه کنید.');
        if (l.declared_units && row.units !== l.declared_units) throw conflict('تعداد هر فروش را مطابق تعداد بسته در عنوان تنوع دیجیکالا وارد کنید.');
        db.run('UPDATE listings SET units = ?, version = version + 1, updated_at = ? WHERE id = ?', row.units, nowIso(), l.id);
        if (l.units !== row.units) audit(actor, { action: 'update', entity: 'listing', id: l.id, summary: `تأیید دوبارهٔ تعداد آگهی ${l.code || ''}`, changes: audit.diff(l, { ...l, units: row.units }, { units: 'عدد در هر فروش' }) });
      }
      const after = { ...p, units_per_pack: body.price_units, sale_pack_units: body.sale_units };
      db.run('UPDATE products SET units_per_pack = ?, sale_pack_units = ?, units_guessed = 0, packaging_pending = 0, configured_at = ?, version = version + 1, updated_at = ? WHERE id = ?', body.price_units, body.sale_units, nowIso(), nowIso(), p.id);
      // Record even unchanged quantities: the review closes an uncertain pricing interval.
      db.run('INSERT INTO packaging_history (product_id, price_units, sale_units, effective_at, created_at) VALUES (?, ?, ?, ?, ?)', p.id, body.price_units, body.sale_units, review.effective_at, nowIso());
      db.run("UPDATE packaging_reviews SET status = 'confirmed', confirmed_at = ? WHERE id = ?", nowIso(), review.id);
      audit(actor, { action: 'update', entity: 'product', id: p.id, summary: `تأیید دوبارهٔ بسته‌بندی و تطبیق «${p.name}»`, changes: audit.diff(p, after, { units_per_pack: 'قیمت سایت برای چند عدد', sale_pack_units: 'عدد در بستهٔ فروش' }) });
      for (const fn of listeners) fn(p.id);
      events.emit('products', { ids: [p.id] });
      events.emit('listings', { ids: listings.map((l) => l.id) });
      events.emit('digikala', {});
    });
  }
  return { observe, recordBasis, at, pending, count: () => db.get("SELECT COUNT(*) n FROM packaging_reviews WHERE status = 'pending'").n, confirm, onConfirmed: (fn) => listeners.push(fn) };
}
module.exports = { createPackaging };
