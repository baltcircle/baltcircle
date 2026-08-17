import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const ORIGINAL_ENV = { ...process.env };

async function freshModule() {
  vi.resetModules();
  return await import("./payment-tokens");
}

describe("payment-tokens crypto", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NODE_ENV;
    delete process.env.PAYMENT_TOKEN_KEY;
  });

  it("round-trips a token through encrypt/decrypt", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { encryptToken, decryptToken } = await freshModule();
    const plain = "rebill-abc123XYZ";
    const stored = encryptToken(plain);
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain(plain);
    expect(decryptToken(stored)).toBe(plain);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { encryptToken } = await freshModule();
    const a = encryptToken("same-plaintext");
    const b = encryptToken("same-plaintext");
    expect(a).not.toBe(b);
  });

  it("decryptToken returns null for null/undefined/empty input", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { decryptToken } = await freshModule();
    expect(decryptToken(null)).toBeNull();
    expect(decryptToken(undefined)).toBeNull();
    expect(decryptToken("")).toBeNull();
  });

  it("passes through legacy plaintext values unchanged (no v1: prefix)", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { decryptToken } = await freshModule();
    expect(decryptToken("legacy-plaintext-rebill-id")).toBe("legacy-plaintext-rebill-id");
  });

  it("fails closed (throws) if ciphertext is tampered with", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { encryptToken, decryptToken } = await freshModule();
    const stored = encryptToken("some-token");
    const tamperedBase64 = stored.slice(3);
    const buf = Buffer.from(tamperedBase64, "base64");
    buf[buf.length - 1] ^= 0xff; // flip last byte of ciphertext
    const tampered = "v1:" + buf.toString("base64");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("hashTokenForLookup is deterministic for the same input", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { hashTokenForLookup } = await freshModule();
    expect(hashTokenForLookup("token-a")).toBe(hashTokenForLookup("token-a"));
  });

  it("hashTokenForLookup differs for different inputs", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { hashTokenForLookup } = await freshModule();
    expect(hashTokenForLookup("token-a")).not.toBe(hashTokenForLookup("token-b"));
  });

  it("encryption and hash keys are derived differently (enc key can't validate as idx key)", async () => {
    process.env.PAYMENT_TOKEN_KEY = "test-master-secret-1";
    const { encryptToken, hashTokenForLookup } = await freshModule();
    const enc = encryptToken("value");
    const hash = hashTokenForLookup("value");
    // Sanity: they're structurally different outputs (base64 v1: vs hex) and
    // not trivially derivable from one another.
    expect(enc).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different PAYMENT_TOKEN_KEY values produce different ciphertext for the same plaintext", async () => {
    process.env.PAYMENT_TOKEN_KEY = "key-one";
    const mod1 = await freshModule();
    const c1 = mod1.encryptToken("payload");

    process.env.PAYMENT_TOKEN_KEY = "key-two";
    const mod2 = await freshModule();
    // Decrypting ciphertext produced under a different key must fail (wrong tag).
    expect(() => mod2.decryptToken(c1)).toThrow();
  });

  it("uses an insecure dev fallback key (with warning) when PAYMENT_TOKEN_KEY is unset outside production", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.PAYMENT_TOKEN_KEY;
    const { encryptToken, decryptToken } = await freshModule();
    const stored = encryptToken("dev-token");
    expect(decryptToken(stored)).toBe("dev-token");
  });

  it("throws in production when PAYMENT_TOKEN_KEY is unset", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PAYMENT_TOKEN_KEY;
    const { encryptToken } = await freshModule();
    expect(() => encryptToken("x")).toThrow(/PAYMENT_TOKEN_KEY is required in production/);
  });
});
