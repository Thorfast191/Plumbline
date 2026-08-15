import type {
  DiscountBundle,
  LineItemBundle,
  OrderBundle,
  RefundBundle,
  RefundLineItemBundle,
  TransactionBundle,
} from "./types.js";

/**
 * Assembles a stream of flat JSONL lines (parent-then-children order, as
 * Shopify's Bulk Operations API emits them — docs/PLAN.md §4) into complete
 * OrderBundle objects, one order at a time, without buffering the whole
 * export in memory. Required for multi-year/10k+-order backfills.
 *
 * NOTE: dispatches on a `__type` tag, which is a Plumbline<->mock-server
 * convention for this phase (see __tests__/fixtures.ts), not a real Shopify
 * wire field. Real Shopify JSONL disambiguates nested objects by which query
 * field/connection they came from, not an explicit type tag — this
 * classifier will need to become query-shape-aware once live bulk query
 * field selection is finalized against a real store (docs/PLAN.md
 * "Unverified items").
 */
export async function* assembleOrderBundles(
  lines: AsyncIterable<Record<string, unknown>>
): AsyncGenerator<OrderBundle> {
  let current: OrderBundle | null = null;
  const refundsById = new Map<string, RefundBundle>();

  for await (const line of lines) {
    const type = line.__type as string | undefined;

    if (type === "Order") {
      if (current) yield current;
      const { __type: _t, ...rest } = line;
      current = { ...rest, lineItems: [], discounts: [], transactions: [], refunds: [] } as unknown as OrderBundle;
      refundsById.clear();
      continue;
    }

    if (!current) {
      throw new Error(`JSONL child line arrived before any Order line: ${JSON.stringify(line)}`);
    }

    if (type === "LineItem") {
      const { __type: _t, __parentId: _p, ...rest } = line;
      current.lineItems.push(rest as unknown as LineItemBundle);
    } else if (type === "Discount") {
      const { __type: _t, __parentId: _p, ...rest } = line;
      current.discounts.push(rest as unknown as DiscountBundle);
    } else if (type === "Transaction") {
      const { __type: _t, __parentId: _p, ...rest } = line;
      current.transactions.push(rest as unknown as TransactionBundle);
    } else if (type === "Refund") {
      const { __type: _t, __parentId: _p, ...rest } = line;
      const refund = { ...rest, lineItems: [] } as unknown as RefundBundle;
      current.refunds.push(refund);
      refundsById.set(refund.id, refund);
    } else if (type === "RefundLineItem") {
      const { __type: _t, __parentId: parentId, ...rest } = line;
      const refund = refundsById.get(parentId as string);
      if (!refund) {
        throw new Error(`RefundLineItem references unknown parent refund ${String(parentId)}`);
      }
      refund.lineItems.push(rest as unknown as RefundLineItemBundle);
    } else {
      throw new Error(`Unrecognized JSONL line type: ${JSON.stringify(line)}`);
    }
  }

  if (current) yield current;
}
