import { config } from "dotenv";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

config({ path: resolve(import.meta.dirname, "../.env") });

// docs/RUNBOOK.md: `tsx scripts/restore-account.ts <backupFile.json>`
// Restores into empty space — the account in the file must not already
// exist in the target database (see packages/model/src/backup.ts).
async function main(): Promise<void> {
  const [inFile] = process.argv.slice(2);
  if (!inFile) {
    console.error("usage: tsx scripts/restore-account.ts <backupFile.json>");
    process.exit(1);
  }

  const { PrismaClient, restoreAccountData } = await import("@plumbline/model");
  const migrateUrl = process.env.DATABASE_URL_MIGRATE;
  if (!migrateUrl) throw new Error("DATABASE_URL_MIGRATE must be set (see .env.example).");
  const client = new PrismaClient({ datasourceUrl: migrateUrl });

  try {
    const raw = await readFile(inFile, "utf8");
    const snapshot = JSON.parse(raw, (key, value) => (isIsoDateKey(key) && typeof value === "string" ? new Date(value) : value));
    await restoreAccountData(client, snapshot);
    console.log(`[restore-account] restored account ${snapshot.account.id} from ${inFile} (captured ${snapshot.capturedAt})`);
    console.log(`[restore-account] run \`pnpm recon\` (or a targeted recon check for this account) to confirm integrity, per docs/BUILD-SPEC.md Phase 8.`);
  } finally {
    await client.$disconnect();
  }
}

// JSON.parse's reviver has no schema, so this is a heuristic, not a real
// type-safe deserializer — good enough for this per-account recovery tool,
// not something to reuse for a general-purpose JSON<->Prisma layer.
const DATE_KEY_SUFFIXES = ["At", "capturedAt"];
function isIsoDateKey(key: string): boolean {
  return DATE_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
