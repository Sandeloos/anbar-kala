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
