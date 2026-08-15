export class ShopifyCredentialsMissingError extends Error {
  constructor(missing: string[]) {
    super(
      `Shopify credentials not configured: ${missing.join(", ")}. ` +
        `Create a Partner app at https://partners.shopify.com and set these in .env ` +
        `(see .env.example) before any live Shopify call can be made.`
    );
    this.name = "ShopifyCredentialsMissingError";
  }
}

export class ShopifyThrottledError extends Error {
  constructor(public readonly throttleStatus: unknown) {
    super("Shopify GraphQL request was throttled (extensions.code THROTTLED)");
    this.name = "ShopifyThrottledError";
  }
}
