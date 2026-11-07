-- Phase 1: people, activity log, warehouses, companies (WooCommerce sites),
-- their products and the price/stock history read from those sites.
-- Money is stored as whole rials (INTEGER) whatever currency a site uses.
-- Times are ISO-8601 UTC strings.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'admin')),
  phone TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  password_changed_at TEXT,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Every change anyone makes; never edited or deleted.
-- changes: JSON [{ "field": "...", "label": "...", "from": ..., "to": ... }]
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  changes TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_time ON audit_log(created_at DESC);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);
CREATE INDEX audit_user ON audit_log(user_id, created_at DESC);

-- Sandeloos' own warehouses (physical places). Never deleted, only deactivated.
CREATE TABLE warehouses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO warehouses (name, created_at, updated_at) VALUES
  ('سندلوس', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('رادلوس', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- A supplier company under contract and its WooCommerce site.
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'toman' CHECK (currency IN ('toman', 'rial')),   -- reports and screens
  price_unit TEXT NOT NULL DEFAULT 'toman'      -- what the site's price fields are written in
    CHECK (price_unit IN ('toman', 'rial', 'thousand_toman', 'thousand_rial')),
  woo_key_enc TEXT,
  woo_secret_enc TEXT,
  key_hint TEXT,                                -- last characters of the key, to recognise it
  api_style TEXT NOT NULL DEFAULT 'wp-json',    -- 'wp-json' or 'rest_route' (sites without pretty links)
  auth_mode TEXT NOT NULL DEFAULT 'header',     -- 'header' (Basic) or 'query' (hosts that drop the header)
  webhook_secret TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id), -- where this company's surplus goes by default
  contact_name TEXT,
  contact_phone TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  site_currency TEXT,                           -- what WooCommerce reports (IRT, IRR, …)
  sync_state TEXT NOT NULL DEFAULT 'never',     -- never | ok | error
  sync_error TEXT,
  last_full_sync_at TEXT,
  last_incremental_at TEXT,
  last_webhook_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One sellable item of a site: a simple product or one variation of a variable product.
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  woo_id INTEGER NOT NULL,
  parent_woo_id INTEGER,
  type TEXT NOT NULL,                           -- simple | variation | other WooCommerce types
  name TEXT NOT NULL,
  parent_name TEXT,
  attributes TEXT,
  sku TEXT,
  permalink TEXT,
  slug TEXT,
  site_status TEXT,                             -- publish | draft | private | pending | trash
  regular_price INTEGER,                        -- rials; the settlement price (before discount)
  sale_price INTEGER,                           -- rials; shown for information only
  stock_status TEXT,                            -- instock | outofstock | onbackorder
  stock_quantity INTEGER,
  manage_stock INTEGER NOT NULL DEFAULT 0,
  site_modified_at TEXT,
  price_source TEXT NOT NULL DEFAULT 'site',    -- site | manual (an admin typed the current price)
  units_per_pack INTEGER NOT NULL DEFAULT 1,    -- how many units one of this item contains
  units_guessed INTEGER NOT NULL DEFAULT 0,     -- 1 = units_per_pack was read from the name ("بسته ۱۰۰ عددی"), not yet confirmed
  warehouse_id INTEGER REFERENCES warehouses(id), -- overrides the company's surplus warehouse
  tracked INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  configured_at TEXT,                           -- set once an admin has reviewed the pack size
  search_text TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT,
  last_changed_at TEXT,
  removed_at TEXT,                              -- no longer found on the site
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, woo_id)
);
CREATE INDEX products_company ON products(company_id, removed_at);
CREATE INDEX products_changed ON products(last_changed_at DESC);

-- The state of a product each time its price or stock changed.
-- The price that applied at time T is the last row with effective_at <= T.
CREATE TABLE price_history (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  regular_price INTEGER,
  sale_price INTEGER,
  stock_status TEXT,
  stock_quantity INTEGER,
  price_changed INTEGER NOT NULL DEFAULT 0,
  stock_changed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,                         -- import | sync | webhook | refresh | manual
  effective_at TEXT NOT NULL,                   -- when the change happened on the site (best known)
  observed_at TEXT NOT NULL,                    -- when this server learned about it
  user_id INTEGER REFERENCES users(id),
  note TEXT
);
CREATE INDEX price_history_product ON price_history(product_id, effective_at);
CREATE INDEX price_history_changes ON price_history(price_changed, observed_at DESC);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL,                           -- full | incremental | refresh | webhook
  status TEXT NOT NULL,                         -- running | ok | error
  started_at TEXT NOT NULL,
  finished_at TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  price_changes INTEGER NOT NULL DEFAULT 0,
  stock_changes INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  user_id INTEGER REFERENCES users(id)
);
CREATE INDEX sync_runs_company ON sync_runs(company_id, started_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
