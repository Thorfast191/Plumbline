import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../token-crypto.js";

const SECRET = "test-token-encryption-secret";

describe("token-crypto — AES-256-GCM (docs/BUILD-SPEC.md Phase 8 token handling)", () => {
  it("round-trips a token through encrypt/decrypt", () => {
    const plaintext = "shpat_abcdef0123456789";
    const encrypted = encryptToken(plaintext, SECRET);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptToken(encrypted, SECRET)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV) even for the same input", () => {
    const a = encryptToken("same-token", SECRET);
    const b = encryptToken("same-token", SECRET);
    expect(a).not.toBe(b);
    expect(decryptToken(a, SECRET)).toBe("same-token");
    expect(decryptToken(b, SECRET)).toBe("same-token");
  });

  it("fails to decrypt with the wrong secret rather than returning garbage silently", () => {
    const encrypted = encryptToken("secret-token", SECRET);
    expect(() => decryptToken(encrypted, "wrong-secret")).toThrow();
  });

  it("fails to decrypt tampered ciphertext (authenticated encryption catches modification)", () => {
    const encrypted = encryptToken("secret-token", SECRET);
    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]!.slice(0, -2)}ff`;
    expect(() => decryptToken(tampered, SECRET)).toThrow();
  });
});
