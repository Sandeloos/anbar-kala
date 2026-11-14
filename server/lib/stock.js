'use strict';
/**
 * The stock ledger: the only module that writes stock_moves.
 *
 * Stock of a product = SUM(units) per (product, warehouse, owner); owner is a partner company
 * (consigned surplus) or NULL (ours). Rows are never changed: a correction or an undo is an
 * opposite row (`reverse`). The database refuses a balance below zero and edits of old rows
 * (migration 005); this module checks first so people get a clear Persian message.
 *
 * Shared rules that used to be repeated in orders, returns and the stock routes live here:
 *  - which warehouse goods go to by default (`defaultWarehouse`, active warehouses only),
 *  - what company-owned units are worth to the company (`saleValue`),
 *  - where a line may be filled from and in which order (`available`, `suggestPicks`),
 *  - who may own stock of a product: us (NULL) or the company the product comes from.
 */
const { nowIso, badRequest, conflict } = require('./util');

const KIND_LABEL = {
  surplus_in: 'اضافه‌ی رسیده', wrong_in: 'کالای اشتباه رسیده', own_in: 'ورود کالای خودمان', ship_out: 'ارسال برای سفارش',
  return_to_company: 'برگشت به شرکت', transfer_out: 'انتقال (خروج)', transfer_in: 'انتقال (ورود)', adjust: 'اصلاح موجودی', reversal: 'برگرداندن',
  return_in: 'مرجوعی مشتری', write_off: 'معیوب (حذف از موجودی)', count: 'انبارگردانی'
};
const KINDS = new Set(Object.keys(KIND_LABEL));

/** What `units` of a line are worth to the company: the line's amount per sale, pro rata. */
const saleValue = (settleUnitPrice, units, unitsPerSale) => Math.round((settleUnitPrice * units) / unitsPerSale);

function createStock({ db, audit, events }) {
  const productOf = (id) => {
    const p = db.get('SELECT p.*, c.name AS company_name, c.warehouse_id AS company_warehouse_id FROM products p JOIN companies c ON c.id = p.company_id WHERE p.id = ?', Number(id));
    if (!p) throw badRequest('کالا پیدا نشد.', { product_id: 'پیدا نشد.' });
    return p;
  };
  const warehouseOf = (id, field = 'warehouse_id') => {
    const w = db.get('SELECT * FROM warehouses WHERE id = ?', Number(id));
    if (!w) throw badRequest('انبار پیدا نشد.', { [field]: 'پیدا نشد.' });
    return w;
  };
  const ownerName = (id) => (id ? (db.get('SELECT name FROM companies WHERE id = ?', id) || {}).name : 'خودمان');

  function balance(productId, warehouseId, ownerId = null) {
    return db.get('SELECT COALESCE(SUM(units), 0) AS n FROM stock_moves WHERE product_id = ? AND warehouse_id = ? AND owner_company_id IS ?',
      productId, warehouseId, ownerId ?? null).n;
  }

  /**
   * The warehouse goods of a product go to when nobody chose one: the product's own setting,
   * then its company's, then the first active warehouse. Inactive warehouses are skipped.
   */
  function defaultWarehouse({ productWarehouseId = null, companyWarehouseId = null } = {}) {
    for (const id of [productWarehouseId, companyWarehouseId]) {
      if (id && db.get('SELECT 1 FROM warehouses WHERE id = ? AND active = 1', id)) return id;
    }
    const first = db.get('SELECT id FROM warehouses WHERE active = 1 ORDER BY id LIMIT 1');
    if (!first) throw conflict('هیچ انبار فعالی نیست؛ اول یک انبار فعال کنید.');
    return first.id;
  }

  /**
   * Writes one ledger row. Must run inside the caller's transaction (with its audit line).
   * Refuses a balance below zero and new goods into an inactive warehouse (undoing is allowed).
   */
  function move({ productId, warehouseId, ownerId = null, units, kind, lineId = null, arrivalId = null, returnId = null, value = null, note = null, userId = null, reverses = null }) {
    if (!db.inTransaction) throw new Error('stock.move() outside a transaction');
    if (!units) return null;
    if (!KINDS.has(kind)) throw new Error(`unknown stock move kind: ${kind}`);
    const w = warehouseOf(warehouseId);
    if (units > 0 && !w.active && kind !== 'reversal') throw badRequest(`انبار «${w.name}» غیرفعال است؛ کالا را به انبار فعالی ببرید.`, { warehouse_id: 'غیرفعال است.' });
    // Consigned stock belongs to the company the product comes from, or to us (NULL). Any other
    // owner would put the value of its sales on another company's statement.
    const p = db.get('SELECT company_id FROM products WHERE id = ?', productId);
    if (!p) throw badRequest('کالا پیدا نشد.', { product_id: 'پیدا نشد.' });
    if (ownerId !== null && ownerId !== undefined && ownerId !== p.company_id) {
      throw badRequest('صاحب این کالا فقط خودمان یا شرکتی است که کالا مال آن است.', { owner_company_id: 'صاحب کالا درست نیست.' });
    }
    if (units < 0) {
      const have = balance(productId, warehouseId, ownerId);
      if (have + units < 0) {
        const p = db.get('SELECT name FROM products WHERE id = ?', productId);
        throw conflict(`موجودی «${p ? p.name : productId}» در این انبار کافی نیست (موجود: ${have} عدد، لازم: ${-units} عدد).`, undefined, 'insufficient_stock');
      }
    }
    const id = Number(db.run(`INSERT INTO stock_moves (product_id, warehouse_id, owner_company_id, units, kind, order_line_id, arrival_id, return_id, value, reverses, note, user_id, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, warehouseId, ownerId ?? null, units, kind, lineId, arrivalId, returnId, value, reverses, note, userId, nowIso()).lastInsertRowid);
    if (reverses) db.run('UPDATE stock_moves SET reversed_by = ? WHERE id = ?', id, reverses);
    return id;
  }

  /** A line's price was corrected: company-owned units already sent from stock follow it. */
  function revalueSales(lineId, settleUnitPrice, unitsPerSale) {
    if (!db.inTransaction) throw new Error('stock.revalueSales() outside a transaction');
    for (const m of db.all("SELECT id, units FROM stock_moves WHERE order_line_id = ? AND kind = 'ship_out' AND owner_company_id IS NOT NULL AND reversed_by IS NULL", lineId)) {
      db.run('UPDATE stock_moves SET value = ? WHERE id = ?', saleValue(settleUnitPrice, -m.units, unitsPerSale), m.id);
    }
  }

  /**
   * Writes the exact opposite of a ledger row. If the goods it brought in were used since,
   * the refusal says so with `usedMessage`.
   */
  function reverse(m, { userId = null, note, usedMessage } = {}) {
    try {
      return move({
        productId: m.product_id, warehouseId: m.warehouse_id, ownerId: m.owner_company_id, units: -m.units, kind: 'reversal',
        lineId: m.order_line_id, returnId: m.return_id, reverses: m.id, userId, note
      });
    } catch (err) {
      if (usedMessage && err.code === 'insufficient_stock') throw conflict(usedMessage);
      throw err;
    }
  }

  /** Live (not reversed, not a reversal) rows matching a filter, newest first — what an undo takes back. */
  function liveMoves(where, ...params) {
    return db.all(`SELECT * FROM stock_moves WHERE ${where} AND reversed_by IS NULL AND reverses IS NULL ORDER BY id DESC`, ...params);
  }

  /**
   * Stock that can fill an order line of a product: the same product first, then the other
   * variations of the same site product (same company). Company surplus before our own stock
   * (decision 5), then bigger piles.
   */
  function available(productId, { companyOnly = false } = {}) {
    const p = productOf(productId);
    const family = p.parent_woo_id
      ? db.all('SELECT id FROM products WHERE company_id = ? AND parent_woo_id = ?', p.company_id, p.parent_woo_id).map((r) => r.id)
      : [p.id];
    const rows = db.all(`SELECT m.product_id, m.warehouse_id, m.owner_company_id, SUM(m.units) AS units, pr.name AS product_name, pr.units_per_pack,
                           w.name AS warehouse_name, oc.name AS owner_name
                         FROM stock_moves m JOIN products pr ON pr.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
                         LEFT JOIN companies oc ON oc.id = m.owner_company_id
                         WHERE m.product_id IN (${family.map(() => '?').join(',')})
                         GROUP BY m.product_id, m.warehouse_id, m.owner_company_id HAVING SUM(m.units) > 0`, ...family);
    const filtered = rows.filter((r) => (companyOnly ? r.owner_company_id === p.company_id : r.owner_company_id === null || r.owner_company_id === p.company_id));
    return filtered.sort((a, b) =>
      (a.owner_company_id === null) - (b.owner_company_id === null) ||
      (a.product_id !== p.id) - (b.product_id !== p.id) ||
      b.units - a.units);
  }

  /** Default allocation of `units` over the available rows (in the order above). */
  function suggestPicks(productId, units) {
    const picks = [];
    let left = units;
    for (const r of available(productId)) {
      if (left <= 0) break;
      const take = Math.min(left, r.units);
      picks.push({ product_id: r.product_id, warehouse_id: r.warehouse_id, owner_company_id: r.owner_company_id, units: take });
      left -= take;
    }
    return { picks, missing: left };
  }

  /* ------------------------------------------------------------ manual operations (stock page) */
  const suffix = (note) => (note ? ` — ${note}` : '');

  /** Our own goods (bought, not consigned) into a warehouse. */
  function ownIn(actor, { product_id: productId, warehouse_id: warehouseId, units, note }) {
    return db.tx(() => {
      const p = productOf(productId);
      const w = warehouseOf(warehouseId);
      move({ productId: p.id, warehouseId: w.id, units, kind: 'own_in', note, userId: actor.user.id });
      audit(actor, { action: 'stock', entity: 'product', id: p.id, summary: `ورود ${units} عدد «${p.name}» (کالای خودمان) به انبار ${w.name}${suffix(note)}` });
      events.emit('stock', { companyId: p.company_id });
      return { companyId: p.company_id };
    });
  }

  /** Surplus that belongs to a company goes back to it. */
  function returnToCompany(actor, { product_id: productId, warehouse_id: warehouseId, owner_company_id: ownerId, units, note }) {
    return db.tx(() => {
      const p = productOf(productId);
      const w = warehouseOf(warehouseId);
      move({ productId: p.id, warehouseId: w.id, ownerId, units: -units, kind: 'return_to_company', note, userId: actor.user.id });
      audit(actor, { action: 'stock', entity: 'product', id: p.id, summary: `برگشت ${units} عدد «${p.name}» از انبار ${w.name} به ${ownerName(ownerId)}${suffix(note)}` });
      events.emit('stock', { companyId: p.company_id });
      return { companyId: p.company_id };
    });
  }

  function transfer(actor, { product_id: productId, warehouse_id: fromId, to_warehouse_id: toId, owner_company_id: ownerId, units, note }) {
    if (fromId === toId) throw badRequest('انبار مبدأ و مقصد یکی است.', { to_warehouse_id: 'همان انبار مبدأ است.' });
    return db.tx(() => {
      const p = productOf(productId);
      const from = warehouseOf(fromId);
      const to = warehouseOf(toId, 'to_warehouse_id');
      move({ productId: p.id, warehouseId: from.id, ownerId, units: -units, kind: 'transfer_out', note, userId: actor.user.id });
      move({ productId: p.id, warehouseId: to.id, ownerId, units, kind: 'transfer_in', note, userId: actor.user.id });
      audit(actor, { action: 'stock', entity: 'product', id: p.id, summary: `انتقال ${units} عدد «${p.name}» (مال ${ownerName(ownerId)}) از ${from.name} به ${to.name}` });
      events.emit('stock', { companyId: p.company_id });
      return { companyId: p.company_id };
    });
  }

  /** A correction (+ or −), always with a reason. */
  function adjust(actor, { product_id: productId, warehouse_id: warehouseId, owner_company_id: ownerId, units, note }) {
    return db.tx(() => {
      const p = productOf(productId);
      const w = warehouseOf(warehouseId);
      move({ productId: p.id, warehouseId: w.id, ownerId, units, kind: 'adjust', note, userId: actor.user.id });
      audit(actor, { action: 'stock', entity: 'product', id: p.id, summary: `اصلاح موجودی «${p.name}» (مال ${ownerName(ownerId)}) در ${w.name}: ${units > 0 ? '+' : ''}${units} عدد — دلیل: ${note}` });
      events.emit('stock', { companyId: p.company_id });
      return { companyId: p.company_id };
    });
  }

  /**
   * Stocktake of one warehouse: the counted units of each (product, owner) row. Every difference
   * becomes one 'count' correction; rows not sent are left as they are. All or nothing.
   */
  function count(actor, { warehouse_id: warehouseId, counts, note }) {
    return db.tx(() => {
      const w = warehouseOf(warehouseId);
      let changed = 0, plus = 0, minus = 0;
      for (const c of counts) {
        const p = productOf(c.product_id);
        const have = balance(p.id, w.id, c.owner_company_id);
        const diff = c.counted - have;
        if (!diff) continue;
        move({ productId: p.id, warehouseId: w.id, ownerId: c.owner_company_id, units: diff, kind: 'count', userId: actor.user.id,
          note: `انبارگردانی${suffix(note)} (سیستم ${have}، شمارش ${c.counted})` });
        changed++;
        if (diff > 0) plus += diff; else minus -= diff;
      }
      audit(actor, { action: 'stock', entity: 'warehouse', id: w.id, summary: `انبارگردانی ${w.name}: ${counts.length} ردیف شمرده شد، ${changed} ردیف اصلاح شد (${plus} عدد اضافه، ${minus} عدد کم)${suffix(note)}` });
      events.emit('stock', { warehouseId: w.id });
      return { counted: counts.length, changed, plus, minus };
    });
  }

  return {
    balance, defaultWarehouse, move, reverse, revalueSales, liveMoves, available, suggestPicks,
    ownIn, returnToCompany, transfer, adjust, count, saleValue, KIND_LABEL
  };
}

module.exports = { createStock, saleValue, KIND_LABEL };
