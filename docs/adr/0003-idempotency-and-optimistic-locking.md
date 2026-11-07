# 0003 — Idempotency keys for writes, versions for edits

**Status:** accepted (engineering pass)

## Context
Admins work on phones over mobile data. A "create order" or "receive line" whose answer is lost would be
sent again by the user (or the browser) and run twice: a duplicate order, a line received twice. Separately,
two admins editing the same company or product would silently overwrite each other.

## Decision
- Every write from the browser carries `Idempotency-Key` (a UUID per user action). The server stores the
  key with a hash of method + URL + body before running the handler, and the answer after it. A repeat gets
  the stored answer; a concurrent repeat gets 409 `in_progress`; reusing a key for another request is 422.
  The client retries network failures and 503 (server restarting) with the same key.
- Edited records carry `version`. Forms send `If-Match: "<version>"`; updates are
  `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`; zero rows changed means someone else
  saved first → 409 `stale` naming them.

## Consequences
- Retrying is always safe, so the client can retry automatically.
- Keys live 24 hours (pruned hourly); a key left by a crashed request is released after 2 minutes.
- Sync updates do not bump `version` (prices change constantly); only people's edits do.
