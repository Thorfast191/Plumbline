import { config } from "dotenv";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

// Phase 8 hardening — closes the gap flagged in packages/model/src/identity.ts
// since Phase 2: store-identity resolution (a legitimate cross-tenant lookup —
// see that file's own comment for why) was reusing DATABASE_URL_MIGRATE, a
// role with unrestricted DDL/DML on every table, purely because no
// narrower-privileged role existed yet. This creates one: SELECT-only on
// `stores`, nothing else. It still needs BYPASSRLS (the lookup is
// cross-tenant by design — see identity.ts), but it can no longer write
// anything, anywhere, unlike the migrate role it replaces.
//
// Idempotent: safe to run against a database that already has the role.
config({ path: resolve(import.meta.dirname, "../.env") });

const ROLE = "plumbline_identity";
const PASSWORD = "plumbline_identity_dev"; // local dev only — see .env.example for the pattern DATABASE_URL_IDENTITY follows

async function provision(migrateUrl: string, label: string): Promise<void> {
  const client = new PrismaClient({ datasourceUrl: migrateUrl });
  try {
    const existing = await client.$queryRawUnsafe<Array<{ rolname: string }>>(
      `SELECT rolname FROM pg_roles WHERE rolname = '${ROLE}'`
    );
    if (existing.length === 0) {
      await client.$executeRawUnsafe(
        `CREATE ROLE ${ROLE} NOSUPERUSER BYPASSRLS LOGIN PASSWORD '${PASSWORD}'`
      );
      console.log(`[provision-identity-role] created role ${ROLE} on ${label}`);
    } else {
      console.log(`[provision-identity-role] role ${ROLE} already exists on ${label}`);
    }

    await client.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${currentDbName(migrateUrl)} TO ${ROLE}`);
    await client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await client.$executeRawUnsafe(
      `GRANT SELECT (id, account_id, shop_domain, shop_currency, shop_timezone, installed_at, uninstalled_at) ON stores TO ${ROLE}`
    );
    console.log(`[provision-identity-role] granted SELECT-only on stores(id, account_id, shop_domain, shop_currency, shop_timezone, installed_at, uninstalled_at) to ${ROLE} on ${label}`);
  } finally {
    await client.$disconnect();
  }
}

function currentDbName(url: string): string {
  const match = /\/([^/?]+)(\?|$)/.exec(url);
  if (!match) throw new Error(`could not parse database name from ${url}`);
  return match[1]!;
}

async function main(): Promise<void> {
  const dev = process.env.DATABASE_URL_MIGRATE;
  const test = process.env.DATABASE_URL_MIGRATE_TEST;
  if (!dev || !test) {
    throw new Error("DATABASE_URL_MIGRATE and DATABASE_URL_MIGRATE_TEST must be set (see .env.example).");
  }
  await provision(dev, "plumbline_dev");
  await provision(test, "plumbline_test");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
