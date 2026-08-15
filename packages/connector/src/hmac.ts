import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Shopify webhook HMAC (docs/PLAN.md §5). Must be computed over
 * the raw request body bytes — never a re-serialized/parsed-then-stringified
 * copy, which will not reproduce the same signature.
 */
export function verifyWebhookHmac(
  rawBody: Buffer | string,
  hmacHeader: string,
  secret: string
): boolean {
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");

  const digestBuf = Buffer.from(digest, "utf8");
  const headerBuf = Buffer.from(hmacHeader, "utf8");
  if (digestBuf.length !== headerBuf.length) return false;

  return timingSafeEqual(digestBuf, headerBuf);
}
