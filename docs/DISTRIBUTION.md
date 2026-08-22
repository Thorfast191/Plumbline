# DISTRIBUTION.md — Shopify App Store readiness

Honest checklist against Shopify's actual requirements, as researched in `docs/PLAN.md`
(Phase 1) and re-confirmed against the current codebase at Phase 8. This is a checklist for
*actual submission*, which is out of scope for this build (no live Shopify Partner app
exists) — it documents what's true today and what remains.

---

## Scopes

- Required: `read_orders`, `read_all_orders`, `read_products`, `read_customers`,
  `read_discounts` (`.env.example` / `docs/PLAN.md` §1).
- **`read_all_orders` is a protected scope subject to Shopify's app review for protected
  customer data** (`docs/PLAN.md` §8, §13 risk #3) — without it, standard `read_orders` only
  returns orders from roughly the last 60 days, which breaks historical backfill entirely.
  This review has never been requested or passed — **no development-store test app has ever
  confirmed `read_all_orders` is actually grantable for this app's use case.** This is the
  single largest distribution risk and was flagged as such in Phase 1; nothing since has
  reduced it, because no live Partner app exists to test it against.

## Mandatory compliance webhooks

Configured via `compliance_topics` in `shopify.app.toml` (which does not exist yet — no
`shopify.app.toml` has been created, since there is no Shopify CLI app scaffold):

| Topic | Required for App Store | Implemented | Tested |
|---|---|---|---|
| `customers/data_request` | Yes | Yes (`packages/sync/src/webhooks.ts`) | Yes (`packages/sync/src/__tests__/compliance-webhooks.test.ts`) |
| `customers/redact` | Yes | Yes | Yes |
| `shop/redact` | Yes | Yes | Yes |
| `app/uninstalled` | Not compliance-mandatory, but expected | Yes | Yes |

All four are HMAC-verified (`packages/connector/src/hmac.ts`) and exercised with realistic
payload shapes in tests. **Never verified against a real Shopify webhook delivery** — the
tests sign payloads with a shared test secret locally; Shopify's actual delivery
infrastructure, retry behavior, and exact payload shape in production have not been observed.

## OAuth / install flow

- Token exchange and refresh (`packages/connector/src/oauth.ts`,
  `packages/sync/src/token-lifecycle.ts`) are implemented and tested against a mocked HTTP
  response — **never against Shopify's actual OAuth endpoint.**
- **There is no install/callback HTTP route.** `installOrReconnectStore` (the function that
  would be called from one) exists and is tested directly, but nothing in `apps/web/app/api`
  wires it to an actual `/auth/callback`-style endpoint yet. A merchant cannot install this
  app today even against a live dev store.
- Exact OAuth merchant-consent screen content was never found in Shopify's docs during Phase
  1 research and remains unverified (`docs/PLAN.md`'s "Unverified items" list, item 1) — still
  open at the end of Phase 8.

## Listing assets

Not started: app icon, screenshots, app listing description, pricing plan configuration,
support contact/URL, privacy policy URL (a real one — the compliance webhook handlers exist,
but no merchant-facing privacy policy document has been written). None of this is
buildable without a real product decision on pricing/positioning, which is out of scope for
this engineering build.

## Review-affecting behavior already covered

- Rate limiting respects Shopify's own reported budget, never fixed sleeps
  (`packages/connector/src/rate-limiter.ts`, Phase 2) — Shopify's review explicitly checks
  for this.
- Webhook HMAC verification on raw body bytes, before parsing (`packages/connector/src/hmac.ts`).
- No metrics computed from live API calls at request time (CLAUDE.md non-negotiable rule,
  held throughout) — sync-then-serve, which is also what Shopify's performance review
  expects.

## Bottom line

The technical mechanics Shopify's review checks (rate limiting, webhook verification,
compliance webhooks, data deletion) are real and tested. The things that require an actual
Partner account — scope grant approval, a working install flow, a live webhook delivery
test, and every listing asset — have not been started, because the account itself does not
exist yet.
