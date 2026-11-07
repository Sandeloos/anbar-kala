'use strict';
/** Numbers and lists for the dashboard. */
const { dayStart, tehranDay, monthOf, monthLabel } = require('../lib/jalali');

module.exports = async function dashboardRoutes(app) {
  const { db, sync, statements } = app.ctx;

  app.get('/dashboard', async () => {
    const day = new Date(Date.now() - 864e5).toISOString();
    const p = db.get(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN stock_status = 'outofstock' THEN 1 ELSE 0 END) AS out_of_stock,
        SUM(CASE WHEN configured_at IS NULL THEN 1 ELSE 0 END) AS needs_setup,
        SUM(CASE WHEN units_per_pack > 1 THEN 1 ELSE 0 END) AS multi_packs,
        SUM(CASE WHEN price_source = 'manual' THEN 1 ELSE 0 END) AS manual_prices
      FROM products WHERE removed_at IS NULL`);
    const changes = db.get(`SELECT
        SUM(CASE WHEN price_changed = 1 THEN 1 ELSE 0 END) AS price,
        SUM(CASE WHEN stock_changed = 1 THEN 1 ELSE 0 END) AS stock
      FROM price_history WHERE source <> 'import' AND observed_at >= ?`, day);
    const companies = db.all(`SELECT c.id, c.name, c.site_url, c.active, c.sync_state, c.sync_error, c.last_full_sync_at, c.last_incremental_at,
        c.last_webhook_at, c.woo_key_enc IS NOT NULL AS has_keys,
        (SELECT COUNT(*) FROM products p WHERE p.company_id = c.id AND p.removed_at IS NULL) AS products,
        (SELECT COUNT(*) FROM price_history h JOIN products p ON p.id = h.product_id
           WHERE p.company_id = c.id AND h.price_changed = 1 AND h.source <> 'import' AND h.observed_at >= ?) AS price_changes_24h
      FROM companies c ORDER BY c.active DESC, c.name`, day)
      .map((c) => ({ ...c, active: !!c.active, has_keys: !!c.has_keys, sync_state: sync.isRunning(c.id) ? 'running' : c.sync_state }));
    const recent = db.all(`SELECT h.id, h.product_id, h.regular_price, h.effective_at, h.observed_at, h.source, p.name, c.name AS company_name, c.currency,
        (SELECT h2.regular_price FROM price_history h2 WHERE h2.product_id = h.product_id
           AND (h2.effective_at < h.effective_at OR (h2.effective_at = h.effective_at AND h2.id < h.id)) ORDER BY h2.effective_at DESC, h2.id DESC LIMIT 1) AS prev_regular_price
      FROM price_history h JOIN products p ON p.id = h.product_id JOIN companies c ON c.id = p.company_id
      WHERE h.price_changed = 1 AND h.source <> 'import' ORDER BY h.observed_at DESC, h.id DESC LIMIT 12`);
    const activity = db.all(`SELECT a.id, a.action, a.entity, a.entity_id, a.summary, a.created_at, u.name AS user_name FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.action <> 'login' ORDER BY a.id DESC LIMIT 8`);
    const todayStart = dayStart(tehranDay(new Date().toISOString()).date);
    const ops = {
      orders_today: db.get('SELECT COUNT(*) AS n FROM orders WHERE ordered_at >= ? AND cancelled_at IS NULL', todayStart).n,
      lines_today: db.get('SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.ordered_at >= ? AND o.cancelled_at IS NULL', todayStart).n,
      receiving_due: db.get(`SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
                             WHERE l.status = 'pending' AND o.cancelled_at IS NULL AND o.ordered_at < ?`, todayStart).n,
      received_today: db.get("SELECT COUNT(*) AS n FROM order_lines WHERE status <> 'pending' AND received_at >= ?", todayStart).n,
      consigned_units: db.get('SELECT COALESCE(SUM(units), 0) AS n FROM stock_moves WHERE owner_company_id IS NOT NULL').n,
      own_units: db.get('SELECT COALESCE(SUM(units), 0) AS n FROM stock_moves WHERE owner_company_id IS NULL').n,
      returns_waiting: db.get('SELECT COUNT(*) AS n FROM returns WHERE disposition IS NULL AND voided_at IS NULL').n,
      tasks_open: db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").n
    };
    // Orders per day for the last 14 Tehran days (the chart), and this month's amount per company
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = tehranDay(new Date(Date.now() - i * 864e5).toISOString()).date;
      const start = dayStart(d);
      const end = new Date(new Date(start).getTime() + 864e5).toISOString();
      const r = db.get(`SELECT COUNT(DISTINCT o.id) AS orders, COUNT(l.id) AS lines FROM orders o LEFT JOIN order_lines l ON l.order_id = o.id
                        WHERE o.cancelled_at IS NULL AND o.ordered_at >= ? AND o.ordered_at < ?`, start, end);
      days.push({ date: d, start, orders: r.orders, lines: r.lines });
    }
    const month = monthOf(new Date().toISOString());
    const accounts = db.all('SELECT id, name, currency FROM companies WHERE active = 1 ORDER BY name')
      .map((c) => ({ ...c, month, month_label: monthLabel(month), total: statements.totals(c.id, month).total }));
    return {
      ops, days, accounts,
      products: {
        total: p.total || 0, out_of_stock: p.out_of_stock || 0, needs_setup: p.needs_setup || 0,
        multi_packs: p.multi_packs || 0, manual_prices: p.manual_prices || 0
      },
      changes_24h: { price: changes.price || 0, stock: changes.stock || 0 },
      companies, recent, activity
    };
  });

  /** Lightweight counters for the sidebar badges. */
  app.get('/counts', async () => {
    const day = new Date(Date.now() - 864e5).toISOString();
    return {
      needs_setup: db.get('SELECT COUNT(*) AS n FROM products WHERE removed_at IS NULL AND configured_at IS NULL').n,
      sync_errors: db.get("SELECT COUNT(*) AS n FROM companies WHERE active = 1 AND sync_state = 'error'").n,
      price_changes_24h: db.get("SELECT COUNT(*) AS n FROM price_history WHERE price_changed = 1 AND source <> 'import' AND observed_at >= ?", day).n,
      returns_waiting: db.get('SELECT COUNT(*) AS n FROM returns WHERE disposition IS NULL AND voided_at IS NULL').n,
      tasks_open: db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'open'").n,
      // Lines of orders placed before today that nobody has received yet
      receiving_due: db.get(`SELECT COUNT(*) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
                             WHERE l.status = 'pending' AND o.cancelled_at IS NULL AND o.ordered_at < ?`, dayStart(tehranDay(new Date().toISOString()).date)).n
    };
  });
};
