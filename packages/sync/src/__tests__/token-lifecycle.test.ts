import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptToken, decryptToken, type OAuthTokenResponse } from "@plumbline/connector";
import { ensureFreshAccessToken, installOrReconnectStore, isTokenNearExpiry, type StoreTokenRow } from "../token-lifecycle.js";
import { adminClient, cleanupTestTenant, createTestTenant, type TestTenant } from "./test-helpers.js";

const SECRET = "test-token-lifecycle-secret";

function tokenResponse(overrides: Partial<OAuthTokenResponse> = {}): OAuthTokenResponse {
  return {
    accessToken: "new-access-token",
    scope: "read_orders,read_all_orders",
    expiresInSeconds: 3600,
    refreshToken: "new-refresh-token",
    refreshTokenExpiresInSeconds: 7_776_000,
    ...overrides,
  };
}

describe("isTokenNearExpiry — refresh-before-expiry boundary (docs/BUILD-SPEC.md Phase 8)", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("is true when there is no token on record", () => {
    expect(isTokenNearExpiry(null, now)).toBe(true);
  });

  it("is true when expiry is exactly at the refresh buffer (10 minutes out)", () => {
    expect(isTokenNearExpiry(new Date(now.getTime() + 10 * 60 * 1000), now)).toBe(true);
  });

  it("is true when already expired", () => {
    expect(isTokenNearExpiry(new Date(now.getTime() - 1000), now)).toBe(true);
  });

  it("is false when comfortably beyond the refresh buffer (1 hour out)", () => {
    expect(isTokenNearExpiry(new Date(now.getTime() + 60 * 60 * 1000), now)).toBe(false);
  });

  it("is false one second before the refresh buffer boundary (10 min + 1s out)", () => {
    expect(isTokenNearExpiry(new Date(now.getTime() + 10 * 60 * 1000 + 1000), now)).toBe(false);
  });
});

describe("ensureFreshAccessToken (docs/BUILD-SPEC.md Phase 8: 'Token refresh, revocation, and reconnect flow')", () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await cleanupTestTenant(tenant);
  });

  it("returns the existing token, unrefreshed, when it is not near expiry", async () => {
    tenant = await createTestTenant("token-lifecycle-fresh");
    const now = new Date("2026-06-01T12:00:00Z");
    const store: StoreTokenRow = {
      id: tenant.storeId,
      accountId: tenant.accountId,
      shopDomain: tenant.shopDomain,
      accessTokenEncrypted: encryptToken("still-good-token", SECRET),
      refreshTokenEncrypted: encryptToken("still-good-refresh", SECRET),
      tokenExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      uninstalledAt: null,
    };
    const refreshOfflineToken = vi.fn();

    const result = await ensureFreshAccessToken(store, { refreshOfflineToken, tokenEncryptionSecret: SECRET, now });

    expect(result).toEqual({ accessToken: "still-good-token", refreshed: false });
    expect(refreshOfflineToken).not.toHaveBeenCalled();
  });

  it("refreshes and persists a new token when the current one is near expiry, replacing the one-time-use refresh token", async () => {
    tenant = await createTestTenant("token-lifecycle-refresh");
    const now = new Date("2026-06-01T12:00:00Z");
    await adminClient.store.update({
      where: { id: tenant.storeId },
      data: {
        accessTokenEncrypted: encryptToken("expiring-token", SECRET),
        refreshTokenEncrypted: encryptToken("one-time-refresh-token", SECRET),
        tokenExpiresAt: new Date(now.getTime() + 60 * 1000), // 1 minute out — inside the buffer
        scopes: "read_orders",
      },
    });

    const store: StoreTokenRow = {
      id: tenant.storeId,
      accountId: tenant.accountId,
      shopDomain: tenant.shopDomain,
      accessTokenEncrypted: encryptToken("expiring-token", SECRET),
      refreshTokenEncrypted: encryptToken("one-time-refresh-token", SECRET),
      tokenExpiresAt: new Date(now.getTime() + 60 * 1000),
      uninstalledAt: null,
    };

    const refreshOfflineToken = vi.fn(async (_shop: string, refreshToken: string) => {
      expect(refreshToken).toBe("one-time-refresh-token"); // proves the right token was decrypted and sent
      return tokenResponse();
    });

    const result = await ensureFreshAccessToken(store, { refreshOfflineToken, tokenEncryptionSecret: SECRET, now });

    expect(result).toEqual({ accessToken: "new-access-token", refreshed: true });
    expect(refreshOfflineToken).toHaveBeenCalledTimes(1);

    const reloaded = await adminClient.store.findUniqueOrThrow({ where: { id: tenant.storeId } });
    expect(decryptToken(reloaded.accessTokenEncrypted!, SECRET)).toBe("new-access-token");
    expect(decryptToken(reloaded.refreshTokenEncrypted!, SECRET)).toBe("new-refresh-token"); // old one-time token is gone
    expect(reloaded.tokenExpiresAt!.getTime()).toBe(now.getTime() + 3600 * 1000);
  });

  it("throws rather than silently proceeding when the store is uninstalled", async () => {
    tenant = await createTestTenant("token-lifecycle-uninstalled");
    const store: StoreTokenRow = {
      id: tenant.storeId,
      accountId: tenant.accountId,
      shopDomain: tenant.shopDomain,
      accessTokenEncrypted: encryptToken("token", SECRET),
      refreshTokenEncrypted: encryptToken("refresh", SECRET),
      tokenExpiresAt: new Date("2026-06-01T13:00:00Z"),
      uninstalledAt: new Date("2026-05-01T00:00:00Z"),
    };
    await expect(
      ensureFreshAccessToken(store, { refreshOfflineToken: vi.fn(), tokenEncryptionSecret: SECRET, now: new Date("2026-06-01T12:00:00Z") })
    ).rejects.toThrow(/uninstalled/);
  });
});

describe("installOrReconnectStore (docs/BUILD-SPEC.md Phase 8: reconnect after uninstall must not duplicate)", () => {
  let tenant: TestTenant;

  afterEach(async () => {
    if (tenant) await cleanupTestTenant(tenant);
  });

  it("creates a new store on first install", async () => {
    tenant = await createTestTenant("reconnect-new");
    const domain = `reconnect-fresh-${Date.now()}.myshopify.com`;

    const result = await installOrReconnectStore({
      accountId: tenant.accountId,
      shopDomain: domain,
      shopCurrency: "USD",
      shopTimezone: "UTC",
      tokenResponse: tokenResponse(),
      tokenEncryptionSecret: SECRET,
    });

    expect(result.wasReinstall).toBe(false);
    const store = await adminClient.store.findUniqueOrThrow({ where: { id: result.storeId } });
    expect(store.shopDomain).toBe(domain);
    expect(decryptToken(store.accessTokenEncrypted!, SECRET)).toBe("new-access-token");

    await adminClient.store.delete({ where: { id: result.storeId } });
  });

  it("reconnecting an uninstalled store updates the SAME row, clears uninstalledAt, and does not create a duplicate", async () => {
    tenant = await createTestTenant("reconnect-existing");
    await adminClient.store.update({
      where: { id: tenant.storeId },
      data: { uninstalledAt: new Date("2026-05-01T00:00:00Z"), accessTokenEncrypted: null, refreshTokenEncrypted: null },
    });

    const beforeCount = await adminClient.store.count({ where: { shopDomain: tenant.shopDomain } });
    expect(beforeCount).toBe(1);

    const result = await installOrReconnectStore({
      accountId: tenant.accountId, // caller's guess is deliberately ignored in favor of the resolved existing store's real accountId
      shopDomain: tenant.shopDomain,
      shopCurrency: "USD",
      shopTimezone: "UTC",
      tokenResponse: tokenResponse({ accessToken: "reconnected-access-token" }),
      tokenEncryptionSecret: SECRET,
    });

    expect(result.wasReinstall).toBe(true);
    expect(result.storeId).toBe(tenant.storeId); // same row, not a new one

    const afterCount = await adminClient.store.count({ where: { shopDomain: tenant.shopDomain } });
    expect(afterCount).toBe(1); // still exactly one row for this domain

    const store = await adminClient.store.findUniqueOrThrow({ where: { id: tenant.storeId } });
    expect(store.uninstalledAt).toBeNull();
    expect(decryptToken(store.accessTokenEncrypted!, SECRET)).toBe("reconnected-access-token");
  });
});
