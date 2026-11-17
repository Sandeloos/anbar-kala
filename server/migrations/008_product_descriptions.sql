ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT '';
CREATE TABLE dk_product_content (
  product_id INTEGER PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL
);
