import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportMessage } from "@shared/schema";

// saveAttachment/resolveOutgoingMessage(s) decide, purely by convention on the
// attachmentUrl string ("/"-prefixed legacy path vs. bare Object Storage key),
// whether to hit the local disk or the (mocked) S3 client. Mocking
// ../storage/object-storage keeps this test network-free and fast, matching
// the poolMock/dbMock pattern used elsewhere in this test suite.

const osMock = vi.hoisted(() => ({
  isObjectStorageConfigured: vi.fn(),
  putSupportAttachment: vi.fn(),
  presignSupportAttachment: vi.fn(),
}));

vi.mock("../storage/object-storage", () => ({
  ...osMock,
  PREVIEW_URL_TTL_SECONDS: 900,
  MESSAGE_URL_TTL_SECONDS: 86400,
}));

vi.mock("../logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

// support.ts pulls in "../storage" and "../push", which eagerly import
// server/db/bootstrap.ts (real pg Pool + a schema-migration attempt on
// startup). Stub both out so importing the route module in isolation never
// tries a real network connection to Postgres — this file only exercises the
// attachment-storage helpers, not DB-backed behaviour.
vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../push", () => ({ sendToUserAsync: vi.fn() }));

// fs is only touched on the local-disk fallback path — real tmp writes are
// fine there (no network), so it is not mocked.

import { saveAttachment, resolveOutgoingMessage, resolveOutgoingMessages } from "./support";

function makeMessage(overrides: Partial<SupportMessage> = {}): SupportMessage {
  return {
    id: 1,
    conversationId: 1,
    senderRole: "user",
    senderId: "u1",
    body: "hi",
    attachmentUrl: null,
    attachmentMime: null,
    readAt: null,
    createdAt: Date.now(),
    ...overrides,
  } as SupportMessage;
}

beforeEach(() => {
  osMock.isObjectStorageConfigured.mockReset();
  osMock.putSupportAttachment.mockReset();
  osMock.presignSupportAttachment.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saveAttachment", () => {
  it("uploads to Object Storage and returns a bare key as url when configured", async () => {
    osMock.isObjectStorageConfigured.mockReturnValue(true);
    osMock.putSupportAttachment.mockResolvedValue(undefined);
    osMock.presignSupportAttachment.mockResolvedValue("https://bucket.example/support/abc.jpg?sig=1");

    const result = await saveAttachment(Buffer.from("fake-image-bytes"), "image/jpeg");

    expect(osMock.putSupportAttachment).toHaveBeenCalledTimes(1);
    const [key, buf, mime] = osMock.putSupportAttachment.mock.calls[0];
    expect(key).toMatch(/^support\/[0-9a-f-]+\.jpg$/);
    expect(buf).toBeInstanceOf(Buffer);
    expect(mime).toBe("image/jpeg");

    // Stored url is the bare key (no leading slash) — never a presigned URL,
    // which would expire before the message is read again.
    expect(result.url).toBe(key);
    expect(result.url.startsWith("/")).toBe(false);
    expect(result.previewUrl).toBe("https://bucket.example/support/abc.jpg?sig=1");
    expect(result.mime).toBe("image/jpeg");
  });

  it("falls back to local disk when Object Storage is not configured", async () => {
    osMock.isObjectStorageConfigured.mockReturnValue(false);
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(tmpdir(), `support-upload-test-${Date.now()}`);
    vi.stubEnv("UPLOADS_DIR", dir);

    // Re-import fresh module instance so UPLOADS_DIR (read at module load
    // time) picks up the stubbed env var.
    vi.resetModules();
    const mod = await import("./support");
    const result = await mod.saveAttachment(Buffer.from("fake-image-bytes"), "image/png");

    expect(osMock.putSupportAttachment).not.toHaveBeenCalled();
    expect(result.url).toMatch(/^\/uploads\/support\/[0-9a-f-]+\.png$/);
    // Legacy path: previewUrl and the stored url are identical.
    expect(result.previewUrl).toBe(result.url);

    const fs = await import("node:fs/promises");
    const filename = result.url.split("/").pop()!;
    const stat = await fs.stat(path.join(dir, "support", filename));
    expect(stat.isFile()).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("resolveOutgoingMessage", () => {
  it("passes through messages with no attachment untouched", async () => {
    const msg = makeMessage({ attachmentUrl: null });
    const resolved = await resolveOutgoingMessage(msg);
    expect(resolved).toEqual(msg);
    expect(osMock.presignSupportAttachment).not.toHaveBeenCalled();
  });

  it("passes through legacy local-disk paths untouched (no presign)", async () => {
    const msg = makeMessage({ attachmentUrl: "/uploads/support/legacy.jpg" });
    const resolved = await resolveOutgoingMessage(msg);
    expect(resolved.attachmentUrl).toBe("/uploads/support/legacy.jpg");
    expect(osMock.presignSupportAttachment).not.toHaveBeenCalled();
  });

  it("presigns a bare Object Storage key into a working URL", async () => {
    osMock.presignSupportAttachment.mockResolvedValue("https://bucket.example/support/abc.jpg?sig=2");
    const msg = makeMessage({ attachmentUrl: "support/abc.jpg" });
    const resolved = await resolveOutgoingMessage(msg);
    expect(osMock.presignSupportAttachment).toHaveBeenCalledWith("support/abc.jpg", 86400);
    expect(resolved.attachmentUrl).toBe("https://bucket.example/support/abc.jpg?sig=2");
  });

  it("degrades to a null attachment instead of failing the whole message on a presign error", async () => {
    osMock.presignSupportAttachment.mockRejectedValue(new Error("network down"));
    const msg = makeMessage({ attachmentUrl: "support/abc.jpg" });
    const resolved = await resolveOutgoingMessage(msg);
    expect(resolved.attachmentUrl).toBeNull();
    // Rest of the message is preserved.
    expect(resolved.id).toBe(msg.id);
    expect(resolved.body).toBe(msg.body);
  });
});

describe("resolveOutgoingMessages", () => {
  it("resolves a batch in parallel and preserves order", async () => {
    osMock.presignSupportAttachment.mockImplementation(async (key: string) => `https://bucket.example/${key}?sig=x`);
    const msgs = [
      makeMessage({ id: 1, attachmentUrl: null }),
      makeMessage({ id: 2, attachmentUrl: "support/a.jpg" }),
      makeMessage({ id: 3, attachmentUrl: "/uploads/support/legacy.jpg" }),
    ];
    const resolved = await resolveOutgoingMessages(msgs);
    expect(resolved.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(resolved[0].attachmentUrl).toBeNull();
    expect(resolved[1].attachmentUrl).toBe("https://bucket.example/support/a.jpg?sig=x");
    expect(resolved[2].attachmentUrl).toBe("/uploads/support/legacy.jpg");
  });
});
