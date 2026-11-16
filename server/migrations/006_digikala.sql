-- Digikala automatic pricing (decisions: docs/decisions.md, ADR 0007).
-- Each Digikala listing carries its own formula: the site price of the units it sells,
-- plus a margin and an optional fixed amount, rounded up. The seller Open API sends the price;
-- if Digikala refuses it (outside the reference-price range) the variant is deactivated, its
-- stock set to zero and a reference-price ticket opened; an admin re-activates it later.

/* ------------------------------------------------------------ the formula, per listing */
ALTER TABLE listings ADD COLUMN auto_price INTEGER NOT NULL DEFAULT 0;   -- 1 = keep the Digikala price in step
ALTER TABLE listings ADD COLUMN margin_pct REAL;                        -- profit margin in percent (e.g. 30)
ALTER TABLE listings ADD COLUMN fixed_add INTEGER NOT NULL DEFAULT 0;   -- rials added after the margin (packing, shipping)
ALTER TABLE listings ADD COLUMN round_to INTEGER NOT NULL DEFAULT 10000; -- round up to this many rials (10 000 = 1 000 tomans)
ALTER TABLE listings ADD COLUMN dk_state TEXT;                          -- NULL | 'blocked' (price refused: off and stock 0)
ALTER TABLE listings ADD COLUMN dk_stock_before INTEGER;                -- seller stock before it was set to 0, to restore

/* ------------------------------------------------------------ the connection (one row) */
CREATE TABLE dk_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'dry_run', 'live')),
  base_url TEXT NOT NULL DEFAULT 'https://seller.digikala.com',
  client_code TEXT,
  private_key_enc TEXT,                         -- the seller's RSA private key (AES-GCM, APP_SECRET)
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  access_expires_at TEXT,
  connected_at TEXT,                            -- the self-token is valid for 6 months from here
  max_change_pct INTEGER NOT NULL DEFAULT 30,   -- a bigger change waits for an admin's approval
  ticket_sub_category_id INTEGER,               -- Digikala's ticket sub-category for reference-price requests
  last_error TEXT,
  last_ok_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO dk_connection (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

/* ------------------------------------------------------------ the work queue */
-- One open job per listing; a newer site price updates it. Network calls happen outside any
-- transaction; the result of each is written back with its audit line.
CREATE TABLE dk_jobs (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'needs_approval', 'approved', 'sent', 'dry_run', 'unchanged',
                                         'rejected', 'failed', 'skipped', 'cancelled')),
  reason TEXT NOT NULL,                         -- site_price | formula | manual | reactivated
  site_price INTEGER,                           -- the site price of the units of one sale (rials)
  target_price INTEGER,                         -- what the formula gives (rials)
  current_price INTEGER,                        -- Digikala's selling price when checked
  reference_price INTEGER,                      -- Digikala's reference price when checked
  change_pct REAL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  error TEXT,
  result TEXT,                                  -- JSON: what was done (price, deactivated, stock_zero, ticket)
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dk_jobs_open ON dk_jobs(listing_id) WHERE status IN ('pending', 'needs_approval', 'approved');
CREATE INDEX dk_jobs_due ON dk_jobs(status, next_at);
CREATE INDEX dk_jobs_listing ON dk_jobs(listing_id, id DESC);
