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
- `npm run check` = eslint + `php -l` on the plugin + unit/API tests with coverage thresholds
  (node:test, `tests/unit`; every test ends with the integrity check) + Playwright (`tests/e2e`, laptop
  and phone, axe, font and horizontal-scroll checks) against `tests/e2e-server.js`. Run it before every
  push. Tests run in `Asia/Tehran`. `npm run bench` = load benchmark (`docs/performance.md`).

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
- The database enforces the money rules with triggers (`005_integrity.sql`): append-only history and
  ledger, frozen issued statements, no deletes, stock never below zero. Never weaken a guard; a deliberate
  data repair goes through `db.maintenance(fn)`. Never edit a migration that has shipped (checksums) — add one.
- Edits of companies/products/listings/users/warehouses: `concurrency.check(req, before, …)` early, then
  `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` and `concurrency.stale()` on 0 changes;
  the browser passes `put(path, body, { version })`. Writes are idempotent (`Idempotency-Key`, `api.js`).
- Create `Intl.DateTimeFormat` once at module level, never per call (it costs ~60 µs).
- One command = one `db.tx(() => { … })`: the change, its stock moves, `audit()` and `events.emit()` inside it
  (audit outside a transaction throws in dev/tests; events are delivered after COMMIT). Never `await` inside
  `db.tx`: do network work first, then re-check inside the transaction.
- Stock only through `lib/stock.js` (`move`, `reverse`, `defaultWarehouse`, `saleValue`, …); each money table has
  one writer module (`tests/unit/architecture.test.js`). Sync writes pass `fetchedAt` (time the request was sent).
- Digikala: only `lib/digikala.js` writes `dk_jobs`/`dk_connection`; network calls never inside `db.tx` (queue first,
  worker after commit). Test against `tools/mock-digikala.js`, never the real API. ADR 0007.
  Import of listings: `importPreview` / `importCreate` in the same module, view `views/digikala-import.js`.
- Technical decisions: `docs/adr/`. Operations: `/health`, `/ready`, `/metrics` (METRICS_TOKEN), request ids,
  graceful `app.shutdown()`; config is validated in `config.js` (add new variables to its zod schema).

## Structure
- `server/app.js` builds the app; `routes/*` (one file per area, `validate.js` = zod pieces with
  Persian messages); `lib/sync.js` (WooCommerce sync, price history, price-at), `lib/woo.js` (REST client
  and connection detection), `lib/auth.js`, `lib/audit.js`, `lib/secrets.js` (AES-GCM for API keys),
  `jobs.js` (scheduler: sync with back-off, nightly backup + integrity, key pruning), `migrations/*.sql`.
  Engineering: `lib/integrity.js`, `lib/idempotency.js`, `lib/concurrency.js`, `lib/metrics.js`, `lib/stock.js`,
  `tools/bench.js`; tests in `tests/unit/engineering.test.js`, `design.test.js`, `architecture.test.js`.
- `public/index.html` (shell, icon sprite, dialogs) + `assets/css/app.css` + `assets/js/`
  (`app.js` router/shell/palette, `api.js`, `ui.js`, `live.js`, `views/<section>.js` each exporting
  `render(view, ctx, params)`; handlers are assigned as `view.onclick = …` so the next view replaces them).
  In-app training: `assets/js/help.js` holds one guide per section (`GUIDES`), `views/guide.js` is the training
  page. A new section or sub-page needs a guide, and its labels must match the screen (`tests/e2e/help.spec.js`).
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
- Phase 4: `lib/tasks.js` (inbox, fed by `sync.onChanges`), `lib/backup.js`, routes `tasks.js`, `system.js`,
  views `inbox.js`, `settings.js` (system and backups), dashboard chart. Deployment: `docker-compose.yml`,
  `Caddyfile`, `.env.example`, `docs/deploy.md`; the user guide is `docs/guide.md`.
