import { spawnSync } from "node:child_process";

// prisma migrate needs DDL privileges the app's runtime role intentionally
// doesn't have (RLS is bypassed for superusers, so the app must never run as
// one — see packages/model/prisma/migrations/*_add_account_id_and_rls). Use
// the separate migrate-only connection string for this step.
const migrateUrl = process.env.DATABASE_URL_MIGRATE;
if (!migrateUrl) {
  console.error("DATABASE_URL_MIGRATE is not set (see .env.example).");
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["prisma", "migrate", "dev", "--schema", "prisma/schema.prisma"],
  {
    cwd: "packages/model",
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: migrateUrl },
  }
);

process.exit(result.status ?? 1);
