// Phase 3 work. Typed interfaces only — see docs/PLAN.md §10.

export interface BackfillWindow {
  resource: "orders" | "products" | "customers";
  from: Date;
  to: Date;
}

export interface BackfillOrchestrator {
  /** Resumes from sync_state.watermark_at if a prior run was interrupted. */
  runBackfill(storeId: string, resource: BackfillWindow["resource"]): Promise<void>;
}

export interface IncrementalSyncJob {
  runIncrementalSync(storeId: string, resource: string): Promise<void>;
}

export interface WebhookIntake {
  /** Verifies HMAC, dedupes by webhook id, upserts with last-write-wins by resource updated_at. */
  handleWebhook(storeId: string, topic: string, rawBody: Buffer, hmacHeader: string): Promise<void>;
}

export interface RepairLoop {
  /** Re-fetches a trailing window and reconciles against stored data, logging corrections. */
  runRepairPass(storeId: string, trailingWindowHours: number): Promise<{ correctionCount: number }>;
}

export class NotImplementedBackfillOrchestrator implements BackfillOrchestrator {
  async runBackfill(): Promise<void> {
    throw new Error("not implemented — Phase 3");
  }
}

export class NotImplementedIncrementalSyncJob implements IncrementalSyncJob {
  async runIncrementalSync(): Promise<void> {
    throw new Error("not implemented — Phase 3");
  }
}

export class NotImplementedWebhookIntake implements WebhookIntake {
  async handleWebhook(): Promise<void> {
    throw new Error("not implemented — Phase 3");
  }
}

export class NotImplementedRepairLoop implements RepairLoop {
  async runRepairPass(): Promise<{ correctionCount: number }> {
    throw new Error("not implemented — Phase 3");
  }
}
