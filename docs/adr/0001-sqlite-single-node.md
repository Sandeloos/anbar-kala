# 0001 — One Node process with SQLite

**Status:** accepted (phase 1)

## Context
One company, a few to a dozen users, ~300 orders a day, a server in Iran with unreliable access to
registries and no operations team. Backups must be simple and complete.

## Decision
One Node 22 process (Fastify) serves the API, the app and the background sync; data lives in one SQLite
file through the built-in `node:sqlite` driver (WAL, `synchronous = NORMAL`, foreign keys on). Writes are
synchronous, so a request's transaction cannot interleave with another's.

## Consequences
- No database server to install, tune or secure; a backup is `VACUUM INTO` one file.
- Measured headroom (`docs/performance.md`): 13 500 orders / 17 000 lines in 28 MB; order entry ~2 ms.
  Years of data at this volume stay well inside SQLite's comfort zone.
- One process means one machine. If Anbar ever needs several app servers, the data layer (`server/db.js`,
  plain SQL) moves to PostgreSQL; the triggers in 0002 translate directly.
