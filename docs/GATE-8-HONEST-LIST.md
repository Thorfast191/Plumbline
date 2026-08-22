# GATE-8-HONEST-LIST.md

`docs/BUILD-SPEC.md` Gate 8, verbatim: **"List everything about this system you would not
want a paying merchant to discover on their own. Do not soften the list."**

This is that list. Ranked roughly by how bad it would be for a merchant to find it first.

---

## 1. No live Shopify store has ever validated any of this

Every phase — connector, sync, webhooks, metrics, recon, reports, alerts — was built and
tested against faithful mocks and a hand-built synthetic dataset (`packages/recon/src/fixtures.ts`).
**Zero bytes of real Shopify data have ever passed through this system.** The 32/32 "recon"
checks that pass on every run prove two independently-written code paths agree with each
other on synthetic data — they do not prove agreement with Shopify's actual admin numbers,
because no comparison against a real number has ever been possible. If this shipped today
and a merchant's real revenue figure didn't match their Shopify admin, that would be the
first time this gap became visible to anyone outside this build process.

## 2. No real email has ever been sent

Scheduled reports and alerts (`packages/report`) are delivered to a mock transport in tests
and a console-logging transport (`ConsoleEmailTransport`) in the real worker process. No SES,
Postmark, SendGrid, or any other provider integration exists. A merchant who set up a weekly
report today would receive nothing.

## 3. There is no authentication or session system anywhere in this application

Every HTTP route — the three CSV upload endpoints (`/api/enrich/*`), both report pages
(`/reports/*`), the metrics page — resolves data by looking up one hardcoded shop domain
(`SEED_SHOP_DOMAIN = "seed-store.myshopify.com"`, `apps/web/lib/report-query.ts`). Nothing in
the HTTP layer today can distinguish which merchant is making a request, because nothing
identifies who's making it. Tenant isolation is real and tested at the database layer (Postgres
RLS, `packages/model/src/__tests__/tenant-isolation.test.ts`), but the HTTP layer has no
per-request tenant routing to even attack yet — Phase 8's "adversarial tenant isolation across
every route and handler" is not fully exercisable until a real session mechanism exists,
because there's currently only ever one reachable tenant. This is the actual blocker before
this could safely serve more than one merchant over HTTP, and it is not close to solved.

## 4. A merchant cannot install this app

Token exchange, refresh, and reconnect logic (`packages/connector/src/oauth.ts`,
`packages/sync/src/token-lifecycle.ts`) is implemented and tested against mocked HTTP
responses. **No `/auth/callback`-style route exists anywhere in `apps/web`.** There is no
code path from "merchant clicks install" to a connected store, even setting aside that no
real Shopify Partner app/credentials exist yet.

## 5. Backfill has no production entrypoint

`runBackfill` (`packages/sync/src/backfill.ts`) is fully built, idempotent, and tested at
10,500+ orders — but it is only ever called from tests. Nothing in `scripts/worker.ts` or
anywhere else triggers it automatically on install, or exposes it as a runnable command. The
"large backfill starves other tenants" scenario `docs/BUILD-SPEC.md` Phase 8 names explicitly
has a tested mitigation mechanism (`TenantBudgetLimiter`, wired into the incremental-sync
loop) but that mechanism has never actually run against a real backfill, because backfill
doesn't run in the worker at all yet.

## 6. Every metric's `owner` field says "unassigned"

`packages/metrics/src/index.ts`: `const OWNER = "Plumbline core (unassigned — no named
metric owner confirmed by the user yet; flag at final review)"`. All 16 registered metrics
carry this. If a merchant ever challenges a number, there is no named person accountable for
its definition — this has been true since Phase 4 and was never resolved because the user was
never asked.

## 7. Six Phase-1 research gaps were never closed

`docs/PLAN.md`'s "Unverified items requiring direct confirmation in Phase 2" — none of these
were ever confirmed, because confirming them requires a real Shopify dev store, which never
existed:

- Exact OAuth merchant-consent screen content/flow
- Cursor stability under concurrent mutation for plain (non-bulk) pagination
- Bulk operation maximum row count / file size
- Whether deleted orders/products soft-delete or hard-disappear from the API
- Timezone basis (shop timezone vs UTC) for Shopify's own Finance report date boundaries —
  **this system assumed UTC throughout** (every metric's `timestampUsed` says so explicitly),
  and that assumption has never been checked against a real Shopify report
- Shopify Payments fee detail availability on the `transactions` field

## 8. The "fees" component of Total Sales is an interpretation, not a confirmed fact

Shopify's own documented formula (cited verbatim in `docs/PLAN.md` §7): "Total sales equates
to gross sales − discounts − sales reversals + taxes + shipping charges + fees." This
system's `total_sales` metric (`packages/metrics/src/index.ts`) interprets "fees" as Shopify
Payments transaction processing fees (`transactions.fee_minor`) — a reasonable reading, but
never independently re-verified. If Shopify's "fees" actually means something else (duties,
other charges), this system's Total Sales figure would silently disagree with the real admin
report the moment a real store connects, and gross/net/total sales are exactly the numbers
CLAUDE.md calls a "P0 bug, never a rounding difference to explain away."

## 9. `read_all_orders` — the scope this entire product depends on — has never been reviewed

Standard `read_orders` only returns orders from roughly the last 60 days. Historical backfill
for a 2-5 year order history (the stated typical store profile) requires `read_all_orders`, a
protected scope gated behind Shopify's app review for protected customer data
(`docs/PLAN.md` §13, risk #3 — the single highest-ranked risk in the entire Phase 1 research).
**This review has never been requested.** If Shopify denies it, or scopes it more narrowly
than assumed, backfill as currently designed does not work, and this was known as the top risk
since day one without ever being tested.

## 10. No production infrastructure exists at all

No hosting target, no CI/CD, no monitoring, no error tracking/alerting on the system's own
health (as opposed to the merchant-facing alerts built in Phase 7), no log aggregation. This
has only ever run as a single local working tree against a local Postgres instance.

## 11. Backup/restore covers per-account data only — there is no real disaster recovery

`packages/model/src/backup.ts`'s export/import is genuinely tested end-to-end (seed → back up
→ fully destroy → restore → recon passes on restored data,
`packages/recon/src/__tests__/backup-restore.test.ts`). But it operates per account, at the
Prisma level. There is no whole-database backup (WAL archiving, scheduled `pg_dump`) — if the
Postgres instance itself were lost, the only recovery path is whatever per-account JSON files
happen to have been manually exported beforehand. Nobody has set up a schedule to do that.

## 12. `TOKEN_ENCRYPTION_KEY` has no rotation procedure

`docs/RUNBOOK.md` documents this honestly: a naive key swap makes every currently-stored
`Store.accessTokenEncrypted`/`refreshTokenEncrypted` permanently undecryptable (AES-256-GCM
with a different key doesn't degrade gracefully — it just fails). No decrypt-with-old,
re-encrypt-with-new migration script exists.

## 13. Email delivery retry policy was tuned for a transport that doesn't exist yet

`packages/report`'s delivery logic retries 3 times, immediately, with no backoff — a
reasonable choice against a mock/console transport with no rate limits, and an explicitly
flagged judgment call at the time (see Phase 7's report). Pointed at a real provider (SES,
Postmark), immediate retries with no backoff could trip that provider's own rate limiting or
look like abuse. This needs to be reconsidered before any real provider is wired in, and
nothing currently forces that reconsideration to happen.

## 14. Compliance webhook redaction/deletion has not been tested under concurrent redelivery

Shopify's webhook delivery is at-least-once with no ordering guarantee (`docs/PLAN.md` §5,
and the reason `packages/sync/src/webhooks.ts` dedupes by `X-Shopify-Webhook-Id` everywhere
else). `shop/redact`'s account-deletion path and `customers/redact`'s anonymization path are
each tested for a single delivery and (for redact) for a same-payload-twice idempotency case,
but not for two *simultaneous* deliveries racing on the same deletion — a real possibility
under Shopify's at-least-once guarantee that this system has not specifically exercised.

## 15. The `Customer` model has nowhere to store the PII it would need to redact

`packages/model/prisma/schema.prisma`'s `Customer` model carries only identifiers and
currency — no name, email, phone, or address field exists anywhere in the schema. The
`customers/redact` handler is "complete" only relative to a schema that doesn't yet capture
any of the data Shopify's real customer object would send. The moment a real sync populates
customer PII (which it will, since `docs/PLAN.md`'s schema design always intended it), this
redaction logic needs to be revisited — it currently has nothing real to redact.

## 16. The apps/web production build was silently broken for two phases before anyone caught it

A webpack module-resolution failure in `next build` (this repo's `.js`-suffixed NodeNext-style
imports weren't mapped back to `.ts` source) was first noticed and reported — but explicitly
left unfixed as "out of scope" — during Phase 4. It was still broken during Phase 5's initial
work, until that same fork discovered it *also* broke `next dev` (not just the production
build, contradicting what Phase 4 had reported) and fixed it via `next.config.mjs`. Confirmed
working now (`pnpm --filter @plumbline/web run build` succeeds cleanly as of Phase 8), but a
merchant-facing app was in a state where its own production build didn't compile for real
work spanning two entire phases, and the severity was initially under-reported.

## 17. A real off-by-one boundary bug already happened once in this codebase

While building Phase 7, the fork's own first-pass implementation of `isDue` (schedule/alert
due-date computation) had an inverted boundary comparison — caught by its own test suite
before being committed, not by external review. This is exactly the class of bug CLAUDE.md
calls "the most common bug in this category of product." It was caught this time. There is no
reason to assume it's the only one, or that the next one will be caught before a merchant sees
a wrong number.

## 18. No human has read most of this code

This entire project — all eight phases — was built by AI agents from a written specification,
verified by another AI agent independently rerunning tests and spot-checking files, with the
user reviewing only at defined checkpoints. That process caught real bugs (items 16 and 17
above are proof it works, not just theory) but it is not equivalent to a human engineer who
has run this against their own Shopify store and looked at their own numbers. That has never
happened.
