// Phase 7 work — scheduled report delivery + threshold alerts, see docs/BUILD-SPEC.md Phase 7.

export interface ScheduledReport {
  id: string;
  accountId: string;
  storeId: string;
  metricIds: string[];
  cadence: "daily" | "weekly" | "monthly";
  recipientEmails: string[];
}

export interface ThresholdAlert {
  id: string;
  metricId: string;
  comparator: "below" | "above";
  thresholdValue: number;
}

export interface ReportScheduler {
  scheduleReport(report: ScheduledReport): Promise<void>;
  deliverDue(): Promise<{ delivered: number; failed: number }>;
}

export interface AlertEvaluator {
  evaluate(alert: ThresholdAlert, storeId: string): Promise<{ triggered: boolean; figure: number }>;
}

export class NotImplementedReportScheduler implements ReportScheduler {
  async scheduleReport(): Promise<void> {
    throw new Error("not implemented — Phase 7");
  }
  async deliverDue(): Promise<{ delivered: number; failed: number }> {
    throw new Error("not implemented — Phase 7");
  }
}

export class NotImplementedAlertEvaluator implements AlertEvaluator {
  async evaluate(): Promise<{ triggered: boolean; figure: number }> {
    throw new Error("not implemented — Phase 7");
  }
}
