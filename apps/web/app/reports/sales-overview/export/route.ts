import { NextRequest, NextResponse } from "next/server";
import { resolveReportStore, getSalesOverviewRows } from "../../../../lib/report-query.js";
import { reportRowsToCsv } from "../../../../lib/report-data.js";
import { resolvePeriodParams } from "../../_shared.js";

export const dynamic = "force-dynamic";

// Calls the exact same getSalesOverviewRows + reportRowsToCsv the page uses
// to render its table — see apps/web/lib/report-data.ts's comment. Proven
// byte-identical against the shared formatter in
// apps/web/lib/__tests__/csv-export.test.ts.
export async function GET(request: NextRequest) {
  const store = await resolveReportStore();
  if (!store) {
    return new NextResponse("No store found.", { status: 404 });
  }

  const searchParams = Object.fromEntries(request.nextUrl.searchParams);
  const { year, month, current } = resolvePeriodParams(searchParams, store.shopTimezone);
  const rows = await getSalesOverviewRows(store.id, store.accountId, current, store.shopCurrency);
  const csv = reportRowsToCsv(rows);

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sales-overview-${year}-${String(month).padStart(2, "0")}.csv"`,
    },
  });
}
