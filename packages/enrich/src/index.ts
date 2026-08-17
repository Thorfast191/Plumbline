import type { PrismaClient } from "@plumbline/model";
import { withAccountContextOn } from "@plumbline/model";

// Phase 5 — CSV intake for COGS + Meta/Google ad spend + estimated shipping
// cost, per docs/PLAN.md §0/§11c and CLAUDE.md's architecture table
// ("packages/enrich  external inputs: COGS, ad spend, shipping cost").
// Hand-rolled CSV parsing rather than a dependency — BUILD-SPEC's own
// minimalism rule ("do not scaffold unrequested features") and the format
// is genuinely simple (no embedded newlines expected in these columns);
// quoted fields with escaped commas ARE supported since CSV exports from
// spreadsheet tools routinely quote fields.

export interface CogsCsvRow {
  sku: string;
  costMinor: number;
  currencyCode: string;
  effectiveFrom: Date;
}

export interface AdSpendCsvRow {
  channel: "meta" | "google";
  date: Date;
  spendMinor: number;
  currencyCode: string;
}

export interface ShippingCostCsvRow {
  costMinor: number;
  currencyCode: string;
  effectiveFrom: Date;
}

export interface CsvParseError {
  line: number;
  message: string;
}

export interface CsvParseResult<T> {
  rows: T[];
  errors: CsvParseError[];
}

/** Splits one CSV line into fields, honoring double-quoted fields with "" as an escaped quote. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

function parseCsvRows(csv: string): { header: string[]; rows: string[][] } {
  const lines = csv.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { header: [], rows: [] };
  }
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map(splitCsvLine);
  return { header, rows };
}

function requireColumns(header: string[], required: string[]): void {
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missing.join(", ")}. Expected header: ${required.join(",")}`);
  }
}

function parseMinorUnits(raw: string, lineNumber: number, errors: CsvParseError[]): number | null {
  // Accepts a plain integer ("4000") or a decimal major-unit string
  // ("40.00") and converts the latter to minor units — spreadsheets
  // typically export dollars-and-cents, not raw integer minor units.
  if (/^-?\d+$/.test(raw)) {
    return Number(raw);
  }
  if (/^-?\d+\.\d{1,2}$/.test(raw)) {
    return Math.round(Number(raw) * 100);
  }
  errors.push({ line: lineNumber, message: `could not parse "${raw}" as a money value (expected an integer minor-units value or a decimal like "40.00")` });
  return null;
}

function parseDate(raw: string, lineNumber: number, errors: CsvParseError[]): Date | null {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    errors.push({ line: lineNumber, message: `could not parse "${raw}" as a date (expected an ISO 8601 date, e.g. "2025-01-01")` });
    return null;
  }
  return d;
}

/** Expected header: sku,cost_minor,currency_code,effective_from */
export function parseCogsCsv(csv: string): CsvParseResult<CogsCsvRow> {
  const { header, rows } = parseCsvRows(csv);
  requireColumns(header, ["sku", "cost_minor", "currency_code", "effective_from"]);
  const skuIdx = header.indexOf("sku");
  const costIdx = header.indexOf("cost_minor");
  const currencyIdx = header.indexOf("currency_code");
  const effIdx = header.indexOf("effective_from");

  const parsed: CogsCsvRow[] = [];
  const errors: CsvParseError[] = [];
  rows.forEach((fields, i) => {
    const lineNumber = i + 2; // +1 for header, +1 for 1-indexing
    const sku = fields[skuIdx]?.trim();
    const currencyCode = fields[currencyIdx]?.trim();
    const costMinor = parseMinorUnits(fields[costIdx] ?? "", lineNumber, errors);
    const effectiveFrom = parseDate(fields[effIdx] ?? "", lineNumber, errors);
    if (!sku) {
      errors.push({ line: lineNumber, message: "sku is required" });
    }
    if (!currencyCode) {
      errors.push({ line: lineNumber, message: "currency_code is required" });
    }
    if (sku && currencyCode && costMinor !== null && effectiveFrom !== null) {
      parsed.push({ sku, costMinor, currencyCode, effectiveFrom });
    }
  });
  return { rows: parsed, errors };
}

/** Expected header: channel,date,spend_minor,currency_code */
export function parseAdSpendCsv(csv: string): CsvParseResult<AdSpendCsvRow> {
  const { header, rows } = parseCsvRows(csv);
  requireColumns(header, ["channel", "date", "spend_minor", "currency_code"]);
  const channelIdx = header.indexOf("channel");
  const dateIdx = header.indexOf("date");
  const spendIdx = header.indexOf("spend_minor");
  const currencyIdx = header.indexOf("currency_code");

  const parsed: AdSpendCsvRow[] = [];
  const errors: CsvParseError[] = [];
  rows.forEach((fields, i) => {
    const lineNumber = i + 2;
    const channelRaw = fields[channelIdx]?.trim().toLowerCase();
    const currencyCode = fields[currencyIdx]?.trim();
    const spendMinor = parseMinorUnits(fields[spendIdx] ?? "", lineNumber, errors);
    const date = parseDate(fields[dateIdx] ?? "", lineNumber, errors);
    if (channelRaw !== "meta" && channelRaw !== "google") {
      errors.push({ line: lineNumber, message: `channel must be "meta" or "google", got "${channelRaw}"` });
    }
    if (!currencyCode) {
      errors.push({ line: lineNumber, message: "currency_code is required" });
    }
    if ((channelRaw === "meta" || channelRaw === "google") && currencyCode && spendMinor !== null && date !== null) {
      parsed.push({ channel: channelRaw, date, spendMinor, currencyCode });
    }
  });
  return { rows: parsed, errors };
}

/** Expected header: cost_minor,currency_code,effective_from — one estimated flat cost-per-shipment, versioned like COGS. */
export function parseShippingCostCsv(csv: string): CsvParseResult<ShippingCostCsvRow> {
  const { header, rows } = parseCsvRows(csv);
  requireColumns(header, ["cost_minor", "currency_code", "effective_from"]);
  const costIdx = header.indexOf("cost_minor");
  const currencyIdx = header.indexOf("currency_code");
  const effIdx = header.indexOf("effective_from");

  const parsed: ShippingCostCsvRow[] = [];
  const errors: CsvParseError[] = [];
  rows.forEach((fields, i) => {
    const lineNumber = i + 2;
    const currencyCode = fields[currencyIdx]?.trim();
    const costMinor = parseMinorUnits(fields[costIdx] ?? "", lineNumber, errors);
    const effectiveFrom = parseDate(fields[effIdx] ?? "", lineNumber, errors);
    if (!currencyCode) {
      errors.push({ line: lineNumber, message: "currency_code is required" });
    }
    if (currencyCode && costMinor !== null && effectiveFrom !== null) {
      parsed.push({ costMinor, currencyCode, effectiveFrom });
    }
  });
  return { rows: parsed, errors };
}

/**
 * Upserts parsed rows into the real enrich_* tables (packages/model/prisma/schema.prisma),
 * RLS-scoped via withAccountContextOn so a merchant can only ever write into
 * their own account's rows. Keyed by (storeId, sku, effectiveFrom) /
 * (storeId, channel, date) / (storeId, effectiveFrom) so re-uploading the
 * same CSV twice doesn't duplicate rows — same idempotency expectation
 * CLAUDE.md sets for sync.
 */
export async function upsertCogsRows(client: PrismaClient, accountId: string, storeId: string, rows: CogsCsvRow[]): Promise<{ count: number }> {
  return withAccountContextOn(client, accountId, async (tx) => {
    for (const row of rows) {
      const existing = await tx.enrichCogs.findFirst({
        where: { storeId, sku: row.sku, effectiveFrom: row.effectiveFrom },
      });
      if (existing) {
        await tx.enrichCogs.update({
          where: { id: existing.id },
          data: { costMinor: row.costMinor, currencyCode: row.currencyCode },
        });
      } else {
        await tx.enrichCogs.create({
          data: { accountId, storeId, sku: row.sku, costMinor: row.costMinor, currencyCode: row.currencyCode, effectiveFrom: row.effectiveFrom, source: "csv_upload" },
        });
      }
    }
    return { count: rows.length };
  });
}

export async function upsertAdSpendRows(client: PrismaClient, accountId: string, storeId: string, rows: AdSpendCsvRow[]): Promise<{ count: number }> {
  return withAccountContextOn(client, accountId, async (tx) => {
    for (const row of rows) {
      const existing = await tx.enrichAdSpend.findFirst({
        where: { storeId, channel: row.channel, date: row.date },
      });
      if (existing) {
        await tx.enrichAdSpend.update({
          where: { id: existing.id },
          data: { spendMinor: row.spendMinor, currencyCode: row.currencyCode },
        });
      } else {
        await tx.enrichAdSpend.create({
          data: { accountId, storeId, channel: row.channel, date: row.date, spendMinor: row.spendMinor, currencyCode: row.currencyCode, source: "csv_upload" },
        });
      }
    }
    return { count: rows.length };
  });
}

export async function upsertShippingCostRows(client: PrismaClient, accountId: string, storeId: string, rows: ShippingCostCsvRow[]): Promise<{ count: number }> {
  return withAccountContextOn(client, accountId, async (tx) => {
    for (const row of rows) {
      const existing = await tx.enrichShippingCost.findFirst({
        where: { storeId, effectiveFrom: row.effectiveFrom },
      });
      if (existing) {
        await tx.enrichShippingCost.update({
          where: { id: existing.id },
          data: { costMinor: row.costMinor, currencyCode: row.currencyCode },
        });
      } else {
        await tx.enrichShippingCost.create({
          data: { accountId, storeId, costMinor: row.costMinor, currencyCode: row.currencyCode, effectiveFrom: row.effectiveFrom, source: "csv_upload" },
        });
      }
    }
    return { count: rows.length };
  });
}
