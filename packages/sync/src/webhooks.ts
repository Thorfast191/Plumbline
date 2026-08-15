import { createHash } from "node:crypto";
import { resolveStoreByDomain, withAccountContext, type TenantClient } from "@plumbline/model";
import { upsertOrderBundle } from "./upsert.js";
import type { OrderBundle } from "./types.js";

export interface HandleWebhookParams {
  shopDomain: string;
  topic: string;
  webhookId: string; // X-Shopify-Webhook-Id header — the dedup key (docs/PLAN.md §5)
  rawBody: Buffer;
  hmacHeader: string;
  /** Bound to the right per-store secret by the caller (e.g. apps/web's route handler). */
  verifyHmac: (rawBody: Buffer, hmacHeader: string) => boolean;
}

export type HandleWebhookStatus = "processed" | "duplicate" | "invalid_hmac" | "unknown_store";

export interface HandleWebhookResult {
  status: HandleWebhookStatus;
  correctedFields?: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2002";
}

/**
 * Verifies HMAC on the raw body (before any parsing — a re-serialized copy
 * would not reproduce the same signature, per docs/PLAN.md §5), dedupes by
 * `X-Shopify-Webhook-Id`, and applies the last-write-wins merge shared with
 * every other sync path via upsertOrderBundle. Delivery is at-least-once and
 * unordered by Shopify's own design, so both duplicate delivery and
 * out-of-order arrival (an `orders/updated` webhook landing before the
 * corresponding `orders/create`) must be handled here, not assumed away.
 */
export async function handleWebhook(params: HandleWebhookParams): Promise<HandleWebhookResult> {
  if (!params.verifyHmac(params.rawBody, params.hmacHeader)) {
    return { status: "invalid_hmac" };
  }

  const store = await resolveStoreByDomain(params.shopDomain);
  if (!store) {
    return { status: "unknown_store" };
  }

  return withAccountContext(store.accountId, async (tx: TenantClient) => {
    const existing = await tx.webhookEvent.findUnique({
      where: { storeId_shopifyWebhookId: { storeId: store.id, shopifyWebhookId: params.webhookId } },
    });
    if (existing) {
      return { status: "duplicate" as const };
    }

    const payloadHash = createHash("sha256").update(params.rawBody).digest("hex");
    let correctedFields: HandleWebhookResult["correctedFields"] = [];

    if (params.topic.startsWith("orders/")) {
      const bundle = JSON.parse(params.rawBody.toString("utf8")) as OrderBundle;
      const result = await upsertOrderBundle(tx, {
        accountId: store.accountId,
        storeId: store.id,
        source: "webhook",
        bundle,
      });
      correctedFields = result.correctedFields;
    }

    try {
      await tx.webhookEvent.create({
        data: {
          accountId: store.accountId,
          storeId: store.id,
          shopifyWebhookId: params.webhookId,
          topic: params.topic,
          payloadHash,
          status: "processed",
        },
      });
    } catch (err) {
      // A concurrent delivery of the same webhook id can race past the
      // findUnique check above; the unique constraint is the real guarantee.
      if (isUniqueConstraintError(err)) return { status: "duplicate" as const };
      throw err;
    }

    return { status: "processed" as const, correctedFields };
  });
}
