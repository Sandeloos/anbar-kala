# 0002 — Invariants enforced by the database

**Status:** accepted (engineering pass, migration 005)

## Context
Money depends on a few rules: the stock ledger is append-only and never negative, issued statements never
change, history is never rewritten, nothing is deleted. The application followed them, but only the
application: a bug, a script or a hand-written `UPDATE` could break them silently, and the damage would
show up months later in a settlement.

## Decision
Triggers in `005_integrity.sql` reject every write that breaks a rule (`RAISE(ABORT, …)`). Each guard has
`WHEN NOT EXISTS (SELECT 1 FROM maintenance)`; `db.maintenance(fn)` inserts that row, runs `fn` and deletes
it inside one transaction. A nightly integrity check (`lib/integrity.js`) re-verifies the cross-table
invariants triggers cannot express cheaply (statement totals = items, no key billed twice, picks vs. ledger)
and every unit test ends with it.

## Consequences
- A broken rule is an immediate error at the line that broke it, not a wrong statement later.
- Repairs are possible but deliberate and visible in code review (`db.maintenance`).
- Migrations are checksummed, so a migration cannot be edited after it ran on a database.
