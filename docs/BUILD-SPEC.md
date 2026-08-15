# BUILD-SPEC.md — Plumbline

Save at `docs/BUILD-SPEC.md` alongside `CLAUDE.md`.

---

## 0. Fill this in before anything else

| Field | Value |
|---|---|
| Platform for v1 | `<FILL IN — ONE. e.g. "Shopify">` |
| Who buys this | `<FILL IN — store owner? agency managing 20 stores? in-house analyst?>` |
| Their monthly platform spend | `<FILL IN — anchors what they will pay you>` |
| The three questions they cannot answer today | `<FILL IN — be specific, in their words>` |
| What they use instead | `<FILL IN — exported CSV into Google Sheets? nothing?>` |
| Typical store size | `<FILL IN — orders/month, catalogue size, years of history>` |
| Multi-store? | `<FILL IN — decides whether tenancy is store-level or account-level>` |
| External data they have | `<FILL IN — COGS in a sheet? ad spend in Meta? shipping invoices?>` |

Row 4 is the product. If those three questions are things the platform already answers,
there is no product — stop and find better questions before writing code.

Row 8 decides whether you can build profit metrics or only revenue metrics. Profit is
where the money is; revenue reporting is closer to commodity.

---

## 1. How to work through this document

Eight phases with exit gates. **Stop at every gate, report the evidence, wait for my
approval.** Do not chain phases.

Re-read `CLAUDE.md` and this file at the start of each phase. Do not rely on memory of
earlier turns.

At the end of each phase state what passed, what failed, and what you are unsure about.

---

## Phase 1 — API research and plan

**No implementation code.**

Research the platform's actual API as it exists today. Cite sources with URLs; do not
answer from training data, and flag anything you could not verify.

1. Auth model, token lifecycle, scopes needed, and what a merchant must approve.
2. **Rate limiting: the exact mechanism.** Cost-based, leaky bucket, fixed window? What
   does the API tell us about remaining budget, and how do we read it? Design backoff
   around the real mechanism, not a guess.
3. Pagination model and cursor stability. What happens if data changes mid-pagination?
4. Bulk or async export endpoints for historical backfill, if they exist. Backfilling
   five years of orders through a paginated REST endpoint is not viable; find out now.
5. Webhook topics available, their delivery guarantees, and their known failure modes.
6. The data model for orders, line items, refunds, discounts, taxes, shipping,
   transactions, fees, customers. Note every field needed to compute revenue correctly.
7. **What the platform's own admin reports, and exactly how it defines each figure.**
   These are our reconciliation targets. Where the platform documents its definition,
   record it verbatim as a citation.
8. Known gotchas: test orders, draft orders, deleted records, archived products,
   currency handling on multi-currency stores, timezone of reported figures.

Then the plan:

9. Canonical normalised schema, platform-agnostic where cheap, platform-specific where
   honest. Every index justified.
10. Sync architecture: backfill strategy, incremental cursor, webhook intake, repair loop
    cadence, and how the three interact without double-counting.
11. The initial metric list, split into: reconcilable against the platform, definable but
    not reconcilable, and requiring external data.
12. Package boundaries and exports.
13. The three highest risks and how to de-risk each in week one. Include the risk that
    backfill for a large store is too slow or too expensive to be viable.

**Gate 1:** Research and plan in `docs/PLAN.md` with sources. I have read and approved.

---

## Phase 2 — Schema, connector, rate limiting

- Prisma schema for the canonical model; migration applied
- Package skeletons with typed interfaces; bodies throw `not implemented`
- Connector with real auth against a development store
- **Cost-aware rate limiting proven under load**: a test that fires enough requests to hit
  the limit and demonstrates the client backs off correctly and never gets throttled out
- Money stored as integer minor units with currency, enforced by the type system
- Tenant isolation at row level, with a test proving A cannot read B
- Seed: one connected store

**Gate 2:** `pnpm typecheck` passes, migration applies, isolation test passes, rate limit
test passes. Show the rate-limit test output, including what the API reported about
remaining budget during the run.

---

## Phase 3 — Sync

The hardest phase. Everything downstream is worthless if this is wrong.

- Historical backfill using the bulk/async path from Phase 1 where available, with a
  cursor persisted so a crash resumes rather than restarts
- Incremental sync on a schedule
- Webhook intake with signature verification, deduplication by event id, and out-of-order
  tolerance
- **Repair loop**: on a schedule, re-fetch recent windows and reconcile against what we
  hold, correcting silently missed or dropped webhooks. Log every correction — a rising
  correction count means the webhook path is degrading.
- Sync status per store: last successful sync, current cursor, pending backfill progress,
  error state, visible in the UI
- Idempotency proven: re-running backfill over the same window produces zero duplicates

Test against a store with at least 10,000 orders. A pipeline that works on 50 orders tells
us nothing.

**Gate 3:** Report backfill duration and API cost for the test store, duplicate count
after a deliberate double-run, and the number of corrections the repair loop made in 24
hours. Report the corrections honestly — a nonzero number is expected and informative.

---

## Phase 4 — Metric registry and reconciliation, together

Metrics without reconciliation are guesses with charts on top.

Registry:
- Each metric: id, name, plain-language definition, inclusions, exclusions, timestamp
  used, refund handling, currency handling, SQL, dependencies, version, owner
- `pnpm metrics:lint` fails if any metric lacks a definition or a recon test
- Definitions are visible to the merchant in the UI, not buried in docs

Reconciliation:
- `pnpm recon` compares our computed figures against the platform's own reported figures
  for the same period and store
- Runs across multiple periods: single day, month, year, and a period containing refunds,
  a cancellation, a discount, and a multi-currency order
- Reports each check by name with our figure, theirs, and the delta
- Any nonzero delta is a failure, not a warning

Start with the smallest set: gross sales, discounts, returns, net sales, shipping, taxes,
total sales, order count. Get these to exact before adding anything interesting.

**Gate 4:** Show the full recon report. **Do not proceed with any failing check.** If a
delta cannot be resolved, the correct outcome is a documented definition difference shown
to the merchant, not a silently adjusted number.

---

## Phase 5 — The metrics that justify the product

Only now build what the platform cannot do. Each one still needs a registry definition.

- Contribution margin: revenue minus COGS, shipping cost, payment fees, and optionally ad
  spend, per order, per SKU, per channel
- Cohort retention by first-order month and by first product
- LTV by acquisition channel, with the cohort maturity stated so nobody reads a 30-day
  cohort as a lifetime figure
- Repeat purchase interval and reorder timing
- Discount profitability: margin on discounted versus full-price orders
- Returns by variant and cohort

External data intake for COGS and ad spend: CSV upload at minimum. API integration only
if Phase 1 research showed it is feasible within scope.

**Where a metric depends on estimated or user-supplied inputs, the UI must say so.** A
confident-looking margin number built on a guessed COGS is worse than no number.

**Gate 5:** Demo each metric against the test store, with its definition visible, and
state which inputs are estimated.

---

## Phase 6 — Reports interface

- A small set of opinionated reports, not a query builder
- Every figure hover-reveals its definition
- Date range with explicit timezone shown
- Comparison periods handled correctly across month lengths and DST
- Export to CSV matching what is on screen exactly
- Sync status and data freshness visible on every report

No chart builder, no custom dashboards, no theming. Say so and wait if you think something
else is needed.

**Gate 6:** Demo walkthrough. Verify an exported CSV matches the on-screen figures.

---

## Phase 7 — Scheduled reports and alerts

This is the retention feature. A dashboard is visited twice; an email arrives every week.

- Scheduled report delivery by email on a cadence the merchant sets
- Threshold alerts: margin below X, returns above Y, a SKU's velocity dropping
- Alerts state the figure, the threshold, the period, and link to the report
- Delivery log with retry

**Gate 7:** Deliver a scheduled report and trigger one alert end to end.

---

## Phase 8 — Hardening and distribution readiness

- Adversarial tenant isolation across every route and handler
- Token refresh, revocation, and reconnect flow when a merchant uninstalls and reinstalls
- Behaviour when the platform API is down or degraded: reports serve stale data with a
  clear freshness warning, never a blank page or a wrong number
- Backfill for a very large store does not starve other tenants' syncs
- Per-tenant rate limits and cost caps on our side
- GDPR/data deletion path: a merchant requests deletion, everything goes
- Backup and restore, with a recon run after restore to prove integrity
- Runbook: deploy, roll back, re-backfill a store, resolve a recon failure, rotate keys
- If distributing through the platform's app store: review requirements, required webhooks
  (including mandatory compliance webhooks), and listing assets

**Gate 8:** List everything about this system you would not want a paying merchant to
discover on their own. Do not soften the list.

---

## Standing rules

- A recon delta is a bug until proven to be a documented definition difference
- Never add a metric without a definition and a recon test
- One change at a time when fixing a recon failure; re-run `pnpm recon` after each
- State the timezone in any function that touches a date boundary
- Say plainly when something is not working

---

## Mid-build prompts

**A reconciliation check fails:**
> Check `<NAME>` is off by `<AMOUNT>`. Show me the individual orders contributing to both
> figures and find the ones that differ. Determine whether this is a sync gap, a
> definition difference, a timezone boundary, or a currency conversion issue before
> changing anything. Do not adjust the metric to make the number match — find the cause.

**Sync is too slow or too expensive:**
> Report backfill duration and API cost broken down by resource type and by phase. Show
> where the budget is actually going before proposing optimisations. Is there a bulk
> endpoint we are not using?

**Adding a metric:**
> Add `<METRIC>`. Write the definition first — inclusions, exclusions, timestamp, refund
> and currency handling — and show it to me before writing SQL. Then add a recon test if
> the platform reports a comparable figure, or document why it cannot be reconciled.

**Adding a platform:**
> Adding `<PLATFORM>` as a second connector. Identify what in the canonical model is
> over-fitted to the first platform, and what must stay platform-specific. Resist forcing
> a shared abstraction where the platforms genuinely differ — a leaky abstraction here
> produces wrong numbers, which is worse than duplicated code.
