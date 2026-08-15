// Phase 5 work — CSV intake for COGS + Meta/Google ad spend, per docs/PLAN.md §0/§11c.

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

export interface CsvIntake {
  parseCogsCsv(storeId: string, accountId: string, csv: string): Promise<CogsCsvRow[]>;
  parseAdSpendCsv(storeId: string, accountId: string, csv: string): Promise<AdSpendCsvRow[]>;
}

export class NotImplementedCsvIntake implements CsvIntake {
  async parseCogsCsv(): Promise<CogsCsvRow[]> {
    throw new Error("not implemented — Phase 5");
  }
  async parseAdSpendCsv(): Promise<AdSpendCsvRow[]> {
    throw new Error("not implemented — Phase 5");
  }
}
