import { encryptToken, decryptToken, type OAuthTokenResponse } from "@plumbline/connector";
import { withAccountContext, resolveStoreByDomain, type TenantClient } from "@plumbline/model";

// Phase 8 — docs/BUILD-SPEC.md: "Token refresh, revocation, and reconnect
// flow when a merchant uninstalls and reinstalls." Store.accessTokenEncrypted
// / refreshTokenEncrypted are AES-256-GCM ciphertext (packages/connector's
// token-crypto.ts), keyed by TOKEN_ENCRYPTION_KEY (see .env.example).

const REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh 10 minutes before expiry, not exactly at it

export function isTokenNearExpiry(tokenExpiresAt: Date | null, now: Date): boolean {
  if (!tokenExpiresAt) return true; // no token on record — treat as expired, forces a refresh/reconnect
  return tokenExpiresAt.getTime() - now.getTime() <= REFRESH_BUFFER_MS;
}

export interface StoreTokenRow {
  id: string;
  accountId: string;
  shopDomain: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: Date | null;
  uninstalledAt: Date | null;
}

export interface RefreshDeps {
  refreshOfflineToken: (shop: string, refreshToken: string) => Promise<OAuthTokenResponse>;
  tokenEncryptionSecret: string;
  now?: Date;
}

export interface EnsureFreshTokenResult {
  accessToken: string;
  refreshed: boolean;
}

/**
 * Returns a decrypted, definitely-not-expired access token for the store,
 * refreshing and persisting a new one first if the current token is within
 * REFRESH_BUFFER_MS of expiry. Shopify refresh tokens are one-time-use
 * (docs/PLAN.md §1) — the new refresh token from the response REPLACES the
 * stored one in the same write, never appended alongside it.
 */
export async function ensureFreshAccessToken(store: StoreTokenRow, deps: RefreshDeps): Promise<EnsureFreshTokenResult> {
  const now = deps.now ?? new Date();

  if (store.uninstalledAt) {
    throw new Error(`store ${store.shopDomain} is uninstalled — cannot refresh a revoked token; reconnect first`);
  }
  if (!store.accessTokenEncrypted) {
    throw new Error(`store ${store.shopDomain} has no access token on record — must complete OAuth install first`);
  }

  if (!isTokenNearExpiry(store.tokenExpiresAt, now)) {
    return { accessToken: decryptToken(store.accessTokenEncrypted, deps.tokenEncryptionSecret), refreshed: false };
  }

  if (!store.refreshTokenEncrypted) {
    throw new Error(`store ${store.shopDomain}'s access token is expiring but no refresh token is on record — reconnect required`);
  }

  const refreshToken = decryptToken(store.refreshTokenEncrypted, deps.tokenEncryptionSecret);
  const response = await deps.refreshOfflineToken(store.shopDomain, refreshToken);

  const newExpiresAt = new Date(now.getTime() + response.expiresInSeconds * 1000);
  await withAccountContext(store.accountId, async (tx: TenantClient) => {
    await tx.store.update({
      where: { id: store.id },
      data: {
        accessTokenEncrypted: encryptToken(response.accessToken, deps.tokenEncryptionSecret),
        refreshTokenEncrypted: encryptToken(response.refreshToken, deps.tokenEncryptionSecret),
        tokenExpiresAt: newExpiresAt,
        scopes: response.scope,
      },
    });
  });

  return { accessToken: response.accessToken, refreshed: true };
}

export interface ReconnectParams {
  accountId: string;
  shopDomain: string;
  shopCurrency: string;
  shopTimezone: string;
  tokenResponse: OAuthTokenResponse;
  tokenEncryptionSecret: string;
  now?: Date;
}

export interface ReconnectResult {
  storeId: string;
  wasReinstall: boolean;
}

/**
 * OAuth install/callback lands here for both a brand-new store and a
 * reconnect after uninstall. Upserts on the unique shopDomain so a
 * reinstall never creates a second Store row for the same shop (which
 * would silently split that merchant's history across two ids) — it
 * clears uninstalledAt and overwrites the token fields with the fresh
 * grant instead.
 *
 * Deliberately resolves the existing store via resolveStoreByDomain (the
 * same pre-account-context, cross-tenant lookup webhooks use — see
 * packages/model/src/identity.ts) rather than trusting `params.accountId`
 * for a reconnect: if a store already exists, ITS accountId is
 * authoritative, not whatever the caller happened to pass in. A caller
 * that guessed wrong could otherwise silently reassign a merchant's whole
 * order history to a different account under RLS. `params.accountId` is
 * only used for a genuinely new install.
 */
export async function installOrReconnectStore(params: ReconnectParams): Promise<ReconnectResult> {
  const now = params.now ?? new Date();
  const existing = await resolveStoreByDomain(params.shopDomain);

  const tokenData = {
    accessTokenEncrypted: encryptToken(params.tokenResponse.accessToken, params.tokenEncryptionSecret),
    refreshTokenEncrypted: encryptToken(params.tokenResponse.refreshToken, params.tokenEncryptionSecret),
    tokenExpiresAt: new Date(now.getTime() + params.tokenResponse.expiresInSeconds * 1000),
    scopes: params.tokenResponse.scope,
    installedAt: now,
    uninstalledAt: null,
  };

  if (existing) {
    const wasReinstall = existing.uninstalledAt !== null;
    return withAccountContext(existing.accountId, async (tx: TenantClient) => {
      await tx.store.update({ where: { id: existing.id }, data: tokenData });
      return { storeId: existing.id, wasReinstall };
    });
  }

  return withAccountContext(params.accountId, async (tx: TenantClient) => {
    const created = await tx.store.create({
      data: {
        accountId: params.accountId,
        shopDomain: params.shopDomain,
        shopCurrency: params.shopCurrency,
        shopTimezone: params.shopTimezone,
        ...tokenData,
      },
    });
    return { storeId: created.id, wasReinstall: false };
  });
}
