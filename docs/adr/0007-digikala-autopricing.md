# 0007 — Automatic Digikala pricing through the seller Open API

**Status:** accepted (owner's request, November 2026)

## Context
When a partner company changes a price on its site, the Digikala price of every listing selling that product
must follow, with a margin the owner sets per packaging. Until now Anbar opened an inbox task and an admin
changed the price by hand. Digikala offers a seller Open API (`https://seller.digikala.com/open-api/v1`,
Swagger "DK Marketplace - Open API Service", 283 endpoints) with a self-token: the seller registers an RSA-4096
public key, the panel shows an authorization code encrypted with it (base64, PKCS#1 v1.5), and
`POST auth/token` exchanges the decrypted code for an access + refresh token (self-token valid 6 months).

## Decision
- **Formula per listing** (`listings.auto_price, margin_pct, fixed_add, round_to`), set when a Digikala variant
  (listing code = DKPC variant id) is linked to a site product:
  `round up( site price × units ÷ units per pack × (1 + margin) + fixed, round_to )`, all in rials.
- **Queue, not inline calls.** `sync.onChanges` runs inside the product transaction, so it only queues a job
  (`dk_jobs`, one open job per listing). A worker outside any transaction reads the variant, decides and writes
  the result back in one transaction with its audit line (ADR 0006). Started after commit and every minute.
- **Decisions:** unchanged → nothing; change above `max_change_pct` (30 %) → waits for an admin; dry run → only
  recorded; otherwise `PATCH variants/selling-price` with the variant's own `credit_increase_percentage`.
- **Refused price** (400 with `errors.selling_price`, i.e. outside the reference-price band): deactivate the
  variant, set seller stock to 0 (old number kept in `dk_stock_before`), open a reference-price ticket
  (`POST tickets/requests`, the sub-category's `dynamic_modal` field with `new_reference_price`) when the ticket
  sub-category is configured, and mark the listing `blocked`. Other 4xx: failed, shown; 429/5xx/network:
  retried with back-off. An admin re-activates with one click (variant on, stock back, priced again).
- **Secrets:** private key and tokens AES-GCM encrypted (`APP_SECRET`); the refresh token is replaced on every
  refresh; 401 → one refresh and retry. The self-token's 6-month expiry is shown, red under 21 days.
- **Modes:** off / dry run / live. Start in dry run.
- **Tests:** `tools/mock-digikala.js` implements the used endpoints with a reference-price band, token expiry,
  rotating refresh tokens and rate limits; `tests/unit/digikala.test.js` covers every path. The demo runs it on 8094.

## Consequences
- The manual inbox no longer opens price tasks for auto-priced listings (stock tasks stay).
- Prices are assumed to be rials in the API (as in its examples); verify with dry run before going live.
- Reference-price tickets need the right sub-category id from the seller's ticket categories; without it the
  refusal is shown and the ticket is filed by hand.
- Webhooks (`product_variant_status_change`, orders) and order import through the API are possible next steps;
  they need Anbar on a public server.

## Addendum (November 2026): import and User-Agent
- **Import** (`#/digikala/import`): `GET variants` pages through every seller variant; those whose id is already a
  Digikala listing code are left out. Each gets up to three suggested site products: the variant's `supplier_code`
  equal to a product SKU (ignoring case, spaces and dashes) first, then the closest names (Dice coefficient on
  normalised words). Nothing is linked automatically, because the link decides settlement: a person confirms the
  product and the units of each sale; the confirmed listings are created in one transaction with an audit line
  each and without automatic pricing. The read list is kept in memory for an hour (`preview_id`), so the client
  only sends ids and units.
- **User-Agent:** the live API answered authenticated calls with 401 "Invalid User-Agent!" although the spec only
  requires `content-type`. Digikala support: since 4 Mehr 1405 every self-token request must send
  `User-Agent: DigikalaTrustedBot/SelfToken/<seller code>`. The seller code is the access token's `seller_id`
  claim, so the client builds the header itself; `dk_connection.user_agent` (manager) overrides it if Digikala
  changes the rule. The mock issues JWT-shaped tokens with `seller_id` and enforces the rule (`userAgent: 'trusted'`).
- The self-token is valid for 360 days (the seller panel's own figure), not six months.
