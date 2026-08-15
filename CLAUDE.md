# Plumbline

A reporting layer on top of one commerce/CRM platform. Answers the questions the platform
itself cannot, and reconciles to the platform's own numbers exactly.

## What this product is and is not

**This is not a dashboard project.** Charts are the easy 10%. The product is a correct,
resumable data pipeline plus a defensible set of metric definitions. Anyone can render a
line chart; almost nobody gets refunds, partial refunds, multi-currency, timezones, and
cancelled orders right at the same time.

**Trust is the entire product.** If our revenue figure differs from the platform's admin
by even a small amount, the merchant stops believing every other number on the page and
churns. A mismatch is a P0 bug, never a rounding difference to explain away.

**The moat is metric definitions, not visualisation.** Contribution margin after COGS,
shipping, fees and ad spend. Cohort retention by first product. LTV by acquisition
channel. Discount profitability. These require judgment calls the platform refuses to
make — that judgment, written down and defended, is what a competitor cannot copy in a
weekend.

## Commands

```bash
pnpm dev
pnpm typecheck        # must pass before any commit
pnpm lint
pnpm test
pnpm recon            # reconciliation suite against platform-reported figures
pnpm db:migrate
pnpm worker           # sync + aggregation workers
pnpm metrics:lint     # every metric has a definition, an owner, and a recon test
```

Use `pnpm`. Never `npm` or `yarn`.

## Architecture

```
packages/connector    platform API client: auth, cost-aware rate limiting, pagination
packages/sync         backfill, incremental sync, webhook intake, repair loop
packages/model        canonical normalised schema — orders, lines, refunds, customers
packages/metrics      metric registry: definitions, SQL, dependencies, versions
packages/recon        compares our figures to platform-reported figures
packages/enrich       external inputs: COGS, ad spend, shipping cost
packages/report       saved reports, scheduling, delivery
apps/web              reports, metric explorer, sync status, settings
```

Flow: connect store -> backfill history -> incremental sync + webhooks -> normalise ->
aggregate -> reconcile against platform totals -> serve reports.

## The metric that matters

**Reconciliation pass rate**: the percentage of reconciliation checks that match the
platform's own reported figure exactly, across every store and period tested.

Target is 100%. Not 99%. Report the failing checks by name, never as an aggregate
percentage that hides which number is wrong.

Second metric: **sync freshness** — p95 minutes between an event on the platform and it
being reflected in a report.

## Non-negotiable rules

- **Every metric has a written definition in the registry** covering what is included,
  what is excluded, which timestamp it uses, and how it handles refunds, cancellations,
  test orders, and multi-currency. A metric without a definition cannot ship.
- **Every metric has a reconciliation test** against the platform's own figure where the
  platform reports a comparable number. Where it does not, the definition must state that
  explicitly so the merchant knows why it differs.
- **Money is stored as integer minor units.** Never floats, never `number` for currency.
  Every amount carries its currency code. Presentation currency conversion happens at
  read time using the rate stored on the transaction, never a current rate.
- **Timezones are explicit at every layer.** Store timestamps in UTC, aggregate in the
  store's timezone, display in the viewer's timezone. Any function touching a date
  boundary states which timezone it operates in. Off-by-one-day is the most common bug in
  this category of product.
- **Webhooks are a hint, not a source of truth.** They are missed, duplicated, and
  delivered out of order. A scheduled repair loop must re-fetch and reconcile windows
  regardless of webhook delivery.
- **Sync is idempotent and resumable.** Re-running must not duplicate. A crash mid-backfill
  must resume from its cursor, not restart.
- **Rate limits are respected with cost-aware backoff**, driven by the API's own reported
  cost or remaining budget. Never fixed sleeps. Never retry-until-it-works loops.
- **Never compute metrics from live API calls at request time.** Sync, then aggregate,
  then serve. A report that hits the platform API on page load will be slow, will hit
  rate limits, and will break under load.
- **Deleted, cancelled, and test orders are handled explicitly in every metric**, not
  filtered somewhere generic and forgotten.

## Conventions

- TypeScript strict. No `any`. No non-null assertions without a comment.
- All platform API access goes through `packages/connector`. Nothing calls the platform
  SDK directly from a route, job, or component.
- Metric SQL lives in the registry with its definition, not scattered across routes.
- Prisma for relational access; raw SQL for aggregation. Migrations additive.
- Aggregations are materialised on a schedule, not computed per request, above a defined
  row threshold.
- Errors are typed results across package boundaries.

## What not to do

- Do not add a second platform until the first reconciles at 100%
- Do not add a metric because it is easy; add it because a merchant asked and it is
  definable
- Do not build a chart builder or a query builder — opinionated reports are the product
- Do not scaffold unrequested features
- Do not write to `.env*` or `secrets/`
- Do not send merchant data to any unapproved third-party service
