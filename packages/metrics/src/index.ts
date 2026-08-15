// Phase 4 work. Registry shape only — see docs/PLAN.md §11, CLAUDE.md "Non-negotiable rules".

export type RefundHandling = "on-refund-processed-date" | "excluded" | "not-applicable";
export type CurrencyHandling = "shop-currency-only" | "converted-at-read-time" | "not-applicable";

export interface MetricDefinition {
  id: string;
  name: string;
  plainLanguageDefinition: string;
  inclusions: string[];
  exclusions: string[];
  timestampUsed: string; // must state which field/timezone basis, per CLAUDE.md
  refundHandling: RefundHandling;
  currencyHandling: CurrencyHandling;
  sql: string;
  dependsOn: string[];
  version: number;
  owner: string;
  /** null only when the platform has no comparable figure — must be documented, per CLAUDE.md. */
  reconciliationTargetDescription: string | null;
}

export interface MetricRegistry {
  register(def: MetricDefinition): void;
  get(id: string): MetricDefinition | undefined;
  all(): MetricDefinition[];
}

export class NotImplementedMetricRegistry implements MetricRegistry {
  register(): void {
    throw new Error("not implemented — Phase 4");
  }
  get(): MetricDefinition | undefined {
    throw new Error("not implemented — Phase 4");
  }
  all(): MetricDefinition[] {
    throw new Error("not implemented — Phase 4");
  }
}
