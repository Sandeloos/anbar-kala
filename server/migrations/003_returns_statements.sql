-- Phase 3: customer returns, monthly settlement statements per company.

-- A customer sent back units of an order line. They come into our warehouse as our own stock
-- (the company was already paid for the sale). Then someone decides:
--   kept        we keep it and may sell it again from our stock
--   to_company  sent back to the company → credited (minus) on the statement of the month decided
--   damaged     written off
CREATE TABLE returns (
  id INTEGER PRIMARY KEY,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  units INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  reason TEXT,
  returned_at TEXT NOT NULL,                    -- when it arrived back
  disposition TEXT,                             -- NULL (waiting) | kept | to_company | damaged
  disposition_at TEXT,
  disposition_by INTEGER REFERENCES users(id),
  disposition_note TEXT,
  value INTEGER,                                -- to_company: what is credited to the company (rials, positive)
  voided_at TEXT,
  void_reason TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX returns_line ON returns(order_line_id);
CREATE INDEX returns_waiting ON returns(disposition, voided_at);

ALTER TABLE stock_moves ADD COLUMN return_id INTEGER REFERENCES returns(id);

-- A monthly statement (Jalali month, "1405-08") issued to a company. Once issued its items are
-- frozen; anything that changes later appears as an adjustment on a later statement.
CREATE TABLE statements (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',        -- issued | paid | void
  currency TEXT NOT NULL,
  sales_total INTEGER NOT NULL DEFAULT 0,       -- shipped from what the company sent
  stock_total INTEGER NOT NULL DEFAULT 0,       -- shipped from the company's surplus in our warehouse
  returns_total INTEGER NOT NULL DEFAULT 0,     -- returns sent back to the company (negative)
  adjust_total INTEGER NOT NULL DEFAULT 0,      -- changes to earlier months
  total INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  issued_at TEXT NOT NULL,
  issued_by INTEGER REFERENCES users(id),
  paid_at TEXT,
  paid_reference TEXT,
  paid_by INTEGER REFERENCES users(id),
  void_at TEXT,
  void_reason TEXT,
  void_by INTEGER REFERENCES users(id)
);
CREATE UNIQUE INDEX statements_month ON statements(company_id, month) WHERE status <> 'void';

-- What a statement billed. key identifies the billable thing across statements:
--   L<line id> sale from the company's shipment, M<move id> sale from the company's surplus,
--   R<return id> return sent back to the company.
-- item_month is the month the thing belongs to (order month, or the month a return was decided).
CREATE TABLE statement_items (
  id INTEGER PRIMARY KEY,
  statement_id INTEGER NOT NULL REFERENCES statements(id),
  key TEXT NOT NULL,
  section TEXT NOT NULL,                        -- sales | stock | returns | adjust
  kind TEXT NOT NULL,                           -- sale | stock_sale | return
  item_month TEXT NOT NULL,
  order_id INTEGER,
  order_line_id INTEGER,
  return_id INTEGER,
  move_id INTEGER,
  product_name TEXT,
  platform_name TEXT,
  order_number TEXT,
  ordered_at TEXT,
  units INTEGER,
  sales REAL,                                   -- number of sales (units ÷ units per sale)
  unit_price INTEGER,                           -- per sale (rials)
  amount INTEGER NOT NULL,                      -- rials (negative for credits)
  previous INTEGER NOT NULL DEFAULT 0,          -- adjustments: what earlier statements billed for this key
  note TEXT
);
CREATE INDEX statement_items_statement ON statement_items(statement_id);
CREATE INDEX statement_items_key ON statement_items(key);
