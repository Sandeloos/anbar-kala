# Anbar — working notes

Persian (RTL) web app for Sandeloos: consignment stock from partner companies, orders from
Digikala / Basalam / the company sites, daily receiving, returns and monthly settlement.
One Node server (Fastify + node:sqlite) serves the API, the single-page app and the background
sync. No front-end build step. Technical map: `ARCHITECTURE.md`. What the owner asked for and every
decision taken with them: `docs/decisions.md` (Persian) — read it before changing behaviour.

## Run and check
- `npm install`, then `npm run demo` → http://127.0.0.1:8080 with three fake WooCommerce shops whose
  prices move every few seconds (demo / demo-1234 manager, ali / demo-1234 admin).
- Real use: `MANAGER_USERNAME=… MANAGER_PASSWORD=… npm run db:seed`, then `npm run dev`.
- `npm run check` = eslint + `php -l` on the plugin + unit/API tests (node:test, `tests/unit`) +
  Playwright (`tests/e2e`, laptop and phone, axe, font and horizontal-scroll checks) against
  `tests/e2e-server.js`. Run it before every push. Tests run in `Asia/Tehran`.

## Rules
- This project lives only in the Sandeloos/anbar-kala repo. Local scratch (screenshots) goes in `.local/`.
- Everything right-to-left, Persian copy, Jalali dates (`Intl` with `fa-IR-u-ca-persian`, Tehran time).
- One font: Rubik, self-hosted (the server is in Iran; no CDN, no Google Fonts, no external requests).
- Money is stored as whole **rials** (INTEGER). A company's `price_unit` says what its site's price
  fields mean (toman / rial / thousand toman / thousand rial); `currency` is what screens and reports use.
- The settlement price is the site's **regular price (before discount) at the order time**:
  `sync.priceAt(productId, isoTime)` over `price_history` (`effective_at`).
- Nothing is deleted: users, companies and warehouses are deactivated; products are marked `removed_at`.
- Every change a person makes calls `audit(req, { action, entity, id, summary, changes })` with
  field-level `audit.diff(before, after, labels)`. The activity log is never edited.
- API: cookie session + `X-Anbar: 1` header on every non-GET; `config: { manager: true }` marks
  manager-only routes; responses use snake_case.
- Live updates: `events.emit('products' | 'sync' | 'company' | 'activity' | 'orders' | 'stock' | 'listings', data)`
  → `/api/events` (SSE) → `ctx.subscribe(type, fn)` in views. The router gives every page a fresh
  container, so a late reload of a page you left cannot draw over the current one.
- Stock is a ledger (`stock_moves`); never update or delete rows, write an opposite row.
- Order lines freeze the site price at the order time; change it only through `setLinePrice` (reason required).

## Structure
- `server/app.js` builds the app; `routes/*` (one file per area, `validate.js` = zod pieces with
  Persian messages); `lib/sync.js` (WooCommerce sync, price history, price-at), `lib/woo.js` (REST client
  and connection detection), `lib/auth.js`, `lib/audit.js`, `lib/secrets.js` (AES-GCM for API keys),
  `jobs.js` (scheduler), `migrations/*.sql`.
- `public/index.html` (shell, icon sprite, dialogs) + `assets/css/app.css` + `assets/js/`
  (`app.js` router/shell/palette, `api.js`, `ui.js`, `live.js`, `views/<section>.js` each exporting
  `render(view, ctx, params)`; handlers are assigned as `view.onclick = …` so the next view replaces them).
- `wordpress-plugin/anbar-connector/` — the WooCommerce plugin that pushes changes (signed HMAC);
  served as a zip from `/api/plugin/anbar-connector.zip`. `tests/php/plugin-harness.php` runs it
  under PHP with WordPress stand-ins; `tests/unit/plugin.test.js` feeds its output to the server.
- `tools/mock-woo.js` — fake WooCommerce shop for the demo and the tests.
- Phase 2: `lib/orders.js` (orders, receiving, stock rules), `lib/importer.js`, `lib/jalali.js` (server) and
  `public/assets/js/jalali.js` (browser, same algorithm), `public/assets/js/picker.js` (listing/product search),
  views `orders.js`, `receiving.js`, `stock.js`, `listings.js`, `import.js`.
- Phase 3: `lib/returns.js`, `lib/statements.js` (statement math and Excel), views `returns.js`,
  `statements.js`, `count.js` (stocktake). Issued statements are never edited: change data and let the
  difference appear as an adjustment on the next statement. Download file names stay ASCII.
