# Architecture decision records

Short records of technical decisions: the context, what was chosen, and what it costs.
The owner-facing decisions (in Persian) are in `docs/decisions.md`.

| # | Decision |
|---|---|
| [0001](0001-sqlite-single-node.md) | One Node process with SQLite (`node:sqlite`), not a database server |
| [0002](0002-invariants-in-the-database.md) | Business invariants enforced by triggers, with a maintenance escape hatch |
| [0003](0003-idempotency-and-optimistic-locking.md) | Idempotency keys for writes, versions for edits |
| [0004](0004-price-at-order-time.md) | Settlement price from an append-only price history |
| [0005](0005-observability-and-shutdown.md) | Health, readiness, metrics and graceful shutdown without extra services |
| [0006](0006-unit-of-work-and-ownership.md) | One unit of work per command, one owner per money table |
| [0007](0007-digikala-autopricing.md) | Automatic Digikala pricing through the seller Open API |
