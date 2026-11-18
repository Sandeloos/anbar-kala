-- Independent operational records; settlement and stock remain owned by orders/stock.
CREATE TABLE dk_reference_requests (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL UNIQUE REFERENCES dk_jobs(id),
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  target_price INTEGER NOT NULL,
  ticket_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO dk_reference_requests (job_id, listing_id, target_price, ticket_id, status, error, created_at, updated_at)
SELECT id, listing_id, target_price, json_extract(result, '$.ticket.id'),
  CASE WHEN json_extract(result, '$.ticket.id') IS NOT NULL THEN 'submitted' ELSE 'pending' END,
  json_extract(result, '$.ticket.error'), created_at, updated_at FROM dk_jobs WHERE status = 'rejected';

CREATE TABLE dk_buybox (
  listing_id INTEGER PRIMARY KEY REFERENCES listings(id),
  current_price INTEGER,
  winning_price INTEGER,
  is_winner INTEGER,
  suggested_price INTEGER,
  formula_price INTEGER,
  applied_price INTEGER,
  applied_formula_price INTEGER,
  error TEXT,
  checked_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT
);
CREATE TABLE dk_remote_orders (
  remote_id TEXT PRIMARY KEY,
  remote_status TEXT,
  ordered_at TEXT,
  payload TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  error TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE dk_order_events (
  id INTEGER PRIMARY KEY,
  remote_id TEXT NOT NULL REFERENCES dk_remote_orders(remote_id),
  status TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX dk_remote_orders_attention ON dk_remote_orders(order_id, updated_at);
CREATE TABLE dk_operations_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT,
  error TEXT
);
INSERT INTO dk_operations_sync (id) VALUES (1);
