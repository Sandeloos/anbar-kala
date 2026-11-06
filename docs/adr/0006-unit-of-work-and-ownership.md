# 0006 — One unit of work per command, one owner per money table

**Status:** accepted (design review)

## Context
A design review found commands whose parts could come apart:
- `audit()` sent its live "activity" event *inside* the transaction, so a rolled-back command still
  told every browser about a change that never happened;
- several commands (statement paid/void, inbox dismiss, profile, users, warehouses, settings, company
  create/edit, import) wrote the change and its audit line outside a transaction;
- `db.tx` "nested" by joining the outer transaction, so a caught inner failure left half its writes;
- the inbox was updated after the product transaction, with errors swallowed;
- a full sync could write a page it had fetched *before* a newer plugin push, putting an old price back
  and recording a price change that never happened (the price history is what settlement is based on);
- stock moves were written from four places with copied reversal and valuation code, and the default
  warehouse was chosen four different ways (one hard-coded warehouse 1, even when inactive).

## Decision
- `db.tx(fn)` is the unit of work. Nested calls are SAVEPOINTs. `fn` must be synchronous (a promise
  is refused). `db.afterCommit(cb)` runs after COMMIT and is dropped on ROLLBACK; `events.emit` uses it,
  so an event always describes committed data.
- `audit()` must run inside the transaction of its change: an error in development and tests, a logged
  error in production (the row is still written, a log line is never lost).
- Sync writes carry `fetchedAt`; a product written after that is not overwritten by the older snapshot
  unless the site's `date_modified` is newer. Plugin pushes are the freshest signal and always apply.
  The inbox listener runs inside the product transaction.
- `lib/stock.js` is the stock ledger: the only writer of `stock_moves`, with `move`, `reverse`,
  `liveMoves`, `revalueSales`, `available`, `suggestPicks`, `defaultWarehouse` (active warehouses only),
  `saleValue`, and the stock-page commands. New goods cannot go into an inactive warehouse; undo can.
- `tests/unit/architecture.test.js` checks that each money table has one writer module, routes do not
  open the database, the domain does not import routes or Fastify, and no transaction body is async.

## Consequences
- A bug in the inbox now fails the product update that caused it (visible, tested) instead of silently
  losing a task.
- Read-side SQL (lists, reports) stays in routes; writes go through the domain modules.
- Still open, deliberately: domain functions receive `req` as the actor (`{ user, ip }`), errors carry an
  HTTP status (`HttpError`) rather than a separate domain error type, and time is read from the system
  clock (tests back-date through `db.maintenance`). Each is contained and can be changed module by module.
