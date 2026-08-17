import { resolveStoreByDomain } from "@plumbline/model";
import { prisma } from "@plumbline/model";
import { parseCogsCsv, upsertCogsRows } from "@plumbline/enrich";

// Bare-minimum CSV upload path — BUILD-SPEC.md Phase 5: "External data
// intake for COGS and ad spend: CSV upload at minimum." No auth/session
// system exists yet (Shopify OAuth isn't live — see docs/PLAN.md Risk #1),
// so this resolves the one seed store by domain, same pattern as
// apps/web/app/sync-status/page.tsx. Real multi-store account routing is a
// Phase 6+/OAuth concern, not a Phase 5 one.
const SEED_SHOP_DOMAIN = "seed-store.myshopify.com";

export async function POST(request: Request): Promise<Response> {
  const store = await resolveStoreByDomain(SEED_SHOP_DOMAIN);
  if (!store) {
    return Response.json({ error: `No store found for ${SEED_SHOP_DOMAIN}. Run the seed script first.` }, { status: 404 });
  }

  const csv = await request.text();
  if (!csv.trim()) {
    return Response.json({ error: "Request body is empty — expected CSV text (header: sku,cost_minor,currency_code,effective_from)." }, { status: 400 });
  }

  let parsed: ReturnType<typeof parseCogsCsv>;
  try {
    parsed = parseCogsCsv(csv);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const { count } = await upsertCogsRows(prisma, store.accountId, store.id, parsed.rows);

  return Response.json({ upserted: count, errors: parsed.errors });
}
