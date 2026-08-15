import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyWebhookHmac } from "../hmac.js";

describe("verifyWebhookHmac", () => {
  const secret = "fixture_webhook_secret";
  const rawBody = JSON.stringify({ id: 12345, test: true });

  function sign(body: string, key: string): string {
    return createHmac("sha256", key).update(body).digest("base64");
  }

  it("accepts a correctly signed raw body", () => {
    const validHmac = sign(rawBody, secret);
    expect(verifyWebhookHmac(rawBody, validHmac, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const validHmac = sign(rawBody, secret);
    const tamperedBody = JSON.stringify({ id: 12345, test: false });
    expect(verifyWebhookHmac(tamperedBody, validHmac, secret)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const wrongSecretHmac = sign(rawBody, "wrong_secret");
    expect(verifyWebhookHmac(rawBody, wrongSecretHmac, secret)).toBe(false);
  });

  it("rejects re-serialized JSON that differs byte-for-byte from the signed raw body", () => {
    // Same logical content, different key order -> different bytes -> different HMAC.
    const reserialized = JSON.stringify({ test: true, id: 12345 });
    const validHmac = sign(rawBody, secret);
    expect(verifyWebhookHmac(reserialized, validHmac, secret)).toBe(false);
  });
});
