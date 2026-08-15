import { CostAwareRateLimiter } from "./rate-limiter.js";
import { verifyWebhookHmac as verifyHmac } from "./hmac.js";
import {
  buildInstallUrl as buildInstallUrlImpl,
  exchangeCodeForToken as exchangeCodeForTokenImpl,
  refreshOfflineToken as refreshOfflineTokenImpl,
  type OAuthConfig,
} from "./oauth.js";
import { ShopifyCredentialsMissingError, ShopifyThrottledError } from "./errors.js";
import type {
  BulkOperationResult,
  GraphqlResult,
  OAuthTokenResponse,
  ShopifyConnector,
  ThrottleStatus,
} from "./types.js";

export interface ShopifyClientConfig {
  shop: string; // e.g. "my-store.myshopify.com"
  apiVersion: string; // e.g. "2026-01" — pin explicitly, never "unstable"/"latest" (docs/PLAN.md §8)
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
  webhookSecret?: string | undefined;
  accessToken?: string | undefined; // offline token for this shop, once OAuth has completed
  /** Test-only: overrides the constructed graphql.json URL (e.g. to point at a local mock server). */
  graphqlEndpointOverride?: string | undefined;
}

interface GraphqlEnvelope<T> {
  data: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: ThrottleStatus;
    };
  };
}

function requireCredentials(config: ShopifyClientConfig): asserts config is ShopifyClientConfig & {
  apiKey: string;
  apiSecret: string;
} {
  const missing: string[] = [];
  if (!config.apiKey) missing.push("SHOPIFY_API_KEY");
  if (!config.apiSecret) missing.push("SHOPIFY_API_SECRET");
  if (missing.length > 0) throw new ShopifyCredentialsMissingError(missing);
}

export class ShopifyClient implements ShopifyConnector {
  private readonly rateLimiter = new CostAwareRateLimiter();

  constructor(private readonly config: ShopifyClientConfig) {}

  private get oauthConfig(): OAuthConfig {
    requireCredentials(this.config);
    return {
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      scopes: "read_orders,read_all_orders,read_products,read_customers,read_discounts",
    };
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    estimatedCost?: number
  ): Promise<GraphqlResult<T>> {
    requireCredentials(this.config);
    if (!this.config.accessToken) {
      throw new ShopifyCredentialsMissingError(["accessToken (complete OAuth install first)"]);
    }

    // Real query cost isn't known until the server responds. Pace against the
    // cost the server most recently reported for a call of this shape (or an
    // explicit override), never a fixed sleep — see docs/PLAN.md §2.
    await this.rateLimiter.waitForBudget(estimatedCost ?? this.rateLimiter.estimateNextCost());

    const endpoint =
      this.config.graphqlEndpointOverride ??
      `https://${this.config.shop}/admin/api/${this.config.apiVersion}/graphql.json`;

    const res = await fetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": this.config.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      }
    );

    const body = (await res.json()) as GraphqlEnvelope<T>;
    const cost = body.extensions?.cost;
    if (cost) this.rateLimiter.update(cost.throttleStatus, cost.actualQueryCost);

    const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled) throw new ShopifyThrottledError(cost?.throttleStatus);
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    if (!cost) {
      throw new Error("Shopify GraphQL response missing extensions.cost — cannot pace safely");
    }

    return { data: body.data, cost: { ...cost } };
  }

  async bulkQuery(query: string): Promise<BulkOperationResult> {
    // Submitting the bulk op costs normal points; the extraction itself does not
    // (docs/PLAN.md §4), so only the submission goes through the rate limiter.
    const submitQuery = `mutation { bulkOperationRunQuery(query: ${JSON.stringify(
      query
    )}) { bulkOperation { id status } userErrors { field message } } }`;
    const result = await this.graphql<{
      bulkOperationRunQuery: {
        bulkOperation: { id: string; status: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(submitQuery);

    const op = result.data.bulkOperationRunQuery.bulkOperation;
    if (!op) {
      const errs = result.data.bulkOperationRunQuery.userErrors.map((e) => e.message).join("; ");
      throw new Error(`bulkOperationRunQuery failed: ${errs}`);
    }

    return { id: op.id, status: op.status as BulkOperationResult["status"], objectCount: 0, url: null, errorCode: null };
  }

  async getBulkOperation(id: string): Promise<BulkOperationResult> {
    const query = `query { node(id: ${JSON.stringify(id)}) { ... on BulkOperation { id status objectCount url errorCode } } }`;
    const result = await this.graphql<{
      node: {
        id: string;
        status: string;
        objectCount: string | number;
        url: string | null;
        errorCode: string | null;
      } | null;
    }>(query);

    const node = result.data.node;
    if (!node) throw new Error(`BulkOperation ${id} not found`);
    return {
      id: node.id,
      status: node.status as BulkOperationResult["status"],
      objectCount: Number(node.objectCount),
      url: node.url,
      errorCode: node.errorCode,
    };
  }

  verifyWebhookHmac(rawBody: Buffer | string, hmacHeader: string): boolean {
    if (!this.config.webhookSecret) {
      throw new ShopifyCredentialsMissingError(["webhookSecret (SHOPIFY_API_SECRET)"]);
    }
    return verifyHmac(rawBody, hmacHeader, this.config.webhookSecret);
  }

  buildInstallUrl(shop: string, redirectUri: string, state: string): string {
    return buildInstallUrlImpl(this.oauthConfig, shop, redirectUri, state);
  }

  async exchangeCodeForToken(shop: string, code: string): Promise<OAuthTokenResponse> {
    return exchangeCodeForTokenImpl(this.oauthConfig, shop, code);
  }

  async refreshOfflineToken(shop: string, refreshToken: string): Promise<OAuthTokenResponse> {
    return refreshOfflineTokenImpl(this.oauthConfig, shop, refreshToken);
  }
}

export function createShopifyClientFromEnv(shop: string, accessToken?: string): ShopifyClient {
  return new ShopifyClient({
    shop,
    apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-01",
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    webhookSecret: process.env.SHOPIFY_API_SECRET,
    accessToken,
  });
}
