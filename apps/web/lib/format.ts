// Single formatter used by both the on-screen report table and the CSV
// export (report-data.ts / report pages / export routes all import this) —
// there is one place that turns minor units into a display string, so the
// two surfaces cannot drift apart. Per BUILD-SPEC.md Phase 6: "Export to
// CSV matching what is on screen exactly."
export function formatMoney(minorUnits: number, currency: string): string {
  return (minorUnits / 100).toFixed(2) + " " + currency;
}

export function formatCount(value: number): string {
  return String(Math.round(value));
}
