'use strict';
/**
 * Whole-database consistency check. Runs nightly after the backup and on demand (manager).
 * Each check returns the rows that break an invariant; an empty report means the books agree.
 * The triggers in migration 005 stop most of these from ever happening; this catches anything
 * that slipped through (an old database, a manual repair, a bug in a guard).
 */
const { nowIso } = require('./util');

const CHECKS = [
  {
    id: 'sqlite', label: 'سلامت فایل دیتابیس',
    run: (db) => db.all('PRAGMA quick_check').map((r) => Object.values(r)[0]).filter((v) => v !== 'ok').map((v) => ({ detail: v }))
  },
  {
    id: 'foreign_keys', label: 'ارجاع‌های شکسته',
    run: (db) => db.all('PRAGMA foreign_key_check').map((r) => ({ detail: `${r.table} #${r.rowid} → ${r.parent}` }))
  },
  {
    id: 'stock_negative', label: 'موجودی منفی',
    run: (db) => db.all(`SELECT product_id, warehouse_id, owner_company_id, SUM(units) AS units FROM stock_moves
                         GROUP BY product_id, warehouse_id, owner_company_id HAVING SUM(units) < 0`)
      .map((r) => ({ detail: `کالا ${r.product_id}، انبار ${r.warehouse_id}، صاحب ${r.owner_company_id ?? 'خودمان'}: ${r.units}` }))
  },
  {
    id: 'reversals', label: 'برگرداندن‌های ناجور',
    // A reversal must be the exact opposite of the row it reverses, and point back both ways
    run: (db) => db.all(`SELECT r.id, r.reverses FROM stock_moves r JOIN stock_moves o ON o.id = r.reverses
                         WHERE r.units <> -o.units OR o.reversed_by IS NOT r.id OR r.product_id <> o.product_id
                            OR r.warehouse_id <> o.warehouse_id OR r.owner_company_id IS NOT o.owner_company_id`)
      .map((r) => ({ detail: `ردیف ${r.id} (برگرداندن ${r.reverses})` }))
  },
  {
    id: 'line_units', label: 'جمع واحدهای ردیف سفارش',
    run: (db) => db.all(`SELECT id FROM order_lines WHERE units_total <> qty * units_per_sale
                           OR (status <> 'pending' AND units_from_company + units_from_stock + units_cancelled <> units_total)
                           OR (status = 'pending' AND units_from_company + units_from_stock + units_cancelled <> 0)`)
      .map((r) => ({ detail: `ردیف سفارش ${r.id}` }))
  },
  {
    id: 'line_stock', label: 'برداشت از انبار برابر ردیف',
    // units_from_stock must equal what the ledger says was taken for that line
    run: (db) => db.all(`SELECT l.id, l.units_from_stock, COALESCE((SELECT SUM(-m.units) FROM stock_moves m WHERE m.order_line_id = l.id
                           AND m.kind = 'ship_out' AND m.reversed_by IS NULL AND m.reverses IS NULL), 0) AS ledger
                         FROM order_lines l WHERE l.status <> 'pending'`)
      .filter((r) => r.units_from_stock !== r.ledger).map((r) => ({ detail: `ردیف ${r.id}: ${r.units_from_stock} در ردیف، ${r.ledger} در دفتر انبار` }))
  },
  {
    id: 'returns', label: 'مرجوعی بیشتر از ارسال',
    run: (db) => db.all(`SELECT l.id, l.units_from_company + l.units_from_stock AS shipped, SUM(r.units) AS returned
                         FROM returns r JOIN order_lines l ON l.id = r.order_line_id WHERE r.voided_at IS NULL
                         GROUP BY l.id HAVING SUM(r.units) > l.units_from_company + l.units_from_stock`)
      .map((r) => ({ detail: `ردیف ${r.id}: ${r.returned} مرجوع از ${r.shipped}` }))
  },
  {
    id: 'statements', label: 'جمع صورت‌حساب‌ها',
    run: (db) => db.all(`SELECT s.id, s.total, s.items, COALESCE(SUM(i.amount), 0) AS sum, COUNT(i.id) AS n,
                           s.sales_total + s.stock_total + s.returns_total + s.adjust_total AS parts
                         FROM statements s LEFT JOIN statement_items i ON i.statement_id = s.id GROUP BY s.id
                         HAVING s.total <> sum OR s.items <> n OR s.total <> parts`)
      .map((r) => ({ detail: `صورت‌حساب ${r.id}: ثبت‌شده ${r.total}، جمع ردیف‌ها ${r.sum}` }))
  },
  {
    id: 'double_billing', label: 'یک قلم در دو صورت‌حساب به‌عنوان اصل',
    // The same key may appear again only as an adjustment
    run: (db) => db.all(`SELECT i.key, COUNT(*) AS n FROM statement_items i JOIN statements s ON s.id = i.statement_id
                         WHERE s.status <> 'void' AND i.section <> 'adjust' GROUP BY s.company_id, i.key HAVING COUNT(*) > 1`)
      .map((r) => ({ detail: `${r.key} ${r.n} بار` }))
  },
  {
    id: 'one_statement', label: 'دو صورت‌حساب فعال برای یک ماه',
    run: (db) => db.all(`SELECT company_id, month, COUNT(*) AS n FROM statements WHERE status <> 'void' GROUP BY company_id, month HAVING COUNT(*) > 1`)
      .map((r) => ({ detail: `شرکت ${r.company_id}، ماه ${r.month}` }))
  }
];

function createIntegrity({ db }) {
  function run() {
    const started = Date.now();
    const results = CHECKS.map((c) => {
      let problems;
      try { problems = c.run(db); } catch (err) { problems = [{ detail: `بررسی انجام نشد: ${err.message}` }]; }
      return { id: c.id, label: c.label, ok: problems.length === 0, problems: problems.slice(0, 50), count: problems.length };
    });
    const report = { at: nowIso(), ms: Date.now() - started, ok: results.every((r) => r.ok), results };
    db.run(`INSERT INTO system_state (key, value, updated_at) VALUES ('integrity', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(report), report.at);
    return report;
  }
  function last() {
    const row = db.get("SELECT value FROM system_state WHERE key = 'integrity'");
    return row ? JSON.parse(row.value) : null;
  }
  return { run, last, CHECKS };
}

module.exports = { createIntegrity };
