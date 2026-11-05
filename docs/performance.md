# Performance

`npm run bench` builds the app on a temporary folder, syncs a fake WooCommerce shop, writes
**300 orders a day for 45 days** (13 500 orders, 16 875 lines — about one and a half months of the
expected volume) through the same code the API uses, receives every line, and times the API with
`fastify.inject` (no network in the numbers). Options: `--days`, `--per-day`, `--products`, `--samples`.

Machine: Node 22.23, 4 × Xeon 2.1 GHz, 16 GB RAM. Times in milliseconds; HTTP rows are p50 / p95.

| Step | Before | After |
|---|---:|---:|
| Full sync, 1 945 products (local fake shop) | 608 | 649 |
| Create an order (library) | 0.24 | 0.25 |
| Receive a line (library) | 0.15 | 0.18 |
| `POST /api/orders` (2 lines) | 1.8 / 6.2 | 2.0 / 9.3 |
| `GET /api/orders` (first page) | 1.8 / 2.4 | 1.9 / 2.6 |
| `GET /api/orders?q=` (search) | 19.5 / 22.0 | 21.9 / 32.0 |
| `GET /api/receiving` | 193 / 218 | 70 / 91 ¹ |
| `GET /api/dashboard` | **1 212 / 4 013** | **6.4 / 173** ² |
| `GET /api/pick` (picker search) | 1.5 / 3.3 | 1.6 / 2.5 |
| `GET /api/statements/month` (draft) | 865 / 3 661 | 149 / 180 |
| `GET /api/statements/overview` | **5 456 / 5 771** | **0.4 / 68** ² |
| Statement compute (one company, one month) | 2 213 | 70 |
| Integrity check (whole database) | 94 | 61 |
| `priceAt` per call | 0.01 | 0.01 |
| Database size | 27.7 MB | 28.3 MB (one more index) |

¹ The benchmark receives all 16 875 lines "today"; a real day (~300 lines) is a few milliseconds.
² p50 is a cache hit (no change since the last view); p95 is the first view after a change.

## What changed
- **Intl formatters created once** (`lib/jalali.js`). `new Intl.DateTimeFormat(…)` costs ~60 µs and was
  built for every date converted; statements convert one date per order line. 17 000 conversions went
  from 1 142 ms to 57 ms. This alone took the statement from 2.2 s to 0.1 s.
- **Statement totals cached** for the dashboard and the overview, keyed by the newest audit-log id
  (every change to money data is an audited action), at most 60 s old. Issuing always computes fresh.
- **Receiving** reads only pending lines and today's receipts (new index `order_lines_received`) instead of
  aggregating every line the company ever had. This also fixed a bug: the "received today" list used to
  take the *oldest* 2 000 finished lines and filter them, so after 2 000 receipts today's work vanished.

## When to look again
The statement draft scans the company's lines up to the month (it must, to find late changes to earlier
months). At ~300 lines a day that is ~110 000 lines a year per all companies; expect the draft to stay
under ~0.5 s for several years. If it grows past that, keep a per-key "last billed amount" table updated
on issue, and scan only lines changed since the last statement.
