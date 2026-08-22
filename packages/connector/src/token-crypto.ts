import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Store.accessTokenEncrypted / refreshTokenEncrypted (packages/model/prisma/
// schema.prisma) have been named "encrypted" since Phase 2 but nothing ever
// encrypted anything before Phase 8 — flagged on docs/GATE-8-HONEST-LIST.md.
// AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to
// decrypt rather than silently returning garbage. Output format is
// `${ivHex}:${authTagHex}:${ciphertextHex}` — self-contained, no separate
// IV/tag storage needed.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size

function deriveKey(secret: string): Buffer {
  // scryptSync with a fixed salt is deliberate here: the "salt" role is
  // already played by TOKEN_ENCRYPTION_KEY being a long random secret
  // distinct per deployment (like SHOPIFY_API_SECRET) — this just adapts an
  // arbitrary-length env var string into a 32-byte key, it is not
  // protecting a low-entropy user password.
  return scryptSync(secret, "plumbline-token-encryption", 32);
}

export function encryptToken(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptToken(encrypted: string, secret: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("malformed encrypted token — expected iv:authTag:ciphertext");
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}
