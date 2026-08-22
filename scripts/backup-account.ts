import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

config({ path: resolve(import.meta.dirname, "../.env") });

// docs/RUNBOOK.md: `tsx scripts/backup-account.ts <accountId> <outFile.json>`
// See packages/model/src/backup.ts for why this is a per-account JSON
// export rather than pg_dump.
async function main(): Promise<void> {
  const [accountId, outFile] = process.argv.slice(2);
  if (!accountId || !outFile) {
    console.error("usage: tsx scripts/backup-account.ts <accountId> <outFile.json>");
    process.exit(1);
  }

  const { PrismaClient, exportAccountData } = await import("@plumbline/model");
  const migrateUrl = process.env.DATABASE_URL_MIGRATE;
  if (!migrateUrl) throw new Error("DATABASE_URL_MIGRATE must be set (see .env.example).");
  const client = new PrismaClient({ datasourceUrl: migrateUrl });

  try {
    const snapshot = await exportAccountData(client, accountId);
    await writeFile(outFile, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(
      `[backup-account] wrote ${outFile}: ${snapshot.orders.length} orders, ${snapshot.stores.length} store(s), captured ${snapshot.capturedAt}`
    );
  } finally {
    await client.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
