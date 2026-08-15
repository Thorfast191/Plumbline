// Phase 4 work — see docs/PLAN.md §11, CLAUDE.md reconciliation-pass-rate north star.

export interface ReconCheckResult {
  checkName: string;
  storeId: string;
  period: { from: Date; to: Date };
  ourFigureMinor: number;
  theirFigureMinor: number | null; // null when platform has no comparable figure (Phase-4b metrics)
  deltaMinor: number | null;
  passed: boolean;
}

export interface ReconRunner {
  /** Any nonzero delta is a failure, never a warning — CLAUDE.md. */
  runAll(storeId: string, period: { from: Date; to: Date }): Promise<ReconCheckResult[]>;
}

export class NotImplementedReconRunner implements ReconRunner {
  async runAll(): Promise<ReconCheckResult[]> {
    throw new Error("not implemented — Phase 4");
  }
}
