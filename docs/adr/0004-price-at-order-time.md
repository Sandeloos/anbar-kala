# 0004 — Settlement price from an append-only price history

**Status:** accepted (phase 1–2)

## Context
The company is paid the regular price (before discount) its own site showed at the hour of the order,
not today's price. Sites change prices often; orders are entered later in the day.

## Decision
Every observed change is a row in `price_history` with `effective_at` (when it changed on the site:
WooCommerce `date_modified_gmt` if it lies in the observation window, otherwise when we saw it; the plugin
makes this near-instant) and `observed_at`. `sync.priceAt(product, time)` returns the row in force at the
order time; an order shortly before the first observation (15 min grace) uses the first row and is marked
uncertain. Order lines freeze the price; only `setLinePrice` (with a reason) changes it.

## Consequences
- History is append-only (enforced by 0002). Corrections are new rows or manual line prices, both audited.
- `priceAt` is an indexed lookup (~10 µs).
