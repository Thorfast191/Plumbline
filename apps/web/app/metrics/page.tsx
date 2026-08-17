import { registry } from "@plumbline/metrics";

// Minimal, unstyled — Phase 6 builds the real reports interface. This page
// exists to satisfy docs/BUILD-SPEC.md Phase 4's "Definitions are visible
// to the merchant in the UI, not buried in docs" requirement with the real
// registry, not a stub. No database access: the registry is a static,
// in-memory definition set, so this can render without a connected store.
export const dynamic = "force-static";

export default function MetricsPage() {
  const metrics = registry.all();

  return (
    <main>
      <h1>Metric definitions</h1>
      <p>
        Every metric Plumbline reports has a written definition: what it includes, what it
        excludes, which timestamp it uses, and how it handles refunds and currency. Real
        Shopify-admin reconciliation remains unverified — no live store is connected yet
        (see docs/PLAN.md Risk #1) — figures below are validated against a synthetic fixture,
        not a live merchant's data.
      </p>

      {metrics.map((m) => (
        <section key={m.id} style={{ marginBottom: "2rem", paddingBottom: "1rem", borderBottom: "1px solid #ccc" }}>
          <h2>
            {m.name} <small>({m.id}, v{m.version})</small>
          </h2>
          <p>{m.plainLanguageDefinition}</p>

          <p>
            <strong>Includes:</strong> {m.inclusions.join("; ")}
          </p>
          <p>
            <strong>Excludes:</strong> {m.exclusions.join("; ")}
          </p>
          <p>
            <strong>Timestamp used:</strong> {m.timestampUsed}
          </p>
          <p>
            <strong>Refund handling:</strong> {m.refundHandling}
          </p>
          <p>
            <strong>Currency handling:</strong> {m.currencyHandling}
          </p>
          <p>
            <strong>Reconciliation target:</strong>{" "}
            {m.reconciliationTargetDescription ?? `No comparable platform figure — ${m.nonReconciliationReason}`}
          </p>
          {m.estimatedInputs.length > 0 && (
            <p>
              <strong>⚠ Depends on estimated/uploaded data, not platform-verified fact:</strong> {m.estimatedInputs.join("; ")}
            </p>
          )}
          {m.dependsOn.length > 0 && (
            <p>
              <strong>Depends on:</strong> {m.dependsOn.join(", ")}
            </p>
          )}
          <p>
            <strong>Owner:</strong> {m.owner}
          </p>
        </section>
      ))}
    </main>
  );
}
