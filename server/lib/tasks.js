'use strict';
/**
 * The inbox (decision 7): when a company site changes the price or stock of a product that we
 * sell on Digikala / Basalam (an active listing on a platform other than the company site), a
 * task tells an admin what to change there. The admin marks it done (with the price actually set,
 * which becomes the listing's platform price) or not needed (with a reason). One open task per
 * listing and kind; a later change updates it; a change back to where it started closes it.
 */
const { nowIso, badRequest, notFound, conflict } = require('./util');

/** Same margin on the new site price, rounded to 1,000 rials (100 tomans). */
function suggest(platformPrice, before, after) {
  if (!platformPrice || !before || !after) return null;
  return Math.round((platformPrice * after) / before / 1000) * 1000;
}
const isLow = (status, qty, limit) => status === 'instock' && qty !== null && qty !== undefined && qty <= limit;

function createTasks({ db, events, audit, settings }) {
  function listingsOf(productId) {
    return db.all(`SELECT l.* FROM listings l JOIN platforms pl ON pl.id = l.platform_id
                   WHERE l.product_id = ? AND l.active = 1 AND pl.active = 1 AND pl.code <> 'site'`, productId);
  }

  /** Called by the sync engine with every price/stock change it wrote. */
  function onChanges(changes) {
    if (!changes.length) return;
    const limit = settings.get('low_stock_units');
    const now = nowIso();
    const touched = [];
    db.tx(() => {
      for (const c of changes) {
        const listings = listingsOf(c.productId);
        if (!listings.length) continue;
        for (const l of listings) {
          if (c.priceChanged && c.before.regular_price !== c.after.regular_price) {
            const open = db.get("SELECT * FROM tasks WHERE listing_id = ? AND kind = 'price' AND status = 'open'", l.id);
            if (open) {
              if (c.after.regular_price === open.site_price_before) {
                db.run("UPDATE tasks SET status = 'reverted', site_price_after = ?, closed_at = ?, updated_at = ?, changes = changes + 1 WHERE id = ?", c.after.regular_price, now, now, open.id);
              } else {
                db.run('UPDATE tasks SET site_price_after = ?, suggested_price = ?, changes = changes + 1, updated_at = ? WHERE id = ?',
                  c.after.regular_price, suggest(open.platform_price_before, open.site_price_before, c.after.regular_price), now, open.id);
              }
              touched.push(open.id);
            } else {
              const id = Number(db.run(`INSERT INTO tasks (kind, listing_id, product_id, platform_id, company_id, site_price_before, site_price_after,
                  platform_price_before, suggested_price, created_at, updated_at) VALUES ('price', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              l.id, c.productId, l.platform_id, c.companyId, c.before.regular_price, c.after.regular_price, l.platform_price,
              suggest(l.platform_price, c.before.regular_price, c.after.regular_price), now, now).lastInsertRowid);
              touched.push(id);
            }
          }
          if (c.stockChanged) {
            const wasOut = c.before.stock_status !== 'instock';
            const isOut = c.after.stock_status !== 'instock';
            const wasLow = isLow(c.before.stock_status, c.before.stock_quantity, limit);
            const nowLow = isLow(c.after.stock_status, c.after.stock_quantity, limit);
            const matters = wasOut !== isOut || (!wasLow && nowLow);
            const open = db.get("SELECT * FROM tasks WHERE listing_id = ? AND kind = 'stock' AND status = 'open'", l.id);
            if (open) {
              // Back where it started (in stock and not low again, or out of stock again)
              const back = c.after.stock_status === open.stock_before && (open.stock_before !== 'instock' || !isLow(c.after.stock_status, c.after.stock_quantity, limit));
              db.run(`UPDATE tasks SET stock_after = ?, qty_after = ?, changes = changes + 1, updated_at = ?,
                        status = CASE WHEN ? THEN 'reverted' ELSE status END, closed_at = CASE WHEN ? THEN ? ELSE closed_at END WHERE id = ?`,
              c.after.stock_status, c.after.stock_quantity, now, back ? 1 : 0, back ? 1 : 0, now, open.id);
              touched.push(open.id);
            } else if (matters) {
              const id = Number(db.run(`INSERT INTO tasks (kind, listing_id, product_id, platform_id, company_id, stock_before, stock_after, qty_before, qty_after,
                  platform_price_before, created_at, updated_at) VALUES ('stock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              l.id, c.productId, l.platform_id, c.companyId, c.before.stock_status, c.after.stock_status, c.before.stock_quantity, c.after.stock_quantity,
              l.platform_price, now, now).lastInsertRowid);
              touched.push(id);
            }
          }
        }
      }
    });
    if (touched.length) events.emit('tasks', { ids: touched });
  }

  const COLS = `t.*, l.code AS listing_code, l.title AS listing_title, l.units AS listing_units, l.platform_price AS listing_platform_price,
    pl.name AS platform_name, p.name AS product_name, p.units_per_pack, p.permalink, p.regular_price AS current_site_price, p.stock_status AS current_stock_status,
    p.stock_quantity AS current_stock_quantity, c.name AS company_name, c.currency, u.name AS closed_by_name`;
  const FROM = `FROM tasks t JOIN listings l ON l.id = t.listing_id JOIN platforms pl ON pl.id = t.platform_id JOIN products p ON p.id = t.product_id
    JOIN companies c ON c.id = t.company_id LEFT JOIN users u ON u.id = t.closed_by`;

  function one(id) {
    const t = db.get(`SELECT ${COLS} ${FROM} WHERE t.id = ?`, Number(id));
    if (!t) throw notFound('کار پیدا نشد.');
    return t;
  }

  function list({ status = 'open', platform, kind, company } = {}) {
    const where = [];
    const params = [];
    if (status === 'open') where.push("t.status = 'open'");
    else if (status === 'closed') where.push("t.status <> 'open'");
    if (platform) { where.push('t.platform_id = ?'); params.push(Number(platform)); }
    if (kind) { where.push('t.kind = ?'); params.push(kind); }
    if (company) { where.push('t.company_id = ?'); params.push(Number(company)); }
    return db.all(`SELECT ${COLS} ${FROM} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY ${status === 'open' ? 't.created_at' : 't.closed_at DESC'} LIMIT 500`, ...params);
  }

  /** Done: the admin changed it on the platform. For price tasks, the price they set (rials). */
  function done(req, id, { platformPrice, note }) {
    db.tx(() => {
      const t = one(id);
      if (t.status !== 'open') throw conflict('این کار قبلاً بسته شده است.');
      const now = nowIso();
      if (t.kind === 'price') {
        if (!platformPrice) throw badRequest('قیمتی را که در پلتفرم گذاشتید وارد کنید.', { platform_price: 'لازم است' });
        db.run('UPDATE listings SET platform_price = ?, updated_at = ? WHERE id = ?', platformPrice, now, t.listing_id);
      }
      db.run("UPDATE tasks SET status = 'done', done_price = ?, note = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?",
        t.kind === 'price' ? platformPrice : null, note || null, now, req.user.id, now, t.id);
      audit(req, {
        action: 'done', entity: 'listing', id: t.listing_id,
        summary: t.kind === 'price'
          ? `کارتابل: قیمت آگهی ${t.platform_name}${t.listing_code ? ` ${t.listing_code}` : ''} «${t.product_name}» عوض شد`
          : `کارتابل: موجودی آگهی ${t.platform_name}${t.listing_code ? ` ${t.listing_code}` : ''} «${t.product_name}» به‌روز شد${note ? ` — ${note}` : ''}`,
        changes: t.kind === 'price' ? [{ field: 'platform_price', label: 'قیمت در پلتفرم (ریال)', from: t.listing_platform_price, to: platformPrice }] : []
      });
    });
    events.emit('tasks', { ids: [Number(id)] });
    return one(id);
  }

  function dismiss(req, id, note) {
    if (!note) throw badRequest('بنویسید چرا لازم نیست.', { note: 'لازم است' });
    const t = one(id);
    if (t.status !== 'open') throw conflict('این کار قبلاً بسته شده است.');
    const now = nowIso();
    db.tx(() => {
      const changed = db.run("UPDATE tasks SET status = 'dismissed', note = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status = 'open'",
        note, now, req.user.id, now, t.id).changes;
      if (!changed) throw conflict('این کار قبلاً بسته شده است.');
      audit(req, { action: 'dismiss', entity: 'listing', id: t.listing_id, summary: `کارتابل: «${t.product_name}» در ${t.platform_name} لازم نبود — ${note}` });
      events.emit('tasks', { ids: [t.id] });
    });
    return one(id);
  }

  const openCount = () => db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").n;

  return { onChanges, list, one, done, dismiss, openCount, suggest };
}

module.exports = { createTasks, suggest };
