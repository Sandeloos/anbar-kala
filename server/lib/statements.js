'use strict';
/**
 * Monthly settlement statements per company (Jalali months).
 *
 * Billable things, each with a stable key:
 *   L<line>   units the company itself shipped for an order line, at the line's amount per sale
 *   M<move>   units sent from the company's surplus in our warehouse (case 4), at their stored value
 *   R<return> a customer return sent back to the company: a credit (negative)
 * A thing belongs to a month: the order's month (L, M) or the month the return was decided (R).
 *
 * Draft for month M = everything of month M not billed yet, plus ADJUSTMENTS: for anything of an
 * earlier month, the difference between what it is worth now and what earlier issued statements
 * billed for it (a line received late, a price corrected, a receiving undone). Issued statements
 * never change (decision 1); voiding one (manager, with a reason) un-bills its items.
 */
const ExcelJS = require('exceljs');
const { nowIso, badRequest, notFound, conflict, CURRENCIES, fromRial } = require('./util');
const { monthOf, monthBounds, monthLabel, isMonth, jalaliDateTime } = require('./jalali');

const SECTIONS = {
  sales: 'فروش‌های ارسال‌شده از کالای شرکت',
  stock: 'ارسال از اضافه‌های شرکت در انبار ما',
  returns: 'مرجوعی‌های برگشت‌داده‌شده به شرکت',
  adjust: 'اصلاحیه‌ی ماه‌های قبل'
};

function createStatements({ db, audit, events }) {
  const company = (id) => {
    const c = db.get('SELECT * FROM companies WHERE id = ?', Number(id));
    if (!c) throw notFound('شرکت پیدا نشد.');
    return c;
  };

  /** What everything of this company up to the end of `month` is worth right now. */
  function currentItems(companyId, month) {
    const { end } = monthBounds(month);
    const items = [];
    for (const l of db.all(`SELECT l.id, l.order_id, l.units_from_company, l.units_per_sale, l.settle_unit_price, l.settle_manual, o.ordered_at, o.order_number,
                              pl.name AS platform_name, p.name AS product_name
                            FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN platforms pl ON pl.id = o.platform_id JOIN products p ON p.id = l.product_id
                            WHERE l.company_id = ? AND l.units_from_company > 0 AND o.ordered_at < ?`, companyId, end)) {
      const sales = l.units_from_company / l.units_per_sale;
      items.push({
        key: `L${l.id}`, kind: 'sale', section: 'sales', item_month: monthOf(l.ordered_at), order_id: l.order_id, order_line_id: l.id,
        product_name: l.product_name, platform_name: l.platform_name, order_number: l.order_number, ordered_at: l.ordered_at,
        units: l.units_from_company, sales, unit_price: l.settle_unit_price, amount: Math.round(sales * l.settle_unit_price),
        note: l.settle_manual ? 'مبلغ دستی' : null
      });
    }
    for (const m of db.all(`SELECT m.id, m.units, m.value, l.id AS line_id, l.order_id, l.units_per_sale, l.settle_unit_price, o.ordered_at, o.order_number,
                              pl.name AS platform_name, p.name AS product_name
                            FROM stock_moves m JOIN order_lines l ON l.id = m.order_line_id JOIN orders o ON o.id = l.order_id
                            JOIN platforms pl ON pl.id = o.platform_id JOIN products p ON p.id = m.product_id
                            WHERE m.kind = 'ship_out' AND m.owner_company_id = ? AND m.reversed_by IS NULL AND m.reverses IS NULL AND o.ordered_at < ?`, companyId, end)) {
      items.push({
        key: `M${m.id}`, kind: 'stock_sale', section: 'stock', item_month: monthOf(m.ordered_at), order_id: m.order_id, order_line_id: m.line_id, move_id: m.id,
        product_name: m.product_name, platform_name: m.platform_name, order_number: m.order_number, ordered_at: m.ordered_at,
        units: -m.units, sales: -m.units / m.units_per_sale, unit_price: m.settle_unit_price, amount: m.value || 0
      });
    }
    for (const r of db.all(`SELECT r.id, r.units, r.value, r.disposition_at, l.order_id, l.id AS line_id, l.units_per_sale, l.settle_unit_price, o.ordered_at,
                              o.order_number, pl.name AS platform_name, p.name AS product_name
                            FROM returns r JOIN order_lines l ON l.id = r.order_line_id JOIN orders o ON o.id = l.order_id
                            JOIN platforms pl ON pl.id = o.platform_id JOIN products p ON p.id = r.product_id
                            WHERE r.company_id = ? AND r.disposition = 'to_company' AND r.voided_at IS NULL AND r.disposition_at < ?`, companyId, end)) {
      items.push({
        key: `R${r.id}`, kind: 'return', section: 'returns', item_month: monthOf(r.disposition_at), order_id: r.order_id, order_line_id: r.line_id, return_id: r.id,
        product_name: r.product_name, platform_name: r.platform_name, order_number: r.order_number, ordered_at: r.ordered_at,
        units: r.units, sales: r.units / r.units_per_sale, unit_price: -r.settle_unit_price, amount: -(r.value || 0), note: `مرجوعی، برگشت در ${monthLabel(monthOf(r.disposition_at))}`
      });
    }
    return items;
  }

  /** What issued (not void) statements already billed, per key. */
  function billed(companyId, { exceptStatement } = {}) {
    const map = new Map();
    for (const r of db.all(`SELECT si.key, SUM(si.amount) AS amount, MAX(si.item_month) AS item_month, MAX(si.product_name) AS product_name, MAX(si.order_number) AS order_number,
                              MAX(si.platform_name) AS platform_name, MAX(si.ordered_at) AS ordered_at, MAX(si.kind) AS kind, MAX(si.order_id) AS order_id, MAX(si.order_line_id) AS order_line_id
                            FROM statement_items si JOIN statements s ON s.id = si.statement_id
                            WHERE s.company_id = ? AND s.status <> 'void' AND s.id <> ? GROUP BY si.key`, companyId, exceptStatement || 0)) {
      map.set(r.key, r);
    }
    return map;
  }

  /** The statement content for a month: from current data (draft) — what issuing would freeze. */
  function compute(companyId, month) {
    const items = currentItems(companyId, month);
    const done = billed(companyId);
    const sections = { sales: [], stock: [], returns: [], adjust: [] };
    const seen = new Set();
    for (const it of items) {
      seen.add(it.key);
      const before = done.has(it.key) ? done.get(it.key).amount : 0;
      const diff = it.amount - before;
      if (it.item_month === month) {
        if (diff !== 0) sections[it.section].push({ ...it, amount: diff, previous: before });
      } else if (it.item_month < month && diff !== 0) {
        sections.adjust.push({
          ...it, section: 'adjust', amount: diff, previous: before,
          note: before === 0 ? `مربوط به ${monthLabel(it.item_month)}؛ بعد از صورت‌حساب آن ماه ثبت یا دریافت شد` : `مربوط به ${monthLabel(it.item_month)}؛ مبلغ تغییر کرد`
        });
      }
    }
    // Billed before, worth nothing now (receiving undone, line cancelled, return voided…)
    for (const [key, b] of done) {
      if (seen.has(key) || !b.amount || b.item_month > month) continue;
      sections.adjust.push({
        key, kind: b.kind, section: 'adjust', item_month: b.item_month, order_id: b.order_id, order_line_id: b.order_line_id, product_name: b.product_name,
        platform_name: b.platform_name, order_number: b.order_number, ordered_at: b.ordered_at, units: 0, sales: 0, unit_price: null,
        amount: -b.amount, previous: b.amount, note: `مربوط به ${monthLabel(b.item_month)}؛ برگردانده یا لغو شد`
      });
    }
    for (const s of Object.values(sections)) s.sort((a, b) => String(a.ordered_at || '').localeCompare(String(b.ordered_at || '')) || a.key.localeCompare(b.key));
    const sum = (list) => list.reduce((t, i) => t + i.amount, 0);
    const totals = { sales: sum(sections.sales), stock: sum(sections.stock), returns: sum(sections.returns), adjust: sum(sections.adjust) };
    totals.total = totals.sales + totals.stock + totals.returns + totals.adjust;
    return { sections, totals };
  }

  /** Facts shown next to the money: what is still open, surplus movements, stock left. */
  function facts(companyId, month) {
    const { start, end } = monthBounds(month);
    const pending = db.get(`SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
                            WHERE l.company_id = ? AND l.status = 'pending' AND o.cancelled_at IS NULL AND o.ordered_at >= ? AND o.ordered_at < ?`, companyId, start, end).n;
    const returnsWaiting = db.get('SELECT COUNT(*) AS n FROM returns WHERE company_id = ? AND disposition IS NULL AND voided_at IS NULL', companyId).n;
    const surplusIn = db.get(`SELECT COALESCE(SUM(units), 0) AS n FROM stock_moves WHERE owner_company_id = ? AND kind IN ('surplus_in', 'wrong_in')
                              AND reversed_by IS NULL AND created_at >= ? AND created_at < ?`, companyId, start, end).n;
    const surplusBack = db.get(`SELECT COALESCE(SUM(-units), 0) AS n FROM stock_moves WHERE owner_company_id = ? AND kind = 'return_to_company'
                                AND reversed_by IS NULL AND created_at >= ? AND created_at < ?`, companyId, start, end).n;
    const consigned = db.get('SELECT COALESCE(SUM(units), 0) AS n FROM stock_moves WHERE owner_company_id = ? AND created_at < ?', companyId, end).n;
    const orders = db.get(`SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_lines l ON l.order_id = o.id
                           WHERE l.company_id = ? AND o.cancelled_at IS NULL AND o.ordered_at >= ? AND o.ordered_at < ?`, companyId, start, end).n;
    return { pending_lines: pending, returns_waiting: returnsWaiting, surplus_in_units: surplusIn, surplus_back_units: surplusBack, consigned_units: consigned, orders };
  }

  const active = (companyId, month) => db.get("SELECT * FROM statements WHERE company_id = ? AND month = ? AND status <> 'void'", companyId, month);
  const itemsOf = (statementId) => db.all('SELECT * FROM statement_items WHERE statement_id = ? ORDER BY id', statementId);
  function group(items) {
    const sections = { sales: [], stock: [], returns: [], adjust: [] };
    for (const i of items) sections[i.section].push(i);
    return sections;
  }

  /** A month for a company: the issued statement if there is one, otherwise the draft. */
  function view(companyId, month) {
    if (!isMonth(month)) throw badRequest('ماه معتبر نیست.');
    const c = company(companyId);
    const issued = active(c.id, month);
    const base = { company: { id: c.id, name: c.name, currency: c.currency }, month, month_label: monthLabel(month), facts: facts(c.id, month) };
    const history = db.all(`SELECT s.id, s.month, s.status, s.total, s.issued_at, s.paid_at, s.void_at FROM statements s WHERE s.company_id = ? ORDER BY s.month DESC, s.id DESC`, c.id);
    if (issued) {
      const sections = group(itemsOf(issued.id));
      return {
        ...base, history, statement: { ...issued, ...people(issued) }, sections,
        totals: { sales: issued.sales_total, stock: issued.stock_total, returns: issued.returns_total, adjust: issued.adjust_total, total: issued.total },
        // Changes to this month (or earlier) after issuing: they go to the next statement as adjustments
        changes_since: compute(c.id, month).totals.total
      };
    }
    const { sections, totals } = compute(c.id, month);
    const ended = monthBounds(month).end <= nowIso();
    const earlierDrafts = db.all(`SELECT DISTINCT month FROM statements WHERE company_id = ? AND status <> 'void'`, c.id).map((r) => r.month);
    return { ...base, history, statement: null, sections, totals, ended, issued_months: earlierDrafts };
  }
  function people(s) {
    const name = (id) => (id ? (db.get('SELECT name FROM users WHERE id = ?', id) || {}).name : null);
    return { issued_by_name: name(s.issued_by), paid_by_name: name(s.paid_by), void_by_name: name(s.void_by) };
  }

  function issue(req, companyId, month, note) {
    if (!isMonth(month)) throw badRequest('ماه معتبر نیست.');
    const c = company(companyId);
    if (monthBounds(month).end > nowIso()) throw badRequest(`ماه ${monthLabel(month)} هنوز تمام نشده؛ صورت‌حساب بعد از پایان ماه صادر می‌شود.`);
    const id = db.tx(() => {
      if (active(c.id, month)) throw conflict(`صورت‌حساب ${monthLabel(month)} برای ${c.name} قبلاً صادر شده است.`);
      const later = db.get("SELECT month FROM statements WHERE company_id = ? AND month > ? AND status <> 'void' ORDER BY month LIMIT 1", c.id, month);
      if (later) throw conflict(`صورت‌حساب ماه بعد (${monthLabel(later.month)}) صادر شده؛ تغییرات این ماه به‌صورت اصلاحیه در صورت‌حساب‌های بعدی می‌آید.`);
      const { sections, totals } = compute(c.id, month);
      const all = Object.values(sections).flat();
      const sid = Number(db.run(`INSERT INTO statements (company_id, month, status, currency, sales_total, stock_total, returns_total, adjust_total, total, items, note, issued_at, issued_by)
                                 VALUES (?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, month, c.currency, totals.sales, totals.stock, totals.returns, totals.adjust, totals.total, all.length, note || null, nowIso(), req.user.id).lastInsertRowid);
      for (const i of all) {
        db.run(`INSERT INTO statement_items (statement_id, key, section, kind, item_month, order_id, order_line_id, return_id, move_id, product_name, platform_name,
                  order_number, ordered_at, units, sales, unit_price, amount, previous, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sid, i.key, i.section, i.kind, i.item_month, i.order_id ?? null, i.order_line_id ?? null, i.return_id ?? null, i.move_id ?? null, i.product_name, i.platform_name,
        i.order_number, i.ordered_at, i.units, i.sales, i.unit_price, i.amount, i.previous || 0, i.note || null);
      }
      audit(req, {
        action: 'issue', entity: 'statement', id: sid,
        summary: `صدور صورت‌حساب ${monthLabel(month)} برای ${c.name}: جمع ${fromRial(totals.total, c.currency).toLocaleString('en-US')} ${CURRENCIES[c.currency]} (${all.length} ردیف)`
      });
      return sid;
    });
    events.emit('statements', { companyId: c.id, month });
    return id;
  }

  function markPaid(req, id, { reference, paid_at: paidAt }) {
    const s = db.get('SELECT * FROM statements WHERE id = ?', Number(id));
    if (!s) throw notFound('صورت‌حساب پیدا نشد.');
    if (s.status !== 'issued') throw conflict(s.status === 'paid' ? 'این صورت‌حساب قبلاً تسویه شده است.' : 'این صورت‌حساب باطل شده است.');
    const c = company(s.company_id);
    db.run("UPDATE statements SET status = 'paid', paid_at = ?, paid_reference = ?, paid_by = ? WHERE id = ?", paidAt || nowIso(), reference || null, req.user.id, s.id);
    audit(req, { action: 'paid', entity: 'statement', id: s.id, summary: `تسویه‌ی صورت‌حساب ${monthLabel(s.month)} ${c.name}${reference ? ` — ${reference}` : ''}` });
    events.emit('statements', { companyId: s.company_id, month: s.month });
  }

  /** Manager only: the latest issued statement of a company can be voided (its items become unbilled again). */
  function voidStatement(req, id, reason) {
    if (!reason) throw badRequest('دلیل ابطال را بنویسید.', { reason: 'لازم است' });
    const s = db.get('SELECT * FROM statements WHERE id = ?', Number(id));
    if (!s) throw notFound('صورت‌حساب پیدا نشد.');
    if (s.status === 'void') throw conflict('این صورت‌حساب قبلاً باطل شده است.');
    if (s.status === 'paid') throw conflict('صورت‌حساب تسویه‌شده باطل نمی‌شود؛ تفاوت را با اصلاحیه در ماه بعد حساب کنید.');
    const later = db.get("SELECT month FROM statements WHERE company_id = ? AND month > ? AND status <> 'void'", s.company_id, s.month);
    if (later) throw conflict(`اول صورت‌حساب ${monthLabel(later.month)} را باطل کنید؛ فقط آخرین صورت‌حساب باطل می‌شود.`);
    const c = company(s.company_id);
    db.run("UPDATE statements SET status = 'void', void_at = ?, void_reason = ?, void_by = ? WHERE id = ?", nowIso(), reason, req.user.id, s.id);
    audit(req, { action: 'void', entity: 'statement', id: s.id, summary: `ابطال صورت‌حساب ${monthLabel(s.month)} ${c.name} — دلیل: ${reason}` });
    events.emit('statements', { companyId: s.company_id, month: s.month });
  }

  /** One row per active company: last month's draft or statement, unpaid statements. */
  function overview() {
    const now = nowIso();
    const thisMonth = monthOf(now);
    const [y, m] = thisMonth.split('-').map(Number);
    const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    return db.all('SELECT * FROM companies WHERE active = 1 ORDER BY name').map((c) => {
      const s = active(c.id, lastMonth);
      const draftLast = s ? null : compute(c.id, lastMonth).totals.total;
      const draftThis = compute(c.id, thisMonth).totals.total;
      const unpaid = db.all("SELECT id, month, total FROM statements WHERE company_id = ? AND status = 'issued' ORDER BY month", c.id);
      return {
        id: c.id, name: c.name, currency: c.currency, last_month: lastMonth, last_month_label: monthLabel(lastMonth), this_month: thisMonth, this_month_label: monthLabel(thisMonth),
        last_statement: s ? { id: s.id, status: s.status, total: s.total } : null, last_draft_total: draftLast, this_month_total: draftThis, unpaid
      };
    });
  }

  /* ------------------------------------------------------------ Excel */
  async function excel(companyId, month) {
    const v = view(companyId, month);
    const cur = v.company.currency;
    const money = (r) => (r === null || r === undefined ? null : fromRial(r, cur));
    const wb = new ExcelJS.Workbook();
    wb.creator = 'انبار';
    const ws = wb.addWorksheet('صورت‌حساب', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 0 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.columns = [
      { key: 'n', width: 6 }, { key: 'date', width: 18 }, { key: 'platform', width: 12 }, { key: 'number', width: 16 }, { key: 'product', width: 46 },
      { key: 'units', width: 10 }, { key: 'sales', width: 10 }, { key: 'price', width: 16 }, { key: 'amount', width: 18 }, { key: 'note', width: 40 }
    ];
    const title = ws.addRow([`صورت‌حساب ${v.month_label} — ${v.company.name}`]);
    title.font = { bold: true, size: 15 };
    ws.mergeCells(title.number, 1, title.number, 10);
    const status = v.statement ? (v.statement.status === 'paid' ? `تسویه‌شده (${jalaliDateTime(v.statement.paid_at)})` : v.statement.status === 'void' ? 'باطل‌شده' : `صادرشده در ${jalaliDateTime(v.statement.issued_at)}`) : 'پیش‌نویس (هنوز صادر نشده)';
    ws.addRow([`وضعیت: ${status}`]).font = { color: { argb: 'FF5D6483' } };
    ws.addRow([`مبالغ به ${CURRENCIES[cur]}؛ قیمت‌ها قیمت سایت شرکت (قبل از تخفیف) در ساعت ثبت هر سفارش است.`]).font = { color: { argb: 'FF5D6483' } };
    ws.addRow([]);
    const head = ['ردیف', 'زمان سفارش', 'پلتفرم', 'شماره سفارش', 'کالا', 'تعداد عدد', 'تعداد فروش', `مبلغ هر فروش`, `مبلغ`, 'توضیح'];
    const numFmt = '#,##0;[Red]-#,##0';
    for (const [key, label] of Object.entries(SECTIONS)) {
      const list = v.sections[key];
      if (!list.length) continue;
      const sec = ws.addRow([label]);
      sec.font = { bold: true, size: 12, color: { argb: 'FF0F1A4F' } };
      ws.mergeCells(sec.number, 1, sec.number, 10);
      const h = ws.addRow(head);
      h.font = { bold: true };
      h.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEFC' } }; cell.border = { bottom: { style: 'thin', color: { argb: 'FFC9D1E6' } } }; });
      list.forEach((i, n) => {
        const r = ws.addRow([n + 1, i.ordered_at ? jalaliDateTime(i.ordered_at) : '', i.platform_name || '', i.order_number || '', i.product_name || '', i.units,
          i.sales === null || i.sales === undefined ? null : Math.round(i.sales * 100) / 100, money(i.unit_price), money(i.amount), i.note || (key === 'adjust' && i.previous ? `قبلاً ${money(i.previous).toLocaleString('en-US')}` : '')]);
        r.getCell(8).numFmt = numFmt;
        r.getCell(9).numFmt = numFmt;
      });
      const sumRow = ws.addRow(['', '', '', '', `جمع ${label}`, '', '', '', money(v.totals[key])]);
      sumRow.font = { bold: true };
      sumRow.getCell(9).numFmt = numFmt;
      ws.addRow([]);
    }
    const total = ws.addRow(['', '', '', '', 'مبلغ قابل پرداخت به شرکت', '', '', '', money(v.totals.total)]);
    total.font = { bold: true, size: 13 };
    total.getCell(9).numFmt = numFmt;
    total.getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0E3' } };
    ws.addRow([]);
    const f = v.facts;
    for (const line of [
      `سفارش‌های این ماه: ${f.orders}`,
      f.pending_lines ? `ردیف‌های این ماه که هنوز دریافت نشده‌اند (در این صورت‌حساب نیستند): ${f.pending_lines}` : null,
      `اضافه‌های رسیده در این ماه: ${f.surplus_in_units} عدد — برگشت اضافه‌ها به شرکت: ${f.surplus_back_units} عدد`,
      `کالای این شرکت در انبار ما در پایان ماه: ${f.consigned_units} عدد`
    ].filter(Boolean)) ws.addRow([line]).font = { color: { argb: 'FF5D6483' } };
    ws.eachRow((row) => { row.alignment = { vertical: 'middle', horizontal: 'right', readingOrder: 'rtl', wrapText: false }; });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  return { compute, view, issue, markPaid, voidStatement, overview, excel, currentItems, SECTIONS };
}

module.exports = { createStatements, SECTIONS };
