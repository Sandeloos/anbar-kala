'use strict';
/**
 * Customer returns (decision 5 and the owner's answers):
 *  - A returned item comes into our warehouse as OUR stock; the sale stays on the company's
 *    statement (the company was paid for it).
 *  - Then someone decides: kept (we may sell it again from our stock), to_company (sent back →
 *    credited on the statement of the month this was decided), damaged (written off).
 *  - Only units the company was paid for can go back to it for a credit: units it shipped
 *    plus units taken from its surplus in our warehouse.
 */
const { nowIso, inFuture, badRequest, notFound, conflict } = require('./util');
const { tehranDay } = require('./jalali');

const DISPOSITION_LABEL = { kept: 'نگه داشتیم (قابل فروش)', to_company: 'برگشت به شرکت', damaged: 'معیوب' };

function createReturns({ db, orders, stock, events, audit }) {
  function returnRow(id) {
    const r = db.get(`SELECT r.*, p.name AS product_name, c.name AS company_name, c.currency, w.name AS warehouse_name, l.order_id, l.units_per_sale,
                        l.settle_unit_price, o.order_number, o.ordered_at, pl.name AS platform_name, u.name AS user_name, du.name AS disposition_by_name
                      FROM returns r JOIN products p ON p.id = r.product_id JOIN companies c ON c.id = r.company_id JOIN warehouses w ON w.id = r.warehouse_id
                      JOIN order_lines l ON l.id = r.order_line_id JOIN orders o ON o.id = l.order_id JOIN platforms pl ON pl.id = o.platform_id
                      LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users du ON du.id = r.disposition_by WHERE r.id = ?`, Number(id));
    if (!r) throw notFound('مرجوعی پیدا نشد.');
    return r;
  }

  /** How many units of a line were shipped, returned, and could be credited to the company. */
  function lineCounts(lineId) {
    const l = orders.lineRow(lineId);
    const shipped = l.units_from_company + l.units_from_stock;
    const returned = db.get('SELECT COALESCE(SUM(units), 0) AS n FROM returns WHERE order_line_id = ? AND voided_at IS NULL', l.id).n;
    const fromCompanyStock = db.get(`SELECT COALESCE(SUM(-units), 0) AS n FROM stock_moves WHERE order_line_id = ? AND kind = 'ship_out'
                                     AND owner_company_id = ? AND reversed_by IS NULL AND reverses IS NULL`, l.id, l.company_id).n;
    const billable = l.units_from_company + fromCompanyStock;
    const credited = db.get("SELECT COALESCE(SUM(units), 0) AS n FROM returns WHERE order_line_id = ? AND disposition = 'to_company' AND voided_at IS NULL", l.id).n;
    return { line: l, shipped, returned, returnable: shipped - returned, billable, credited, creditable: billable - credited };
  }

  function create(req, lineId, { units, warehouse_id: warehouseId, reason, returned_at: returnedAt }) {
    const userId = req.user ? req.user.id : null;
    const id = db.tx(() => {
      const c = lineCounts(lineId);
      const l = c.line;
      if (l.status !== 'done' || !c.shipped) throw conflict('این ردیف ارسال نشده که مرجوع شود.');
      if (!Number.isInteger(units) || units < 1) throw badRequest('تعداد مرجوعی را درست وارد کنید.', { units: 'عدد صحیح' });
      if (units > c.returnable) throw badRequest(`از این ردیف حداکثر ${c.returnable} عدد قابل مرجوع است (${c.shipped} ارسال شده، ${c.returned} قبلاً مرجوع شده).`, { units: `حداکثر ${c.returnable}` });
      const wh = warehouseId || stock.defaultWarehouse({ productWarehouseId: l.product_warehouse_id, companyWarehouseId: l.company_warehouse_id });
      // A return arrives after the goods left (received_at, or the order time) and not in the future
      const at = returnedAt || nowIso();
      if (inFuture(at)) throw badRequest('تاریخ رسیدن مرجوعی نمی‌تواند در آینده باشد.', { returned_at: 'در آینده است.' });
      const shippedAt = l.received_at || l.ordered_at;
      // Compared by Tehran calendar day: a date typed without a time (midnight) on the shipping day is fine
      if (shippedAt && tehranDay(at).date < tehranDay(shippedAt).date) throw badRequest('تاریخ رسیدن مرجوعی نمی‌تواند قبل از ارسال سفارش باشد.', { returned_at: 'قبل از ارسال است.' });
      const rid = Number(db.run(`INSERT INTO returns (order_line_id, company_id, product_id, units, warehouse_id, reason, returned_at, user_id, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, l.id, l.company_id, l.product_id, units, wh, reason || null, at, userId, nowIso()).lastInsertRowid);
      stock.move({ productId: l.product_id, warehouseId: wh, ownerId: null, units, kind: 'return_in', lineId: l.id, returnId: rid, userId, note: reason || 'مرجوعی مشتری' });
      audit(req, {
        action: 'create', entity: 'return', id: rid,
        summary: `مرجوعی ${units} عدد «${l.product_name}» (${l.platform_name}${l.order_number ? ` ${l.order_number}` : ''}) به انبار رسید${reason ? ` — ${reason}` : ''}`
      });
      return rid;
    });
    events.emit('returns', { ids: [id] });
    events.emit('stock', {});
    return returnRow(id);
  }

  function decide(req, id, { disposition, note }) {
    const userId = req.user ? req.user.id : null;
    db.tx(() => {
      const r = returnRow(id);
      if (r.voided_at) throw conflict('این مرجوعی باطل شده است.');
      if (r.disposition) throw conflict('برای این مرجوعی قبلاً تصمیم گرفته شده؛ اول آن را برگردانید.');
      let value = null;
      if (disposition === 'to_company') {
        const c = lineCounts(r.order_line_id);
        if (r.units > c.creditable) {
          throw conflict(c.creditable
            ? `فقط ${c.creditable} عدد از این ردیف را شرکت فرستاده یا از اضافه‌های خودش برداشته شده؛ بقیه کالای خودمان بوده و برگشت به شرکت ندارد.`
            : 'این ردیف از کالای خودمان ارسال شده بود؛ برگشت به شرکت ندارد. «نگه داشتیم» یا «معیوب» را بزنید.');
        }
        value = stock.saleValue(r.settle_unit_price, r.units, r.units_per_sale);
        stock.move({ productId: r.product_id, warehouseId: r.warehouse_id, ownerId: null, units: -r.units, kind: 'return_to_company', lineId: r.order_line_id, returnId: r.id, value, userId, note: note || 'مرجوعی برگشت به شرکت' });
      } else if (disposition === 'damaged') {
        stock.move({ productId: r.product_id, warehouseId: r.warehouse_id, ownerId: null, units: -r.units, kind: 'write_off', lineId: r.order_line_id, returnId: r.id, userId, note: note || 'مرجوعی معیوب' });
      } else if (disposition !== 'kept') {
        throw badRequest('تصمیم را انتخاب کنید.');
      }
      db.run(`UPDATE returns SET disposition = ?, disposition_at = ?, disposition_by = ?, disposition_note = ?, value = ? WHERE id = ?`,
        disposition, nowIso(), userId, note || null, value, r.id);
      audit(req, {
        action: 'decide', entity: 'return', id: r.id,
        summary: `مرجوعی ${r.units} عدد «${r.product_name}»: ${DISPOSITION_LABEL[disposition]}${value ? ` (کسر از حساب ${r.company_name} در صورت‌حساب این ماه)` : ''}${note ? ` — ${note}` : ''}`
      });
    });
    events.emit('returns', { ids: [Number(id)] });
    events.emit('stock', {});
    return returnRow(id);
  }

  /** Takes a decision back (not when it is already on an issued statement). */
  function undoDecision(req, id) {
    const userId = req.user ? req.user.id : null;
    db.tx(() => {
      const r = returnRow(id);
      if (!r.disposition) throw conflict('برای این مرجوعی هنوز تصمیمی گرفته نشده.');
      const billed = db.get(`SELECT s.month FROM statement_items si JOIN statements s ON s.id = si.statement_id
                             WHERE si.key = ? AND s.status <> 'void'`, `R${r.id}`);
      if (billed) throw conflict(`این برگشت در صورت‌حساب صادرشده‌ی ماه ${billed.month} آمده است؛ نمی‌شود برگرداندش.`);
      for (const m of stock.liveMoves("return_id = ? AND kind <> 'return_in'", r.id)) stock.reverse(m, { userId, note: 'برگرداندن تصمیم مرجوعی' });
      db.run('UPDATE returns SET disposition = NULL, disposition_at = NULL, disposition_by = NULL, disposition_note = NULL, value = NULL WHERE id = ?', r.id);
      audit(req, { action: 'undo', entity: 'return', id: r.id, summary: `برگرداندن تصمیم مرجوعی «${r.product_name}» (قبلاً: ${DISPOSITION_LABEL[r.disposition]})` });
    });
    events.emit('returns', { ids: [Number(id)] });
    events.emit('stock', {});
    return returnRow(id);
  }

  /** Cancels a return recorded by mistake (only while nothing was decided). */
  function voidReturn(req, id, reason) {
    if (!reason) throw badRequest('دلیل را بنویسید.', { reason: 'لازم است' });
    const userId = req.user ? req.user.id : null;
    db.tx(() => {
      const r = returnRow(id);
      if (r.voided_at) throw conflict('این مرجوعی قبلاً باطل شده است.');
      if (r.disposition) throw conflict('اول تصمیم این مرجوعی را برگردانید.');
      for (const m of stock.liveMoves("return_id = ? AND kind = 'return_in'", r.id)) {
        stock.reverse(m, { userId, note: 'ابطال مرجوعی', usedMessage: 'این کالای مرجوعی از انبار برداشته شده (مثلاً برای سفارش دیگری)؛ اول آن را برگردانید.' });
      }
      db.run('UPDATE returns SET voided_at = ?, void_reason = ? WHERE id = ?', nowIso(), reason, r.id);
      audit(req, { action: 'void', entity: 'return', id: r.id, summary: `ابطال مرجوعی «${r.product_name}» — دلیل: ${reason}` });
    });
    events.emit('returns', { ids: [Number(id)] });
    events.emit('stock', {});
    return returnRow(id);
  }

  function list({ status = 'waiting', company, q } = {}) {
    const where = [];
    const params = [];
    if (status === 'waiting') where.push('r.disposition IS NULL AND r.voided_at IS NULL');
    else if (status === 'done') where.push('r.disposition IS NOT NULL AND r.voided_at IS NULL');
    else if (status === 'void') where.push('r.voided_at IS NOT NULL');
    if (company) { where.push('r.company_id = ?'); params.push(Number(company)); }
    if (q) { where.push('(o.order_number LIKE ? OR p.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    return db.all(`SELECT r.*, p.name AS product_name, c.name AS company_name, c.currency, w.name AS warehouse_name, l.order_id, l.units_per_sale,
                     l.settle_unit_price, o.order_number, o.ordered_at, pl.name AS platform_name, u.name AS user_name, du.name AS disposition_by_name,
                     CAST((julianday('now') - julianday(r.returned_at)) AS INTEGER) AS age_days
                   FROM returns r JOIN products p ON p.id = r.product_id JOIN companies c ON c.id = r.company_id JOIN warehouses w ON w.id = r.warehouse_id
                   JOIN order_lines l ON l.id = r.order_line_id JOIN orders o ON o.id = l.order_id JOIN platforms pl ON pl.id = o.platform_id
                   LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users du ON du.id = r.disposition_by
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${status === 'waiting' ? 'r.returned_at' : 'COALESCE(r.disposition_at, r.created_at) DESC'} LIMIT 500`, ...params);
  }

  return { create, decide, undoDecision, voidReturn, list, lineCounts, returnRow, DISPOSITION_LABEL };
}

module.exports = { createReturns, DISPOSITION_LABEL };
