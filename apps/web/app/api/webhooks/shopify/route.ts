import { verifyWebhookHmac } from "@plumbline/connector";
import { handleWebhook } from "@plumbline/sync";

// See docs/PLAN.md §5: HMAC must be verified over the RAW body bytes, before
// any JSON parsing — Next.js's request.text()/arrayBuffer() give us that
// raw form; req.json() would not (re-serialization changes the bytes).
export async function POST(request: Request): Promise<Response> {
  const rawBodyText = await request.text();
  const rawBody = Buffer.from(rawBodyText, "utf8");

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic");
  const webhookId = request.headers.get("x-shopify-webhook-id");
  const shopDomain = request.headers.get("x-shopify-shop-domain");

  if (!hmacHeader || !topic || !webhookId || !shopDomain) {
    return new Response("Missing required Shopify webhook headers", { status: 400 });
  }

  const webhookSecret = process.env.SHOPIFY_API_SECRET;
  if (!webhookSecret) {
    // Credentials not configured yet (see .env.example) — fail loudly rather
    // than silently accepting unverifiable webhooks.
    return new Response("Webhook verification not configured", { status: 503 });
  }

  const result = await handleWebhook({
    shopDomain,
    topic,
    webhookId,
    rawBody,
    hmacHeader,
    verifyHmac: (body, header) => verifyWebhookHmac(body, header, webhookSecret),
  });

  switch (result.status) {
    case "processed":
    case "duplicate":
      return new Response(null, { status: 200 });
    case "invalid_hmac":
      return new Response("Invalid HMAC signature", { status: 401 });
    case "unknown_store":
      return new Response("Unknown shop domain", { status: 404 });
  }
}
