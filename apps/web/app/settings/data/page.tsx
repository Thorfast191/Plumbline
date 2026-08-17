"use client";

import { useState } from "react";

// Minimal, unstyled — Phase 6 builds the real reports/settings interface.
// This exists to satisfy docs/BUILD-SPEC.md Phase 5's "External data intake
// for COGS and ad spend: CSV upload at minimum" with a real, working upload
// path (not a mock), per CLAUDE.md: "Do not build a chart builder or a
// query builder — opinionated reports are the product." No file-picker
// polish, no drag-and-drop — a textarea and a submit button is enough to
// prove the pipeline works end to end.

interface UploadResult {
  upserted?: number;
  errors?: Array<{ line: number; message: string }>;
  error?: string;
}

function UploadPanel({ title, endpoint, expectedHeader, placeholder }: { title: string; endpoint: string; expectedHeader: string; placeholder: string }) {
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch(endpoint, { method: "POST", body: csv, headers: { "Content-Type": "text/csv" } });
      const json = (await res.json()) as UploadResult;
      setResult(json);
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section style={{ marginBottom: "2rem", paddingBottom: "1.5rem", borderBottom: "1px solid #ccc" }}>
      <h2>{title}</h2>
      <p>
        Expected header: <code>{expectedHeader}</code>
      </p>
      <form onSubmit={handleSubmit}>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={placeholder}
          rows={6}
          style={{ width: "100%", fontFamily: "monospace" }}
        />
        <div>
          <button type="submit" disabled={submitting || csv.trim().length === 0}>
            {submitting ? "Uploading…" : "Upload"}
          </button>
        </div>
      </form>
      {result && (
        <div>
          {result.error && <p>Error: {result.error}</p>}
          {result.upserted !== undefined && <p>Upserted {result.upserted} row(s).</p>}
          {result.errors && result.errors.length > 0 && (
            <ul>
              {result.errors.map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default function DataSettingsPage() {
  return (
    <main>
      <h1>External data</h1>
      <p>
        These figures are merchant-supplied estimates, not platform-synced fact — every metric that uses them says so
        explicitly on the <a href="/metrics">metric definitions</a> page. Re-uploading the same row (same SKU/date and
        effective date) updates it in place rather than duplicating it.
      </p>

      <UploadPanel
        title="Cost of goods sold (COGS)"
        endpoint="/api/enrich/cogs"
        expectedHeader="sku,cost_minor,currency_code,effective_from"
        placeholder={"sku,cost_minor,currency_code,effective_from\nSKU-A,40.00,USD,2025-01-01"}
      />

      <UploadPanel
        title="Ad spend (Meta / Google)"
        endpoint="/api/enrich/ad-spend"
        expectedHeader="channel,date,spend_minor,currency_code"
        placeholder={"channel,date,spend_minor,currency_code\nmeta,2025-01-10,200.00,USD"}
      />

      <UploadPanel
        title="Estimated shipping cost"
        endpoint="/api/enrich/shipping-cost"
        expectedHeader="cost_minor,currency_code,effective_from"
        placeholder={"cost_minor,currency_code,effective_from\n5.00,USD,2025-01-01"}
      />
    </main>
  );
}
