import { createHmac, timingSafeEqual } from "node:crypto";
import type { OAuthTokenResponse } from "./types.js";

export interface OAuthConfig {
  apiKey: string;
  apiSecret: string;
  scopes: string; // comma-separated, e.g. "read_orders,read_all_orders"
}

export function buildInstallUrl(
  config: OAuthConfig,
  shop: string,
  redirectUri: string,
  state: string
): string {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.apiKey);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Verifies the HMAC Shopify appends to install/callback query strings (distinct from webhook HMAC). */
export function verifyOAuthQueryHmac(
  query: Record<string, string>,
  apiSecret: string
): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");
  const digestBuf = Buffer.from(digest, "utf8");
  const hmacBuf = Buffer.from(hmac, "utf8");
  if (digestBuf.length !== hmacBuf.length) return false;
  return timingSafeEqual(digestBuf, hmacBuf);
}

interface RawTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}

function toTokenResponse(raw: RawTokenResponse): OAuthTokenResponse {
  return {
    accessToken: raw.access_token,
    scope: raw.scope,
    expiresInSeconds: raw.expires_in,
    refreshToken: raw.refresh_token,
    refreshTokenExpiresInSeconds: raw.refresh_token_expires_in,
  };
}

/** Authorization-code grant — offline, expiring token (docs/PLAN.md §1). Requires live network + real app credentials. */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  shop: string,
  code: string
): Promise<OAuthTokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.apiKey,
      client_secret: config.apiSecret,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status} ${await res.text()}`);
  }
  return toTokenResponse((await res.json()) as RawTokenResponse);
}

/** Refresh-token grant. Shopify refresh tokens are one-time-use — the response's new refreshToken must replace the stored one. */
export async function refreshOfflineToken(
  config: OAuthConfig,
  shop: string,
  refreshToken: string
): Promise<OAuthTokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.apiKey,
      client_secret: config.apiSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token refresh failed: ${res.status} ${await res.text()}`);
  }
  return toTokenResponse((await res.json()) as RawTokenResponse);
}
