'use strict';
const { nowIso, conflict } = require('./util');
const { declaredPackUnits } = require('./sync');

/** API boundary: validate before handing money/stock work to the existing orders module. */
function normalizeOrder(raw) {
  const id = raw.order_number ?? raw.id;
  if (id === null || id === undefined || String(id).trim() === '') throw conflict('سفارش دریافتی شناسه ندارد؛ همگام‌سازی کامل نشد.');
  const time = raw.ordered_at ?? raw.created_at;
  const date = typeof time === 'object' ? time?.date : time;
  const orderedAt = Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
  const status = typeof raw.status === 'object' ? String(raw.status?.title || raw.status?.code || '') : String(raw.status || 'نامشخص');
  return { id: String(id), status, ordered_at: orderedAt, items: raw.items || raw.order_items || [] };
}

function createDigikalaOrders({ db, client, connection, orders, audit, events }) {
  let running = null;
  const state = () => db.get('SELECT * FROM dk_operations_sync WHERE id = 1');
  const list = ({ from, to } = {}) => db.all(`SELECT r.*, o.cancelled_at FROM dk_remote_orders r LEFT JOIN orders o ON o.id = r.order_id
    ${from && to ? 'WHERE r.ordered_at >= ? AND r.ordered_at < ?' : ''} ORDER BY r.ordered_at DESC LIMIT 500`, ...(from && to ? [from, to] : [])).map(({ payload, ...r }) => ({ ...r,
    history: db.all('SELECT status, created_at FROM dk_order_events WHERE remote_id = ? ORDER BY id DESC LIMIT 20', r.remote_id) }));

  function materialize(actor, row) {
    const raw = JSON.parse(row.payload);
    const remote = normalizeOrder(raw);
    if (row.order_id) return;
    try {
      if (!remote.ordered_at) throw conflict('زمان سفارش در پاسخ دیجی‌کالا مشخص نیست.');
      if (!Array.isArray(remote.items) || !remote.items.length) throw conflict('اقلام سفارش در پاسخ موجود نیست.');
      if (/cancel|لغو|return|مرجوع/i.test(remote.status)) throw conflict('سفارش در دیجی‌کالا لغو شده؛ برای بررسی نگه داشته شد.');
      const platform = db.get("SELECT id FROM platforms WHERE code = 'digikala'");
      const lines = remote.items.map((i) => {
        const variant = i.variant_id ?? i.product_variant_id;
        const listing = db.get(`SELECT id, units FROM listings WHERE platform_id = ? AND
          (code = ? OR code = ? OR code = ?)`, platform.id, String(variant), `DKPC-${variant}`, `DKPC ${variant}`);
        if (!listing) throw conflict(`تنوع ${variant ?? 'نامشخص'} به کالای سایت متصل نیست؛ ابتدا تطبیق آگهی را انجام دهید.`);
        const declared = declaredPackUnits(i.product_variant_title);
        if (declared && declared !== listing.units) throw conflict(`تعداد هر فروش تنوع ${variant} با بستهٔ ${declared} عددی دیجیکالا یکسان نیست؛ تطبیق را بررسی کنید.`);
        const qty = Number(i.quantity ?? i.count);
        const price = Number(i.selling_price ?? i.price);
        if (!Number.isSafeInteger(qty) || qty < 1 || !Number.isSafeInteger(price) || price < 0 || (i.selling_price == null && i.price == null)) throw conflict('تعداد یا قیمت فروش اقلام معتبر نیست.');
        return { listing_id: listing.id, qty, platform_price: price };
      });
      db.tx(() => {
        const fresh = db.get('SELECT order_id FROM dk_remote_orders WHERE remote_id = ?', remote.id);
        if (fresh.order_id) return;
        const id = orders.createOrder(actor, { platform_id: platform.id, order_number: remote.id, ordered_at: remote.ordered_at, lines }, { source: 'digikala' });
        db.run('UPDATE dk_remote_orders SET order_id = ?, error = NULL WHERE remote_id = ?', id, remote.id);
      });
    } catch (err) {
      db.tx(() => db.run('UPDATE dk_remote_orders SET error = ? WHERE remote_id = ?', err.message, remote.id));
    }
  }

  async function sync(actor = null) {
    if (running) return running;
    if (!connection().access_token_enc) throw conflict('اتصال دیجی‌کالا برقرار نیست.');
    running = (async () => {
      let count = 0;
      try {
        const groups = new Map();
        const from = new Date(Date.now() - 30 * 864e5).toISOString();
        // Both endpoints return order *lines*. Read all pages before grouping, even when
        // the lines of one order straddle pages. History includes cancellation and returns.
        for (const type of [null, 'processed', 'returned', 'canceled']) {
          for (let page = 1; page <= 200; page++) {
            const d = await client().orders({ page, size: 50, type, from });
            if (!Array.isArray(d?.items)) throw conflict('ساختار پاسخ سفارش‌های دیجی‌کالا شناخته‌شده نیست.');
            for (const raw of d.items) {
              if (!raw.order_id || !raw.product_variant_id) throw conflict('شناسهٔ سفارش یا تنوع در پاسخ موجود نیست.');
              const id = String(raw.order_id);
              const status = raw.order_status?.title || raw.order_status?.key || ({ processed: 'پردازش‌شده', returned: 'مرجوع‌شده', canceled: 'لغوشده' }[type]) || 'جاری';
              const line = { ...raw, selling_price: raw.selling_price ?? raw.unit_price, status };
              const group = groups.get(id) || { id, ordered_at: raw.order_created_at, rows: new Map() };
              // A history line replaces its pending copy; shipment ids distinguish split deliveries.
              const key = `${raw.product_variant_id}:${raw.shipment_id || ''}`;
              if (type) group.rows.delete(`${raw.product_variant_id}:`);
              group.rows.set(key, line);
              groups.set(id, group);
              count++;
            }
            const pages = Number(d.pager?.total_pages);
            if ((pages && page >= pages) || (!pages && d.items.length < 50)) break;
            if (page === 200) throw conflict('فهرست سفارش‌ها کامل نشد؛ سقف ۲۰۰ صفحه رسید.');
          }
        }
        for (const group of groups.values()) {
          db.tx(() => {
            const old = db.get('SELECT * FROM dk_remote_orders WHERE remote_id = ?', group.id);
            const previous = old ? JSON.parse(old.payload) : null;
            // An item disappearing from a remote endpoint is not proof of cancellation.
            // Keep previously seen variants until a positive history update arrives.
            for (const item of previous?.items || []) {
              if (![...group.rows.values()].some((x) => x.product_variant_id === item.product_variant_id)) {
                group.rows.set(`${item.product_variant_id}:${item.shipment_id || ''}`, item);
              }
            }
            const items = [...group.rows.values()].sort((a, b) => a.product_variant_id - b.product_variant_id || (a.shipment_id || 0) - (b.shipment_id || 0));
            const raw = { id: group.id, ordered_at: group.ordered_at, status: [...new Set(items.map((i) => i.status))].join('، '), items };
            const r = normalizeOrder(raw);
            db.run(`INSERT INTO dk_remote_orders (remote_id, remote_status, ordered_at, payload, first_seen_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(remote_id) DO UPDATE SET remote_status = excluded.remote_status,
              ordered_at = excluded.ordered_at, payload = excluded.payload, updated_at = excluded.updated_at`, r.id, r.status, r.ordered_at, JSON.stringify(raw), nowIso(), nowIso());
            if (!old || old.remote_status !== r.status) {
              db.run('INSERT INTO dk_order_events (remote_id, status, created_at) VALUES (?, ?, ?)', r.id, r.status, nowIso());
              audit(actor, { action: 'digikala', entity: 'order', id: old?.order_id || r.id, summary: `سفارش دیجی‌کالا ${r.id}: ${r.status}` });
            }
            if (old?.order_id && (old.remote_status !== r.status || JSON.stringify(previous.items) !== JSON.stringify(r.items))) {
              db.run('UPDATE dk_remote_orders SET error = ? WHERE remote_id = ?', 'وضعیت یا اقلام در دیجی‌کالا تغییر کرده؛ سفارش داخلی و دریافت/ارسال را بررسی کنید.', r.id);
            }
          });
        }
        for (const row of db.all('SELECT * FROM dk_remote_orders WHERE order_id IS NULL')) materialize(actor, row);
        db.tx(() => {
          db.run('UPDATE dk_operations_sync SET checked_at = ?, error = NULL WHERE id = 1', nowIso());
          events.emit('digikala', {});
          events.emit('orders', {});
        });
        return { fetched: count };
      } catch (err) {
        db.tx(() => {
          db.run('UPDATE dk_operations_sync SET error = ? WHERE id = 1', err.message);
          events.emit('digikala', {});
        });
        throw err;
      }
    })().finally(() => { running = null; });
    return running;
  }
  return { list, sync, state };
}
module.exports = { createDigikalaOrders, normalizeOrder };
