// Shapes taken from docs/PLAN.md §2 (extensions.cost.throttleStatus) and §4 (bulk ops).

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphqlCost {
  requestedQueryCost: number;
  actualQueryCost: number;
  throttleStatus: ThrottleStatus;
}

export interface GraphqlResult<T> {
  data: T;
  cost: GraphqlCost;
}

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELED"
  | "FAILED"
  | "EXPIRED";

export interface BulkOperationResult {
  id: string;
  status: BulkOperationStatus;
  objectCount: number;
  url: string | null; // JSONL download URL once COMPLETED
  errorCode: string | null;
}

export interface OAuthTokenResponse {
  accessToken: string;
  scope: string;
  expiresInSeconds: number; // access token lifetime, currently 3600 — see docs/PLAN.md §1
  refreshToken: string;
  refreshTokenExpiresInSeconds: number; // currently 7,776,000 (90 days)
}

export interface ShopifyConnector {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<GraphqlResult<T>>;
  bulkQuery(query: string): Promise<BulkOperationResult>;
  verifyWebhookHmac(rawBody: Buffer | string, hmacHeader: string): boolean;
  buildInstallUrl(shop: string, redirectUri: string, state: string): string;
  exchangeCodeForToken(shop: string, code: string): Promise<OAuthTokenResponse>;
  refreshOfflineToken(shop: string, refreshToken: string): Promise<OAuthTokenResponse>;
}
