import { resolveStoreByDomain } from "@plumbline/model";
import { getSyncStatus } from "@plumbline/sync";

// Minimal, unstyled — Phase 6 builds the real reports interface. This page
// exists to satisfy docs/BUILD-SPEC.md Phase 3's "sync status ... visible in
// the UI" requirement with real data, not a mock.
export const dynamic = "force-dynamic";

const SEED_SHOP_DOMAIN = "seed-store.myshopify.com";

export default async function SyncStatusPage() {
  const store = await resolveStoreByDomain(SEED_SHOP_DOMAIN);

  if (!store) {
    return (
      <main>
        <h1>Sync status</h1>
        <p>No store found for {SEED_SHOP_DOMAIN}. Run the seed script first.</p>
      </main>
    );
  }

  const status = await getSyncStatus(store.accountId, store.id);
  const connected = store.installedAt !== null;

  return (
    <main>
      <h1>Sync status — {store.shopDomain}</h1>
      <p>
        Connected: {connected ? "yes" : "no (pending real Shopify OAuth — see .env.example)"}
      </p>
      <p>Corrections in the last 24h: {status.correctionsLast24h}</p>

      {status.states.length === 0 ? (
        <p>No sync has run for this store yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Resource</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Watermark</th>
              <th>Last updated</th>
            </tr>
          </thead>
          <tbody>
            {status.states.map((s) => (
              <tr key={`${s.resource}-${s.kind}`}>
                <td>{s.resource}</td>
                <td>{s.kind}</td>
                <td>{s.status}</td>
                <td>{s.watermarkAt ? s.watermarkAt.toISOString() : "—"}</td>
                <td>{s.updatedAt.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
