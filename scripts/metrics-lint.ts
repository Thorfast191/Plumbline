import { config } from "dotenv";
import { resolve } from "node:path";
import type { MetricDefinition } from "@plumbline/metrics";

// The registry/recon-coverage check itself needs no database connection,
// but @plumbline/recon transitively imports @plumbline/model, which reads
// DATABASE_URL_MIGRATE at module load time (packages/model/src/identity.ts)
// — so .env must be loaded before the dynamic imports below, same reasoning
// as scripts/worker.ts and scripts/recon.ts.
config({ path: resolve(import.meta.dirname, "../.env") });

// Fails (non-zero exit) if any registered metric is missing a definition
// field, or has no corresponding recon check — per CLAUDE.md: "A metric
// without a definition cannot ship" / "Every metric has a reconciliation
// test."
async function main(): Promise<void> {
  const { registry } = await import("@plumbline/metrics");
  const { RECON_CHECK_METRIC_IDS } = await import("@plumbline/recon");

  const problems: string[] = [];

  for (const def of registry.all()) {
    for (const field of requiredNonEmptyStringFields()) {
      const value = def[field];
      if (typeof value !== "string" || value.trim().length === 0) {
        problems.push(`metric "${def.id}": missing "${field}"`);
      }
    }
    for (const field of requiredNonEmptyArrayFields()) {
      const value = def[field];
      if (!Array.isArray(value) || value.length === 0) {
        problems.push(`metric "${def.id}": "${field}" must be a non-empty array`);
      }
    }
    const hasReconCheck = RECON_CHECK_METRIC_IDS.includes(def.id);
    const hasDocumentedNonReconciliationReason =
      def.reconciliationTargetDescription === null && typeof def.nonReconciliationReason === "string" && def.nonReconciliationReason.trim().length > 0;
    if (!hasReconCheck && !hasDocumentedNonReconciliationReason) {
      problems.push(
        `metric "${def.id}": no recon check covers this metric AND no nonReconciliationReason is documented (see packages/recon RECON_CHECK_METRIC_IDS / CLAUDE.md: "Where it does not [have a comparable figure], the definition must state that explicitly")`
      );
    }
    if (def.reconciliationTargetDescription !== null && def.nonReconciliationReason !== null) {
      problems.push(`metric "${def.id}": has both a reconciliationTargetDescription and a nonReconciliationReason — a metric can't both reconcile and document why it can't`);
    }
  }

  if (problems.length > 0) {
    console.error(`metrics:lint FAILED — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const reconCovered = registry.all().filter((d) => RECON_CHECK_METRIC_IDS.includes(d.id)).length;
  const documentedNonReconciliation = registry.all().length - reconCovered;
  console.log(
    `metrics:lint passed — ${registry.all().length} metric(s), each with a full definition; ${reconCovered} with a recon check, ${documentedNonReconciliation} with a documented reason they can't reconcile.`
  );
}

function requiredNonEmptyStringFields(): Array<keyof MetricDefinition> {
  return ["id", "name", "plainLanguageDefinition", "timestampUsed", "sql", "owner"];
}

function requiredNonEmptyArrayFields(): Array<keyof MetricDefinition> {
  return ["inclusions", "exclusions"];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
