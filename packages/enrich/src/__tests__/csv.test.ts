import { describe, it, expect } from "vitest";
import { parseCogsCsv, parseAdSpendCsv, parseShippingCostCsv } from "../index.js";

describe("parseCogsCsv", () => {
  it("parses integer minor-unit costs", () => {
    const { rows, errors } = parseCogsCsv("sku,cost_minor,currency_code,effective_from\nSKU-A,4000,USD,2025-01-01");
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([{ sku: "SKU-A", costMinor: 4000, currencyCode: "USD", effectiveFrom: new Date("2025-01-01") }]);
  });

  it("converts decimal major-unit costs to minor units", () => {
    const { rows, errors } = parseCogsCsv("sku,cost_minor,currency_code,effective_from\nSKU-B,40.00,USD,2025-01-01");
    expect(errors).toHaveLength(0);
    expect(rows[0]?.costMinor).toBe(4000);
  });

  it("handles quoted fields with embedded commas", () => {
    const { rows, errors } = parseCogsCsv('sku,cost_minor,currency_code,effective_from\n"SKU, A",4000,USD,2025-01-01');
    expect(errors).toHaveLength(0);
    expect(rows[0]?.sku).toBe("SKU, A");
  });

  it("reports a per-line error for an unparseable cost, without dropping other valid rows", () => {
    const { rows, errors } = parseCogsCsv("sku,cost_minor,currency_code,effective_from\nSKU-A,not-a-number,USD,2025-01-01\nSKU-B,3000,USD,2025-01-01");
    expect(rows).toEqual([{ sku: "SKU-B", costMinor: 3000, currencyCode: "USD", effectiveFrom: new Date("2025-01-01") }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(2);
  });

  it("throws if a required column is missing", () => {
    expect(() => parseCogsCsv("sku,currency_code,effective_from\nSKU-A,USD,2025-01-01")).toThrow(/missing required column/);
  });
});

describe("parseAdSpendCsv", () => {
  it("parses meta/google rows", () => {
    const { rows, errors } = parseAdSpendCsv("channel,date,spend_minor,currency_code\nmeta,2025-01-10,20000,USD\ngoogle,2025-01-20,150.00,USD");
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([
      { channel: "meta", date: new Date("2025-01-10"), spendMinor: 20000, currencyCode: "USD" },
      { channel: "google", date: new Date("2025-01-20"), spendMinor: 15000, currencyCode: "USD" },
    ]);
  });

  it("rejects an unknown channel", () => {
    const { rows, errors } = parseAdSpendCsv("channel,date,spend_minor,currency_code\ntiktok,2025-01-10,20000,USD");
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/channel must be/);
  });
});

describe("parseShippingCostCsv", () => {
  it("parses a flat estimated cost row", () => {
    const { rows, errors } = parseShippingCostCsv("cost_minor,currency_code,effective_from\n500,USD,2025-01-01");
    expect(errors).toHaveLength(0);
    expect(rows).toEqual([{ costMinor: 500, currencyCode: "USD", effectiveFrom: new Date("2025-01-01") }]);
  });
});
