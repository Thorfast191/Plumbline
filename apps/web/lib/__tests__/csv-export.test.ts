import { describe, expect, it } from "vitest";
import { formatMoney, formatCount } from "../format.js";
import { toCsv, parseCsvLine } from "../csv.js";
import { reportRowsToCsv, type ReportRow } from "../report-data.js";

// Per docs/BUILD-SPEC.md Phase 6: "Export to CSV matching what is on screen
// exactly." The report page and reportRowsToCsv both call formatMoney /
// formatCount on the same ReportRow objects, so this proves the CSV cell
// values are byte-identical to what the on-screen table renders for the
// same rows — not just "close enough" after independent formatting logic.
describe("CSV export matches on-screen figures exactly", () => {
  const rows: ReportRow[] = [
    { metricId: "gross_sales", label: "Gross sales", kind: "money", minorUnits: 1234567, currency: "USD" },
    { metricId: "discounts", label: "Discounts", kind: "money", minorUnits: -2000, currency: "USD" },
    { metricId: "order_count", label: "Order count", kind: "count", value: 733 },
  ];

  it("every CSV cell equals what the on-screen table would render for that row", () => {
    const csv = reportRowsToCsv(rows);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Metric,Value");

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const onScreen = row.kind === "money" ? formatMoney(row.minorUnits, row.currency) : formatCount(row.value);
      const [csvLabel, csvValue] = parseCsvLine(lines[i + 1]!);
      expect(csvLabel).toBe(row.label);
      expect(csvValue).toBe(onScreen);
    }
  });

  it("quotes a label containing a comma without corrupting the parsed value", () => {
    const csv = toCsv(["Metric", "Value"], [["Sales, net of tax", "100.00 USD"]]);
    const [label, value] = parseCsvLine(csv.trim().split("\r\n")[1]!);
    expect(label).toBe("Sales, net of tax");
    expect(value).toBe("100.00 USD");
  });
});
