-- units_per_pack remains the denominator of the site price; physical sales packaging is separate.
ALTER TABLE products ADD COLUMN sale_pack_units INTEGER;
ALTER TABLE products ADD COLUMN category_names TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN pricing_group TEXT CHECK (pricing_group IN ('tools', 'other'));
ALTER TABLE products ADD COLUMN packaging_pending INTEGER NOT NULL DEFAULT 0;
UPDATE products SET sale_pack_units = units_per_pack;
CREATE TABLE packaging_history (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_units INTEGER NOT NULL CHECK (price_units > 0),
  sale_units INTEGER NOT NULL CHECK (sale_units > 0),
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO packaging_history (product_id, price_units, sale_units, effective_at, created_at)
SELECT id, units_per_pack, units_per_pack, '0001-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM products;
CREATE INDEX packaging_at ON packaging_history(product_id, effective_at, id);
CREATE TABLE packaging_reviews (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE UNIQUE INDEX packaging_open ON packaging_reviews(product_id) WHERE status = 'pending';
CREATE TRIGGER packaging_history_no_update BEFORE UPDATE ON packaging_history BEGIN SELECT RAISE(ABORT, 'packaging history is append-only'); END;
CREATE TRIGGER packaging_history_no_delete BEFORE DELETE ON packaging_history BEGIN SELECT RAISE(ABORT, 'packaging history is append-only'); END;

ALTER TABLE listings ADD COLUMN margin_default INTEGER NOT NULL DEFAULT 0;
UPDATE listings SET margin_default = 1 WHERE margin_pct IS NULL AND platform_id = (SELECT id FROM platforms WHERE code = 'digikala');

-- Preserve an explicit human opt-out; all other existing Digikala listings become automatic.
UPDATE listings SET auto_price = 1, version = version + 1
WHERE platform_id = (SELECT id FROM platforms WHERE code = 'digikala') AND auto_price = 0
AND NOT EXISTS (SELECT 1 FROM audit_log a, json_each(COALESCE(a.changes,'[]')) ch
 WHERE a.entity = 'listing' AND a.entity_id = CAST(listings.id AS TEXT) AND a.user_id IS NOT NULL
 AND json_extract(ch.value,'$.field') = 'auto' AND json_extract(ch.value,'$.to') = 'خیر');
UPDATE listings SET margin_pct = CASE WHEN EXISTS (SELECT 1 FROM products p WHERE p.id = listings.product_id AND
 (p.name LIKE '%ابزار%' OR p.name LIKE '%انبر%' OR p.name LIKE '%آچار%' OR p.name LIKE '%دریل%' OR p.name LIKE '%فرز%' OR p.name LIKE '%چکش%' OR p.name LIKE '%اره%' OR p.name LIKE '%پیچگوشتی%')) THEN 40 ELSE 50 END
WHERE platform_id = (SELECT id FROM platforms WHERE code = 'digikala') AND margin_pct IS NULL;
CREATE TABLE pricing_defaults_state (id INTEGER PRIMARY KEY CHECK (id = 1), applied INTEGER NOT NULL DEFAULT 0);
INSERT INTO pricing_defaults_state (id) VALUES (1);
