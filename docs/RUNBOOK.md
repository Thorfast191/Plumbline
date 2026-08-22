# RUNBOOK.md — Plumbline

Operational procedures. Every command below is real and has been run against this repo's
actual dev/test databases while writing this document — none of it is generic advice.

See also `docs/GATE-8-HONEST-LIST.md` (what's genuinely unproven) and `docs/DISTRIBUTION.md`
(Shopify App Store readiness).

---

## Deploy

There is no production environment yet — no live Shopify Partner app, no hosting target,
no CI/CD pipeline. What exists and is real:

```bash
pnpm install
tsx scripts/provision-identity-role.ts   # one-time: creates the plumbline_identity role (see below)
pnpm db:migrate                          # applies packages/model/prisma/migrations/* via DATABASE_URL_MIGRATE
pnpm -r run typecheck                    # must be clean
pnpm recon                               # must be 32/32, zero delta
pnpm metrics:lint                        # must pass
pnpm --filter @plumbline/web run build   # must succeed (confirmed clean as of Phase 8)
pnpm worker                              # long-running: incremental sync, repair, scheduled reports, alerts
```

A real deploy still needs, at minimum: a Postgres instance reachable from the deploy target,
`DATABASE_URL` / `DATABASE_URL_MIGRATE` / `DATABASE_URL_IDENTITY` (+ `_TEST` variants for CI)
pointed at it, `TOKEN_ENCRYPTION_KEY` set to a real secret (not the local dev placeholder in
`.env.example`), and real `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` once a Partner app exists.
None of that infrastructure exists today.

### Roles this system depends on

- `postgres` (or another superuser) — migrations, GDPR deletion cascade
  (`packages/model/src/deletion.ts`), backup/restore. `DATABASE_URL_MIGRATE`.
- `plumbline_app` — the application's normal runtime role. Non-superuser, RLS-bound.
  `DATABASE_URL`.
- `plumbline_identity` — SELECT-only on `stores`, nothing else. Used for the one legitimate
  cross-tenant lookup (resolving a shop domain to an account before any RLS context exists —
  see `packages/model/src/identity.ts`). Provisioned by
  `tsx scripts/provision-identity-role.ts` (idempotent, safe to rerun). `DATABASE_URL_IDENTITY`.

---

## Roll back

No release/versioning system exists yet (no tags, no deployment history to roll back
*within* — this has only ever run as a single local working tree). If it did:

1. `git log --oneline` to find the last known-good commit.
2. `git checkout <commit>` (or revert forward) in the deploy target.
3. Re-run `pnpm db:migrate` — migrations are additive only (CLAUDE.md convention), so rolling
   back application code while a newer migration has already applied is the dangerous case,
   not the safe default. Check `packages/model/prisma/migrations/` for anything applied after
   the commit being rolled back to; a destructive rollback of the schema itself has never been
   exercised and would need its own down-migration written by hand.
4. Restart `pnpm worker`.

---

## Re-backfill a store

```bash
# Backfill is a library function (packages/sync/src/backfill.ts's runBackfill), not yet
# wired to a CLI entrypoint or triggered automatically on install — see
# docs/GATE-8-HONEST-LIST.md. Until that's built, re-running it means writing a short
# one-off script (see packages/sync/src/__tests__/backfill.test.ts for the exact call
# shape) or extending scripts/worker.ts.
```

Once wired: re-running backfill over the same window is safe — idempotency is proven
(`packages/sync/src/__tests__/backfill.test.ts`'s double-run test: 10,500 orders backfilled
twice, `duplicateCount=0`). A crash mid-backfill resumes from the last persisted watermark,
not from scratch (`sync_state`).

---

## Resolve a recon failure

Per `docs/BUILD-SPEC.md`'s standing rule: **a recon delta is a bug until proven to be a
documented definition difference.** Do not adjust the metric to make the number match.

```bash
pnpm recon
```

1. The report names every failing check, our figure, the reference figure, and the delta —
   it never hides this behind an aggregate pass rate (`scripts/recon.ts`).
2. Find the individual orders contributing to both figures for that check/period. Today
   that means querying `packages/recon/src/fixtures.ts`'s synthetic dataset directly (no
   live store exists) — once real reconciliation against a Shopify store exists, this means
   comparing our synced `orders`/`refunds`/`transactions` rows against the platform's
   equivalent, order by order.
3. Determine whether it's a sync gap, a definition difference, a timezone boundary, or a
   currency conversion issue (per `docs/BUILD-SPEC.md`'s mid-build prompt) — before changing
   anything.
4. Fix one thing, then `pnpm recon` again. One change at a time (standing rule).
5. If the difference is a genuine, defensible definition difference (not a bug), document it
   on the metric's `reconciliationTargetDescription` / definition in
   `packages/metrics/src/index.ts` — visible to the merchant at `/metrics`, never silently
   adjusted.

---

## Rotate keys

- **`TOKEN_ENCRYPTION_KEY`** (encrypts `Store.accessTokenEncrypted`/`refreshTokenEncrypted`,
  `packages/connector/src/token-crypto.ts`, AES-256-GCM): rotating requires decrypting every
  `Store` row's tokens with the old key and re-encrypting with the new one in one pass — no
  rotation script exists yet (real gap, see `docs/GATE-8-HONEST-LIST.md`). A naive key swap
  without this migration step makes every stored token permanently undecryptable.
- **`SHOPIFY_API_SECRET`**: rotating in the Shopify Partner dashboard invalidates webhook HMAC
  verification (`packages/connector/src/hmac.ts`) and OAuth token exchange
  (`packages/connector/src/oauth.ts`) for every store using the old secret simultaneously —
  Shopify has no dual-secret grace period. Never rotated in practice (no live app exists).
- **`DATABASE_URL_MIGRATE` / `DATABASE_URL` / `DATABASE_URL_IDENTITY` passwords**: standard
  Postgres `ALTER ROLE ... PASSWORD ...`, then update the connection strings and restart every
  process. No live traffic exists to worry about connection draining today.

---

## Backup and restore

```bash
tsx scripts/backup-account.ts <accountId> <outFile.json>
tsx scripts/restore-account.ts <backupFile.json>
```

This is a Prisma-level, per-account JSON export/import
(`packages/model/src/backup.ts`) — not `pg_dump`/`pg_restore` (not guaranteed on PATH in
every deploy target; see that file's comment). It captures every tenant-scoped row for one
account. Restore recreates the account into empty space (the account must not already exist
in the target database) with original ids preserved, so foreign keys resolve correctly.

**Verified end-to-end** (`packages/recon/src/__tests__/backup-restore.test.ts`, and manually
via the two CLI scripts above against the real dev database): seed real data, back it up,
**fully delete** the live account (not just mutate it), restore from the backup file alone,
then rerun the same independent-reducer-vs-SQL recon check Phase 4 uses — passes with zero
delta on the restored data. This is the actual verification `docs/BUILD-SPEC.md` Gate 8 asks
for ("a recon run after restore to prove integrity").

**Not covered**: whole-database disaster recovery (a real deploy needs Postgres-native
backups — WAL archiving or scheduled `pg_dump` — underneath this; this tool operates per
account, not per database), and this has never run against anything but the local dev
Postgres instance.
