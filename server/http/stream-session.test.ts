import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("../storage", () => ({ storage: mock }));
import { streamSessionValid } from "./stream-session";

describe("private SSE session revalidation", () => {
  beforeEach(() => { mock.getUser.mockResolvedValue({ id: "a" }); });
  const req = (userId = "a", error?: Error) => ({
    session: { userId, reload: (cb: (error?: Error) => void) => cb(error) },
  } as unknown as Request);
  it("accepts only the captured authenticated identity", async () => {
    expect(await streamSessionValid(req(), "a")).toBe(true);
    expect(await streamSessionValid(req("b"), "a")).toBe(false);
  });
  it("fails closed after logout/session expiry or database failure", async () => {
    expect(await streamSessionValid(req("a", new Error("expired")), "a")).toBe(false);
    mock.getUser.mockRejectedValue(new Error("offline"));
    expect(await streamSessionValid(req(), "a")).toBe(false);
  });
  it.each([{ deletedAt: 1 }, { blockedAt: 1 }, undefined])("rejects deleted/blocked/missing accounts: %j", async (user) => {
    mock.getUser.mockResolvedValue(user);
    expect(await streamSessionValid(req(), "a")).toBe(false);
  });
});
