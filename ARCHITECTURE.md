# Architecture

```
 company sites (WordPress + WooCommerce)              Anbar server (Node 22, Fastify, SQLite)
 ┌───────────────────────────────┐   REST v3 (read)   ┌───────────────────────────────────────┐
 │ /wp-json/wc/v3/products …     │ ◀───────────────── │ jobs.js: full sync (hourly),          │
 │                               │                    │          incremental (every 5 min)    │
 │ anbar-connector plugin ───────┼── signed POST ───▶ │ /hooks/woo/:company (instant changes) │
 └───────────────────────────────┘                    │ lib/sync.js → products, price_history │
                                                      │ /api/* (cookie + X-Anbar header)      │
 browsers ◀── /api/events (server-sent events) ────── │ events bus                            │
                                                      └───────────────────────────────────────┘
```

## Data
- `companies` — one per partner; site URL, encrypted read-only WooCommerce keys, detected API style
  (`wp-json` or `?rest_route=`) and auth mode (header or query), price unit, report currency,
  default surplus warehouse, webhook secret, sync state.
- `products` — one per sellable item (simple product or variation): exact name/link/SKU from the site,
  current regular/sale price (rials), stock, our settings (`units_per_pack`, surplus warehouse, note),
  `configured_at` (an admin confirmed the pack size; `units_guessed` = suggested from the name).
- `price_history` — a row whenever price or stock changes. `effective_at` = when it changed on the
  site (WooCommerce `date_modified_gmt` when it falls between our previous check and now, else when we
  noticed; the plugin makes it near-instant), `observed_at` = when we learned it, `source`.
- `sync_runs`, `users`, `sessions`, `audit_log`, `warehouses`, `settings`.

## Orders, receiving and stock (phase 2)
- `platforms` (Digikala, Basalam, site, …) and `listings`: a platform item → a company product and
  `units` per sale (a "25 pieces" listing of a 100-piece product).
- `orders` / `order_lines`: each line freezes the site price at the order time (`site_price`,
  `site_price_at`, source, `price_uncertain`) and `settle_unit_price` = site_price × units_per_sale ÷
  units_per_pack (or a manual value with a reason). `lib/orders.js` holds the rules.
- Receiving (`lib/orders.js` `receive`): outcome ok / excess / short / wrong / cancelled →
  `arrivals` (what physically came and where it went) and `stock_moves`; the line records
  `units_from_company`, `units_from_stock`, `units_cancelled`. Undo writes reversal moves.
- `stock_moves` is the ledger: stock = SUM(units) per (product, warehouse, owner_company_id; NULL = ours).
  Never below zero; `ship_out` of company-owned units carries `value` for the monthly settlement.
- Import (`lib/importer.js`, `routes/imports.js`): xlsx/csv → column mapping (guessed from Persian
  headers, saved per platform) → preview → listings for unknown codes → orders.

## Returns and statements (phase 3)
- `returns` (`lib/returns.js`): a customer return enters our warehouse as our own stock (`return_in`);
  decided as kept / to_company (`return_to_company` move, `value` credited) / damaged (`write_off`).
  Credits only up to units the company was paid for (its shipment + picks from its surplus).
- `statements` + `statement_items` (`lib/statements.js`): billable keys `L<line>` (company shipment),
  `M<move>` (sold from company surplus), `R<return>` (credit). A month's draft = this month's keys not yet
  billed + adjustments for earlier keys (current value − what non-void statements billed). Issuing
  freezes the items; voiding (manager, latest unpaid only) un-bills them. Excel via exceljs (RTL sheet).
- Stocktake: `POST /stock/count` turns counted numbers into `count` moves.

## Inbox, backups, deployment (phase 4)
- `tasks` (`lib/tasks.js`): `sync.onChanges` reports every price/stock change; for active listings on
  platforms other than the company site it opens or updates one task per (listing, kind) and closes it
  when the value returns. Done records the price set on the platform into `listings.platform_price`.
- Backups (`lib/backup.js`): `VACUUM INTO DATA_DIR/backups/anbar-<Tehran time>.db`, nightly from `jobs.js`
  and on demand (`/api/system/backup`, manager), pruned to `backup_keep`.
- Deployment: `docker-compose.yml` (app + Caddy for HTTPS, `Caddyfile`), `.env.example`, CI saves the
  image as an artifact for servers without registry access. Guide: `docs/deploy.md` (Persian).

## Sync
- **full**: every product page (100 per request, `_fields` trimmed) + variations of variable products
  (4 parents in parallel); items the site no longer lists get `removed_at`.
- **incremental**: `modified_after` = last run − 2 minutes; variations of changed parents re-read.
  Stock changes caused by orders do not touch `date_modified` in WooCommerce, so the plugin
  (or the next full sync) catches those.
- **webhook**: the plugin sends REST-shaped items; HMAC-SHA256 over `"<timestamp>.<body>"`,
  ±5 minutes. The same `normalise()` handles REST and plugin data.
- **refresh** / **lookup**: one product on demand; "add by link" resolves a product URL (slug or
  `?p=`) and picks the variation from `attribute_*` query parameters.

## Security
- Passwords: scrypt. Sessions: random token in an httpOnly, SameSite=Strict cookie (12 h sliding),
  only the hash stored. Non-GET API calls need `X-Anbar: 1`. Login rate-limited per IP and username.
- New users and resets get a one-time password; nothing else works until it is changed.
- WooCommerce keys: AES-256-GCM with a key derived from `APP_SECRET` (required in production).
- CSP `default-src 'self'`; no third-party requests from the browser.
