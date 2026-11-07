-- Phase 2: sales platforms, listings, orders, daily receiving and stock.
-- Quantities in "units" are base units (one cup, one spoon): a product row may be a
-- pack of units_per_pack units. Money is whole rials.

-- Where orders come from (Digikala, Basalam, the company site, …).
CREATE TABLE platforms (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                    -- digikala | basalam | site | …
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO platforms (code, name, sort, created_at) VALUES
  ('digikala', 'دیجی‌کالا', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('basalam', 'باسلام', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('site', 'سایت', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- A listing: what one platform sells as one item, tied to a company product.
-- units = base units in one sale of this listing (a "25 pieces" listing of a 100-piece product → 25).
CREATE TABLE listings (
  id INTEGER PRIMARY KEY,
  platform_id INTEGER NOT NULL REFERENCES platforms(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  code TEXT,                                    -- the platform's id (DKP / variant id / Basalam id); unique per platform
  title TEXT,                                   -- the name on the platform
  units INTEGER NOT NULL,
  platform_price INTEGER,                       -- our current price there (rials), for the price-change inbox
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX listings_code ON listings(platform_id, code) WHERE code IS NOT NULL;
CREATE INDEX listings_product ON listings(product_id);

-- A customer order on a platform (one order can hold items of several companies).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  platform_id INTEGER NOT NULL REFERENCES platforms(id),
  order_number TEXT,                            -- unique per platform
  ordered_at TEXT NOT NULL,                     -- when the customer ordered (decides the settlement price)
  customer TEXT,
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual',        -- manual | import
  import_id INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX orders_number ON orders(platform_id, order_number) WHERE order_number IS NOT NULL;
CREATE INDEX orders_time ON orders(ordered_at DESC);

-- One item of an order.
--  qty × units_per_sale = units_total base units.
--  site_price: the company site's regular price of the product (per product row) at ordered_at.
--  settle_unit_price: what one sale is worth to the company = site_price × units_per_sale ÷ units_per_pack,
--  unless an admin set it by hand (settle_manual = 1, settle_reason).
--  After receiving: units_from_company + units_from_stock + units_cancelled = units_total.
CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  listing_id INTEGER REFERENCES listings(id),
  qty INTEGER NOT NULL,
  units_per_sale INTEGER NOT NULL,
  units_total INTEGER NOT NULL,
  units_per_pack INTEGER NOT NULL,              -- snapshot of the product setting
  platform_price INTEGER,                       -- what the customer paid per sale (rials)
  site_price INTEGER,
  site_price_at TEXT,                           -- effective time of the price used
  site_price_source TEXT,                       -- history source, or 'manual'
  site_price_history_id INTEGER,
  price_uncertain INTEGER NOT NULL DEFAULT 0,   -- 1 = we had not checked the site since the order time
  settle_unit_price INTEGER,
  settle_manual INTEGER NOT NULL DEFAULT 0,
  settle_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | done | cancelled
  outcome TEXT,                                 -- ok | excess | short | wrong | cancelled
  units_from_company INTEGER NOT NULL DEFAULT 0,
  units_from_stock INTEGER NOT NULL DEFAULT 0,
  units_cancelled INTEGER NOT NULL DEFAULT 0,
  received_at TEXT,
  received_by INTEGER REFERENCES users(id),
  receive_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_pending ON order_lines(company_id, status);

-- What physically arrived from a company during receiving and where it went.
-- disposition: shipped (sent to the customer) | stock (into our warehouse, still the company's) | returned (sent back)
CREATE TABLE arrivals (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  order_line_id INTEGER REFERENCES order_lines(id),
  product_id INTEGER REFERENCES products(id),   -- NULL when the item is not one of the company's products
  description TEXT,                             -- for unknown items
  units INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  warehouse_id INTEGER REFERENCES warehouses(id),
  wrong INTEGER NOT NULL DEFAULT 0,             -- 1 = not what was ordered
  voided_at TEXT,                               -- receiving was undone
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX arrivals_line ON arrivals(order_line_id);

-- The stock ledger. Stock of (product, warehouse, owner) = SUM(units). Never edited:
-- a mistake is undone by an opposite row (reverses = the row it cancels).
-- owner_company_id NULL = our own stock; otherwise the partner company still owns it.
-- kind: surplus_in | wrong_in | own_in | ship_out | return_to_company | transfer_out | transfer_in | adjust | reversal
-- value: for ship_out of company stock, what the company is owed (rials) at the order time.
CREATE TABLE stock_moves (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  owner_company_id INTEGER REFERENCES companies(id),
  units INTEGER NOT NULL,
  kind TEXT NOT NULL,
  order_line_id INTEGER REFERENCES order_lines(id),
  arrival_id INTEGER REFERENCES arrivals(id),
  value INTEGER,
  reverses INTEGER REFERENCES stock_moves(id),
  reversed_by INTEGER REFERENCES stock_moves(id),
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX stock_moves_key ON stock_moves(product_id, warehouse_id, owner_company_id);
CREATE INDEX stock_moves_line ON stock_moves(order_line_id);
CREATE INDEX stock_moves_time ON stock_moves(created_at DESC);

-- Spreadsheet imports of orders (Digikala panel export, …), with the column mapping used.
CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  platform_id INTEGER NOT NULL REFERENCES platforms(id),
  file_name TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  orders_created INTEGER NOT NULL DEFAULT 0,
  lines_created INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- The last column mapping per platform, so the next file of the same shape needs no setup.
CREATE TABLE import_mappings (
  platform_id INTEGER PRIMARY KEY REFERENCES platforms(id),
  mapping TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
