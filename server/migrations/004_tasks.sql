-- Phase 4: the inbox of things to do on Digikala / Basalam when a company site changes.
-- One open task per (listing, kind); further changes update it, and a change back closes it.
--   kind price: the site's regular price changed → change our price on the platform
--   kind stock: the site went out of stock / back in stock / below the low-stock limit
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  platform_id INTEGER NOT NULL REFERENCES platforms(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'open',          -- open | done | dismissed | reverted
  site_price_before INTEGER,
  site_price_after INTEGER,
  stock_before TEXT,
  stock_after TEXT,
  qty_before INTEGER,
  qty_after INTEGER,
  platform_price_before INTEGER,                -- our price on the platform when the task was made
  suggested_price INTEGER,                      -- same margin on the new site price, rounded
  done_price INTEGER,                           -- the price the admin actually set
  changes INTEGER NOT NULL DEFAULT 1,           -- how many site changes this task collected
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX tasks_open ON tasks(listing_id, kind) WHERE status = 'open';
CREATE INDEX tasks_status ON tasks(status, updated_at DESC);
