import { resolveStoreByDomain } from "@plumbline/model";
import { prisma } from "@plumbline/model";
import { parseShippingCostCsv, upsertShippingCostRows } from "@plumbline/enrich";

const SEED_SHOP_DOMAIN = "seed-store.myshopify.com";

export async function POST(request: Request): Promise<Response> {
  const store = await resolveStoreByDomain(SEED_SHOP_DOMAIN);
  if (!store) {
    return Response.json({ error: `No store found for ${SEED_SHOP_DOMAIN}. Run the seed script first.` }, { status: 404 });
  }

  const csv = await request.text();
  if (!csv.trim()) {
    return Response.json({ error: "Request body is empty — expected CSV text (header: cost_minor,currency_code,effective_from)." }, { status: 400 });
  }

  let parsed: ReturnType<typeof parseShippingCostCsv>;
  try {
    parsed = parseShippingCostCsv(csv);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const { count } = await upsertShippingCostRows(prisma, store.accountId, store.id, parsed.rows);

  return Response.json({ upserted: count, errors: parsed.errors });
}
