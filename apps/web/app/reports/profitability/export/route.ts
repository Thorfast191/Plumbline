import { NextRequest, NextResponse } from "next/server";
import { resolveReportStore, getProfitabilityScalarRows, getProfitabilityTables } from "../../../../lib/report-query.js";
import { reportRowsToCsv, tableRowsToCsv } from "../../../../lib/report-data.js";
import { resolvePeriodParams } from "../../_shared.js";

export const dynamic = "force-dynamic";

// One CSV per request: scalar metrics first, then one section per
// table-shaped metric, each built with the exact same query + serialization
// functions the page uses (see apps/web/lib/report-data.ts).
export async function GET(request: NextRequest) {
  const store = await resolveReportStore();
  if (!store) {
    return new NextResponse("No store found.", { status: 404 });
  }

  const searchParams = Object.fromEntries(request.nextUrl.searchParams);
  const { year, month, current } = resolvePeriodParams(searchParams, store.shopTimezone);

  const [scalarRows, tables] = await Promise.all([
    getProfitabilityScalarRows(store.id, store.accountId, current, store.shopCurrency),
    getProfitabilityTables(store.id, store.accountId, current),
  ]);

  const sections = [reportRowsToCsv(scalarRows)];
  for (const table of tables) {
    sections.push(`\r\n${table.label}\r\n${tableRowsToCsv(table.columns, table.rows)}`);
  }

  return new NextResponse(sections.join(""), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="profitability-${year}-${String(month).padStart(2, "0")}.csv"`,
    },
  });
}
