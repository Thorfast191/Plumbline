# PLAN.md — Plumbline Phase 1: Shopify API Research and Plan

Status: research/plan only, zero implementation code, per BUILD-SPEC.md Phase 1.
Date researched: 2026-08-15, against live Shopify developer documentation.

---

## Open inputs still needed from the user

Section 0 of `docs/BUILD-SPEC.md` is still partially unfilled. These do not block the
Shopify API research below, but they materially affect the metric prioritization in
§11/Phase 5 and the risk assessment in §13, and should be filled before Gate 1 closes:

- **Monthly platform spend** (anchors pricing) — not yet provided
- **The three questions the merchant cannot answer today**, in their own words — not yet
  provided. This is the product; do not proceed past Phase 4 without it.
- **What they currently use instead** (CSV → Sheets? nothing?) — not yet provided
- **Typical store size**: orders/month, catalogue size, years of order history — not yet
  provided. This directly determines whether the Phase 3 backfill risk (§13) is
  theoretical or urgent.

Confirmed and used throughout this plan:
- **Platform**: Shopify
- **Buyer**: three personas (store owner, agency managing multiple stores, in-house
  analyst) served as three modules on one account model, not three separate products
- **Tenancy**: account-level, store-scoped — one account holds many stores; every query
  scoped by both `account_id` and `store_id`
- **External data**: COGS (spreadsheet-sourced, needs CSV upload) and ad spend from both
  Meta and Google (not yet connected anywhere)

---

## 1. Auth model

Shopify apps use OAuth 2.0. As of **2026-08-15**, the API surface and token model are:

- **GraphQL-only for new apps.** The REST Admin API became legacy on 2024-10-01, and
  since 2025-04-01 all new public apps must be built exclusively on the GraphQL Admin
  API. Plumbline is a new build in August 2026, so the connector must not depend on any
  REST Admin endpoint. ([Deprecated API calls](https://shopify.dev/docs/api/admin-rest/latest/resources/deprecated-api-calls), [REST deprecation guide](https://www.lazertechnologies.com/insights/shopifys-rest-api-deprecation-and-graphql-migration-guide))
- **Expiring offline access tokens are mandatory for new public apps from 2026-04-01
  onward** — Plumbline falls under this requirement. Access token lifetime is 1 hour
  (`expires_in: 3600`); refresh token lifetime is 90 days (`refresh_token_expires_in:
  7776000`). Refresh tokens are one-time-use: each refresh returns a new access token
  *and* a new refresh token, and the previous refresh token is invalidated. If the
  refresh token isn't used within 90 days, the merchant must reopen the app to
  re-authorize. ([Offline access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens))
- **Online access tokens** (user-scoped, 24h expiry) exist for embedded-app UI actions
  taken as a specific staff user, but are not relevant to background sync — only offline
  tokens matter for the connector.
- **Scopes** are requested as a comma-separated list at install (e.g.
  `read_orders,read_products,read_customers`). Practical minimum scope set for Plumbline:
  `read_orders`, `read_all_orders` (needed to read orders older than 60 days — see
  gotcha in §8), `read_products`, `read_customers`, `read_discounts`. Confirm
  `read_all_orders` requirement with a protected-customer-data access review, since
  Shopify gates it behind app review for orders/customer PII.
  ([Access tokens overview](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens))
- **What the merchant approves**: not documented in the fetched pages (flagged
  unverified) — the OAuth permission screen shows the requested scopes in
  merchant-readable form before install, but the exact screen content/flow was not
  available from the pages fetched. Needs direct verification against a live OAuth
  install flow on a development store before Phase 2.

## 2. Rate limiting — the exact mechanism

The GraphQL Admin API uses a **cost-based leaky-bucket** model, not fixed windows or
raw request counts:

- Each shop/app pair gets a bucket with a maximum capacity (`maximumAvailable`) that
  drains as queries execute and **refills at a fixed points-per-second restore rate**:

  | Plan | Points/second (restore rate) |
  |---|---|
  | Standard | 100 |
  | Advanced Shopify | 200 |
  | Shopify Plus | 1000 |
  | Enterprise (Commerce Components) | 2000 |

  ([Shopify API limits](https://shopify.dev/docs/api/usage/limits))

- **A single query cannot exceed 1000 points of requested cost**, regardless of plan.
- **Cost accounting is two-phase**: `requestedQueryCost` is calculated and checked
  against available bucket capacity *before* the query executes; after execution,
  `actualQueryCost` is computed and the bucket is refunded the difference between
  requested and actual cost. This means an app should read `actualQueryCost`, not
  `requestedQueryCost`, to know what was really spent.
- **Every response carries live budget state** under `extensions.cost`:
  ```json
  "extensions": {
    "cost": {
      "requestedQueryCost": 42,
      "actualQueryCost": 38,
      "throttleStatus": {
        "maximumAvailable": 2000,
        "currentlyAvailable": 1958,
        "restoreRate": 100
      }
    }
  }
  ```
  The connector must read `throttleStatus.currentlyAvailable` and `restoreRate` from
  every response and use them to pace the *next* request — computing wait time as
  `(neededCost - currentlyAvailable) / restoreRate` when insufficient — rather than
  using fixed sleeps or blind retry-on-429 loops, per CLAUDE.md's rate-limiting rule.
  ([Shopify API limits](https://shopify.dev/docs/api/usage/limits), [Rate limiting GraphQL APIs by calculating query complexity](https://shopify.engineering/rate-limiting-graphql-apis-calculating-query-complexity))
- Bulk Operations (§4) are the pressure release valve: the mutation call to *start* a
  bulk operation costs normal points, but the actual data extraction the bulk operation
  performs is **not** metered against this bucket at all.

## 3. Pagination model and cursor stability

- Standard GraphQL list fields (`orders`, `products`, etc.) paginate via the Relay
  cursor-connection pattern: `edges { cursor node { ... } } pageInfo { hasNextPage
  hasPreviousPage }`. Cursors are opaque, forward-only by default (`after:` + `first:`).
- Cursor stability under concurrent mutation was **not verified from a live source** in
  this research pass — flagged unverified. Shopify's Relay-style cursors are generally
  position-stable for appends but the exact behavior when a record inside an
  already-paginated window is deleted or reordered was not confirmed. Practical
  implication for Plumbline: incremental (non-bulk) paginated syncs should always be
  bounded by `updated_at` filters and re-verified by the repair loop (Phase 3) rather
  than trusted for exact completeness — consistent with CLAUDE.md's "webhooks are a
  hint" philosophy extended to plain pagination too.

## 4. Bulk / async export for historical backfill

Shopify's **Bulk Operations API** (`bulkOperationRunQuery`) is the correct mechanism for
backfilling years of order history — a paginated REST/GraphQL loop is explicitly not
viable per BUILD-SPEC.md and this confirms why a better path exists:

- Submit a GraphQL query (must contain at least one connection field, max 5 connections,
  max 2 levels of nesting) via the `bulkOperationRunQuery` mutation. Shopify runs it
  asynchronously in the background.
  ([bulkOperationRunQuery](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationRunQuery), [Bulk operations guide](https://shopify.dev/docs/api/usage/bulk-operations/queries))
- **Results are streamed as JSONL** (one JSON object per line) to a temporary URL;
  nested connection children appear as separate lines carrying a `__parentId` field
  linking back to their parent — this maps cleanly onto a streaming line-by-line
  upsert rather than loading the whole export into memory.
- **The only rate-limit cost is the mutation submission itself** — the actual bulk data
  extraction is not metered against the leaky bucket at all. This is the practical
  answer to BUILD-SPEC.md item 4/13: bulk export is both the *only* viable path and a
  cheap one, cost-wise.
- **Completion**: poll `bulkOperation(id:)` (2026-01+ API versions) or subscribe to the
  `bulk_operations/finish` webhook; `objectCount` gives live progress.
- **Concurrency**: API versions before 2026-01 allowed only **one** bulk query operation
  per shop at a time; **2026-01+ allows up to 5 concurrent bulk operations per shop**.
  Plumbline should target 2026-01+ and can run backfills for several resource types
  (orders, products, customers) in parallel per store.
- **Hard limits**: a bulk operation must complete within **10 days** or it fails; result
  files remain downloadable for **7 days** after completion. Neither a maximum row count
  nor a maximum file size is documented — not verified, flagged as an open question to
  test empirically against the eventual 10k+-order test store in Phase 3.
- Bulk queries on `orders` support filtered date ranges (e.g. `created_at:>=2020-05-01`),
  which is what backfill chunking (§10) should use to create resumable windows.
- **No query variables** are supported inside a bulk operation — the query must be a
  literal string, so backfill chunk boundaries (date ranges) must be interpolated into
  the query text by the caller, not passed as GraphQL variables.

## 5. Webhooks: topics, delivery guarantees, failure modes

- **Delivery guarantee is at-least-once, with no ordering guarantee** — Shopify states
  explicitly that, e.g., a `products/update` webhook can arrive before the corresponding
  `products/create`, and recommends using `X-Shopify-Triggered-At` (header) or the
  payload's own `updated_at` to sequence events rather than trusting arrival order.
  ([About webhooks](https://shopify.dev/docs/apps/build/webhooks))
- **Duplicate delivery is expected, not exceptional** — dedupe on `X-Shopify-Webhook-Id`.
- **HMAC verification**: every HTTPS delivery includes a base64-encoded HMAC-SHA256
  signature in the `X-Shopify-Hmac-Sha256` header, computed over the **raw** request
  body using the app's client secret as the key. Verification must happen on the raw
  bytes before any JSON parsing/re-serialization, since re-serialized JSON will not
  reproduce the same signature. ([Verify webhook deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries))
- **Relevant topics for Plumbline**: `orders/create`, `orders/updated`,
  `orders/cancelled`, `orders/fulfilled`, `refunds/create`, `customers/create`,
  `customers/update`, `customers/delete`. (Full topic catalogue: [Webhooks reference](https://shopify.dev/docs/api/webhooks/latest))
- **Mandatory compliance webhooks** (required for App Store distribution, configured via
  `compliance_topics` in `shopify.app.toml`):
  - `customers/data_request` — merchant's customer requested their data; app must
    surface anything it holds
  - `customers/redact` — merchant or customer requested deletion; app must erase that
    customer's data
  - `shop/redact` — fires **48 hours after app uninstall**, carrying `shop_id` and
    `shop_domain`; app must erase all data for that store
  ([Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance))
- Given the at-least-once/no-ordering guarantees, CLAUDE.md's rule that "webhooks are a
  hint, not a source of truth" is not a defensive over-engineering choice — it is
  required by Shopify's own documented behavior.

## 6. Data model for revenue-correct computation

Core `Order` object fields relevant to Plumbline, from the GraphQL Admin API
([Order object reference](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order)):

- **Currency**: `currencyCode` (shop's currency at order time) vs
  `presentmentCurrencyCode` (currency the customer actually saw/paid in) — these differ
  on multi-currency stores and must both be captured; conversion for reporting should
  use the rate implied by the order's own captured amounts, never a current/live rate
  (per CLAUDE.md).
- **Money fields are `MoneyBag`s** carrying both `shopMoney` and `presentmentMoney`
  amounts side by side — store both.
- **"current" vs non-"current" prefixed totals**: `totalPriceSet`/`subtotalPriceSet`/
  `totalDiscountsSet`/`totalTaxSet`/`totalShippingPriceSet` reflect the order **as
  originally placed**; `currentTotalPriceSet`/`currentSubtotalPriceSet`/
  `currentTotalDiscountsSet`/`currentTotalTaxSet`/`currentShippingPriceSet` reflect the
  order **after refunds and edits**. Reconciling against Shopify's net/total sales
  reports (§7) requires using the *current* fields net of refunds for revenue formulas,
  and the original fields only when explicitly computing gross-as-placed.
- **Refunds**: `refunds` connection on Order, each with its own price breakdown,
  processed date, and line-item-level detail — refund timestamp (not order timestamp) is
  what Shopify's own "sales reversals" figure keys off (§7), so the canonical schema
  needs a `refund.processed_at` distinct from `order.created_at`.
- **Discounts**: `discountApplications` connection distinguishes discount-code
  application from automatic/script discounts — needed to separate "discount
  profitability" (Phase 5) by discount type.
- **Transactions**: `transactions` field carries payment captures/voids — this is the
  path to processor/payment fees, though Shopify Payments fee detail was not verified in
  this pass (flagged unverified — needs direct API exploration in Phase 2).
- **Status/lifecycle**: `test` (boolean, excludes from reporting — see §8),
  `displayFinancialStatus`, `displayFulfillmentStatus`, `cancelledAt`, `closedAt`,
  `taxesIncluded` (whether subtotal already includes tax), `taxExempt`.
- **Timing**: `createdAt` (checkout completion) vs `processedAt` (may differ for
  deferred/manual payment capture) — Shopify's admin reports attribute sales to the
  order's placement date and returns to the refund's processed date (§7), so metric
  definitions must be explicit about which timestamp they use, per CLAUDE.md's
  timezone/timestamp rule.

## 7. Shopify's own admin report definitions (reconciliation targets)

Verbatim, from Shopify's Help Center Finance report documentation
([Finance reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/finances-report)):

| Figure | Shopify's definition (verbatim) | Timing |
|---|---|---|
| **Gross sales** | "Equates to product selling price × ordered quantity. Gross sales does not include discounts, sales reversals, taxes, shipping, or fees." | Order placement date |
| **Discounts** | "Equates to product discount + the product's proportional share of a cart-wide discount." | Displayed as negative, on order placement date |
| **Sales reversals (returns)** | "The value of goods returned by a customer." | Negative, on the date the return was **processed** (not order date) |
| **Net sales** | "Equates to gross sales − discounts − sales reversals. Net sales does not include shipping charges or taxes." | — |
| **Shipping** | Positive on sale date, negative on refund date; "Refunded shipping charges and their taxes don't display in the Sales reversals column" (i.e. shipping refunds are tracked separately, not folded into returns) | Sale / refund date |
| **Taxes** | Applied to items and shipping separately; positive on sale date, negative on refund date | Sale / refund date |
| **Total sales** | "Equates to gross sales − discounts − sales reversals + taxes + shipping charges + fees" | — |

This gives the exact Phase 4 reconciliation formula chain: `total sales = gross sales -
discounts - sales reversals + taxes + shipping + fees`, and confirms that **returns are
booked on refund-processed date, not order date** — a timestamp distinction the
canonical schema and every affected metric definition must encode explicitly. Timezone
of these figures was not stated in the fetched page — flagged unverified; needs
confirmation against the store's configured timezone setting before Phase 4 (Shopify
admin reports are widely understood to use the shop's configured timezone, but this
needs a live-account check, not a training-data assumption).

## 8. Known gotchas

- **Test orders**: identified by `test: true` on the Order object, created via the
  Shopify Bogus Gateway or a payment provider's test mode. Shopify's own analytics
  already exclude these from sales metrics — Plumbline's sync should tag and exclude
  them explicitly (not rely on absence) so the exclusion is auditable.
  ([Order object](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order))
- **`read_all_orders` scope**: standard `read_orders` only returns orders from roughly
  the last 60 days for apps without the extended scope — any historical backfill beyond
  that window requires the `read_all_orders` protected scope, which is subject to
  Shopify's app review for protected customer data. This is a Phase 1 risk item (§13),
  not just a footnote.
- **Draft orders vs orders**: draft orders are a distinct GraphQL type (`DraftOrder`),
  not included in the `orders` connection, and are not counted in Shopify's sales
  figures until converted to a real order — the canonical schema must not conflate them.
- **Deleted/archived records**: not verified from a live source in this pass how deleted
  orders/products surface (soft-delete flag vs hard removal from API responses) —
  flagged unverified, needs empirical check against a dev store in Phase 2.
- **Multi-currency**: shop currency (`currencyCode`) vs presentment currency
  (`presentmentCurrencyCode`) diverge whenever a customer checks out in a currency
  different from the shop's base — both must be persisted (§6); Shopify's own admin
  reports are computed in shop currency, so recon in Phase 4 must compare shop-currency
  figures, not presentment.
- **Timezone**: Shopify report figures are attributed by calendar date, but the fetched
  documentation did not state explicitly whether that date boundary is the shop's
  configured timezone or UTC — flagged unverified, must be confirmed empirically (create
  a test order just before/after local midnight on a dev store and check which day it
  lands in on the admin Finance report) before Phase 4 reconciliation work begins.
- **GraphQL API versioning**: Shopify ships quarterly versioned API releases; this
  research was done against `latest`/`2026-01`+ documentation. Pin an explicit API
  version in the connector (not `unstable`/`latest`) and track version-deprecation
  notices, since field availability (e.g. `bulkOperation(id:)` vs deprecated
  `currentBulkOperation`) changed between versions during this research.

---

## 9. Canonical normalised schema

Account-level, store-scoped tenancy: every row below carries `account_id` **and**
`store_id`; unique constraints and indexes are scoped to `(account_id, store_id, ...)`.

```
accounts
  id, name, created_at

stores                                  -- one Shopify shop per row
  id, account_id FK, shop_domain, shop_currency,
  shop_timezone,                        -- needed per CLAUDE.md's explicit-timezone rule
  access_token_encrypted, refresh_token_encrypted, token_expires_at,
  scopes, installed_at, uninstalled_at (nullable)
  UNIQUE (shop_domain)                  -- Shopify shop identity is global, not per-account

orders
  id, account_id FK, store_id FK, shopify_order_id,
  created_at, processed_at, cancelled_at (nullable), closed_at (nullable),
  test (bool),
  currency_code, presentment_currency_code,
  gross_sales_minor, discounts_minor, shipping_minor, taxes_minor,
  current_subtotal_minor, current_total_minor,   -- refund-adjusted, per §6
  display_financial_status, display_fulfillment_status,
  synced_at, source ('backfill' | 'incremental' | 'webhook' | 'repair')
  UNIQUE (store_id, shopify_order_id)
  INDEX (store_id, created_at)          -- date-range report queries
  INDEX (store_id, processed_at)        -- distinct from created_at, see §6/§7

order_line_items
  id, order_id FK, shopify_line_item_id, product_id, variant_id, sku,
  quantity, price_minor, discount_minor, currency_code
  UNIQUE (order_id, shopify_line_item_id)
  INDEX (order_id)

refunds
  id, account_id FK, store_id FK, order_id FK, shopify_refund_id,
  processed_at,                          -- the date Shopify books the reversal, per §7
  amount_minor, shipping_refund_minor, tax_refund_minor, currency_code
  UNIQUE (store_id, shopify_refund_id)
  INDEX (store_id, processed_at)         -- returns are booked on this date, not order date

refund_line_items
  id, refund_id FK, order_line_item_id FK, quantity, amount_minor
  INDEX (refund_id)

discounts
  id, order_id FK, application_type ('code' | 'automatic' | 'script'),
  code (nullable), amount_minor, currency_code
  INDEX (order_id)

transactions
  id, account_id FK, store_id FK, order_id FK, shopify_transaction_id,
  kind ('sale' | 'refund' | 'void' | 'capture'), status, amount_minor,
  fee_minor (nullable),                  -- populated once Phase-2 exploration confirms field
  currency_code, processed_at
  UNIQUE (store_id, shopify_transaction_id)

customers
  id, account_id FK, store_id FK, shopify_customer_id,
  created_at, first_order_id FK (nullable),  -- for cohort/LTV metrics, Phase 5
  currency_code
  UNIQUE (store_id, shopify_customer_id)

webhook_events                           -- dedup + audit trail, per §5
  id, store_id FK, shopify_webhook_id, topic, received_at, payload_hash,
  status ('processed' | 'duplicate' | 'failed')
  UNIQUE (store_id, shopify_webhook_id)

sync_state                               -- Phase 3 cursor/watermark persistence
  id, store_id FK, resource ('orders' | 'products' | 'customers'),
  kind ('backfill' | 'incremental'),
  cursor (nullable), watermark_at (nullable), status, updated_at
  UNIQUE (store_id, resource, kind)

enrich_cogs                              -- Phase 5 external data
  id, account_id FK, store_id FK, sku, cost_minor, currency_code,
  effective_from, source ('csv_upload')

enrich_ad_spend                          -- Phase 5 external data
  id, account_id FK, store_id FK, channel ('meta' | 'google'),
  date, spend_minor, currency_code, source ('csv_upload' | 'api')
```

Money is integer minor units + currency code on every monetary column, per CLAUDE.md.
Every FK relationship additionally carries `account_id` redundantly on child tables
(rather than requiring a join through `store_id` to enforce tenancy) so that row-level
isolation policies can filter on `account_id` directly without a join — this is the
Phase 2 tenant-isolation test's primary attack surface.

## 10. Sync architecture

- **Backfill**: one `bulkOperationRunQuery` per store per resource type (orders,
  customers, products), chunked into date-range windows (e.g. by year) so each window
  is independently resumable and so `sync_state.watermark_at` can advance
  window-by-window rather than all-or-nothing. On crash, resume from the last completed
  window's watermark, not from the start. Given up to 5 concurrent bulk operations
  (2026-01+, §4), orders/customers/products backfills can run in parallel per store.
- **Incremental sync**: scheduled GraphQL query (not bulk — bulk has multi-minute
  latency) filtered by `updated_at:>` the last successful watermark, on a short interval
  (e.g. every 5–15 minutes), reading `throttleStatus` each call to self-pace per §2.
- **Webhook intake**: verify HMAC on raw body (§5) before parsing; upsert into
  `webhook_events` keyed on `(store_id, shopify_webhook_id)` — if the row already exists,
  mark `duplicate` and skip processing; otherwise process and mark `processed`. Because
  ordering isn't guaranteed, the upsert into `orders`/`refunds` must be a "last write
  wins by resource `updated_at`" merge, never a blind overwrite.
- **Repair loop**: scheduled job (e.g. hourly) that re-runs the same incremental query
  logic over a trailing window (e.g. last 48 hours) regardless of webhook activity, diffs
  against what's stored, and logs a correction row whenever it finds a mismatch. This is
  the mechanism that catches webhooks Shopify never delivered.
- **Double-counting avoidance**: all four paths (backfill, incremental, webhook, repair)
  converge on the same idempotent upsert keyed on `(store_id, shopify_order_id)` /
  `(store_id, shopify_refund_id)` / etc., using the Shopify resource's own id as the
  natural key — never an auto-increment insert. Idempotency is a property of the upsert
  key, not of coordinating which path runs when.

## 11. Initial metric list

**(a) Reconcilable against Shopify's own admin reports** (Phase 4 baseline, per §7's
exact formulas):
- Gross sales, discounts, sales reversals (returns), net sales, shipping, taxes, total
  sales, order count — each keyed to the same date attribution Shopify uses (order
  placement date for sales/discounts, refund-processed date for returns).

**(b) Definable but not reconcilable** (no Shopify equivalent to check against):
- Cross-store agency rollups (sum/compare across an account's stores) — Shopify's admin
  is inherently single-store, so this entire category, which exists specifically to
  serve the agency buyer persona, has no reconciliation target by construction. Document
  this explicitly to the merchant rather than treating it as a gap.
- Cohort retention by first-order month/product, repeat purchase interval, discount-type
  (code vs automatic) profitability without cost data, returns by variant/cohort.

**(c) Requiring external data** (COGS + Meta/Google ad spend, per confirmed Section 0):
- Contribution margin (revenue − COGS − shipping cost − payment fees − ad spend), LTV by
  acquisition channel, discount profitability *with* margin (not just revenue), all of
  Phase 5's headline metrics.

## 12. Package boundaries and exports

Matches CLAUDE.md's architecture:

- `packages/connector` — exports a typed Shopify client: OAuth install/refresh, a
  `graphql()` call that returns `{ data, cost: ThrottleStatus }`, a `bulkQuery()`
  helper that submits/polls/streams JSONL, and webhook HMAC verification. Nothing above
  this package ever imports a Shopify SDK directly, per CLAUDE.md.
- `packages/sync` — backfill orchestration (window chunking, resume), incremental sync
  job, webhook intake handler, repair loop job. Depends on `connector` and `model`.
- `packages/model` — Prisma schema (§9) and typed repository functions (upsert-by-natural-key
  for every entity). No package outside `model` writes to these tables directly.
- `packages/metrics` — the registry (Phase 4): each metric's definition object + its SQL,
  keyed by id/version. Depends on `model`.
- `packages/recon` — runs each metric's SQL against real data and compares to a
  Shopify-reported figure fetched via `connector` for the same store/period; depends on
  `metrics` and `connector`.
- `packages/enrich` — CSV upload parsing/validation for COGS and ad spend, writes to
  `enrich_cogs`/`enrich_ad_spend`. No dependency on `connector`.
- `packages/report` — saved report definitions, scheduling, email delivery (Phase 7).
  Depends on `metrics`.
- `apps/web` — reports UI, metric explorer, sync status, settings; depends on all
  packages above but contains no direct Shopify or database access of its own.

## 13. Three highest risks for week one

1. **Backfill viability for a large store is not yet empirically confirmed.** The Bulk
   Operations API is the right mechanism (§4) and its rate-limit cost is negligible, but
   the *actual* wall-clock duration for a multi-year, 10,000+-order store — which is
   Phase 3's own test threshold — was not documented (no row/size limit found; 10-day
   hard ceiling and 7-day result-availability window were the only limits confirmed).
   **De-risk**: run a real `bulkOperationRunQuery` against a large seeded/development
   store in the first days of Phase 2, before committing to the full window-chunking
   design in §10, and measure actual completion time. If it's slow, per-year windowing
   (already in the §10 design) is the mitigation, but this needs validating against
   real timing, not assumed.

2. **Cross-store agency rollups have zero reconciliation target, by construction (§11b).**
   Because Shopify's own admin is single-store, there is nothing to check Plumbline's
   agency-facing multi-store numbers against — the entire trust mechanism the product is
   built around (§7, CLAUDE.md's "reconciliation pass rate" north-star metric) doesn't
   apply to this buyer module. **De-risk**: make the account-level rollup metrics
   *provably* correct by construction instead — every cross-store total must be a
   verifiable sum of already-reconciled single-store figures (from §11a) with no
   independent aggregation logic that could silently diverge, and this must be covered
   by a same-package unit test (sum of parts equals whole) even though it can't be a
   `pnpm recon` check against an external source of truth.

3. **`read_all_orders` is a protected scope subject to Shopify app review (§8).** Without
   it, historical order access is capped at roughly the last 60 days, which breaks the
   entire backfill premise of the product for any merchant with meaningful order
   history. **De-risk**: confirm in week one — before building the OAuth flow — that a
   development-store test app can actually be granted `read_all_orders` under Shopify's
   current protected-customer-data review process, and understand the approval lead time
   before it becomes a blocker to onboarding real merchants.

---

## Unverified items requiring direct confirmation in Phase 2

- Exact OAuth merchant-consent screen content/flow (not found in fetched docs)
- Cursor stability under concurrent mutation for plain (non-bulk) pagination
- Bulk operation maximum row count / file size (only the 10-day/7-day time limits were
  documented)
- Whether deleted orders/products soft-delete or hard-disappear from the API
- Timezone basis (shop timezone vs UTC) for Shopify's own Finance report date boundaries
- Shopify Payments fee detail availability on the `transactions` field
