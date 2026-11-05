-- Engineering hardening: the rules the application already follows, enforced by the database
-- itself so that no bug, script or manual edit can break them. Every guard can be lifted only
-- inside db.maintenance() (a row in `maintenance`), which is for demo/test back-dating and
-- deliberate, reviewed data repairs.
CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1));

/* ------------------------------------------------------------ append-only history */
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER price_history_no_update BEFORE UPDATE ON price_history WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'price_history is append-only'); END;
CREATE TRIGGER price_history_no_delete BEFORE DELETE ON price_history WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'price_history is append-only'); END;

/* ------------------------------------------------------------ the stock ledger */
-- Only the link to the row that reverses it, and the settlement value of a sale, may be filled in later
CREATE TRIGGER stock_moves_frozen BEFORE UPDATE OF product_id, warehouse_id, owner_company_id, units, kind, order_line_id,
  arrival_id, return_id, reverses, created_at, user_id, note ON stock_moves WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'stock_moves rows cannot be changed; write an opposite row'); END;
CREATE TRIGGER stock_moves_reversed_once BEFORE UPDATE OF reversed_by ON stock_moves
  WHEN OLD.reversed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'stock move already reversed'); END;
CREATE TRIGGER stock_moves_no_delete BEFORE DELETE ON stock_moves WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'stock_moves is append-only'); END;
-- Stock of a (product, warehouse, owner) never goes below zero
CREATE TRIGGER stock_never_negative AFTER INSERT ON stock_moves WHEN NEW.units < 0 AND NOT EXISTS (SELECT 1 FROM maintenance)
  AND (SELECT SUM(units) FROM stock_moves WHERE product_id = NEW.product_id AND warehouse_id = NEW.warehouse_id
       AND owner_company_id IS NEW.owner_company_id) < 0
BEGIN SELECT RAISE(ABORT, 'stock below zero'); END;

/* ------------------------------------------------------------ statements stay as issued */
CREATE TRIGGER statement_items_no_update BEFORE UPDATE ON statement_items WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'statement items are frozen'); END;
CREATE TRIGGER statement_items_no_delete BEFORE DELETE ON statement_items WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'statement items are frozen'); END;
CREATE TRIGGER statements_frozen BEFORE UPDATE OF company_id, month, currency, sales_total, stock_total, returns_total, adjust_total,
  total, items, issued_at, issued_by ON statements WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'an issued statement cannot be changed'); END;
-- issued → paid, issued → void; nothing else
CREATE TRIGGER statements_status BEFORE UPDATE OF status ON statements
  WHEN NOT (OLD.status = 'issued' AND NEW.status IN ('paid', 'void')) AND NEW.status <> OLD.status AND NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'statement status can only go from issued to paid or void'); END;
CREATE TRIGGER statements_no_delete BEFORE DELETE ON statements WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'statements are never deleted'); END;

/* ------------------------------------------------------------ nothing important is deleted */
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'orders are cancelled, never deleted'); END;
CREATE TRIGGER order_lines_no_delete BEFORE DELETE ON order_lines WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'order lines are cancelled, never deleted'); END;
CREATE TRIGGER products_no_delete BEFORE DELETE ON products WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'products are marked removed, never deleted'); END;
CREATE TRIGGER companies_no_delete BEFORE DELETE ON companies WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'companies are deactivated, never deleted'); END;
CREATE TRIGGER users_no_delete BEFORE DELETE ON users WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'users are deactivated, never deleted'); END;
CREATE TRIGGER returns_no_delete BEFORE DELETE ON returns WHEN NOT EXISTS (SELECT 1 FROM maintenance)
BEGIN SELECT RAISE(ABORT, 'returns are voided, never deleted'); END;

/* ------------------------------------------------------------ order line arithmetic */
CREATE TRIGGER order_lines_units_insert BEFORE INSERT ON order_lines WHEN NEW.units_total <> NEW.qty * NEW.units_per_sale
BEGIN SELECT RAISE(ABORT, 'units_total must equal qty × units_per_sale'); END;
CREATE TRIGGER order_lines_units_update BEFORE UPDATE ON order_lines
  WHEN NEW.units_total <> NEW.qty * NEW.units_per_sale
    OR (NEW.status <> 'pending' AND NEW.units_from_company + NEW.units_from_stock + NEW.units_cancelled <> NEW.units_total)
    OR (NEW.status = 'pending' AND NEW.units_from_company + NEW.units_from_stock + NEW.units_cancelled <> 0)
BEGIN SELECT RAISE(ABORT, 'received units must add up to the line total'); END;

/* ------------------------------------------------------------ requests that must not run twice */
-- A client sends Idempotency-Key with a POST; a retry with the same key gets the first answer back.
CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,                               -- NULL while the first request is still running
  response TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_time ON idempotency_keys(created_at);

/* ------------------------------------------------------------ small runtime state (integrity check, …) */
CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

/* ------------------------------------------------------------ sync back-off per company */
ALTER TABLE companies ADD COLUMN sync_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN next_sync_at TEXT;

/* ------------------------------------------------------------ indexes for the statement and list queries */
CREATE INDEX order_lines_company_order ON order_lines(company_id, order_id);
CREATE INDEX order_lines_listing ON order_lines(order_id, listing_id);
CREATE INDEX stock_moves_owner_kind ON stock_moves(owner_company_id, kind, order_line_id);
CREATE INDEX stock_moves_return ON stock_moves(return_id);
CREATE INDEX returns_company ON returns(company_id, disposition, voided_at);
CREATE INDEX arrivals_company_time ON arrivals(company_id, created_at);
CREATE INDEX orders_platform_time ON orders(platform_id, ordered_at);
CREATE INDEX audit_action_time ON audit_log(action, created_at DESC);
CREATE INDEX order_lines_received ON order_lines(company_id, received_at) WHERE received_at IS NOT NULL;

/* ------------------------------------------------------------ optimistic locking for edited records */
ALTER TABLE companies ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE listings ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE warehouses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
