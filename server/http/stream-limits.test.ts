import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createStreamLimiter } from "./stream-limits";

function open(middleware: ReturnType<typeof createStreamLimiter>, user: string) {
  const res = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(),
  });
  const next = vi.fn();
  middleware({ method: "GET", path: "/api/rides/active/stream", ip: "shared-nat", session: { userId: user } } as any,
    res as any, next);
  return { res, next };
}
describe("stream limits", () => {
  it("allows 100 users behind one IP and limits a single account", () => {
    const limiter = createStreamLimiter();
    for (let n = 0; n < 100; n++) expect(open(limiter, `u${n}`).next).toHaveBeenCalledOnce();
    for (let n = 0; n < 11; n++) expect(open(limiter, "u0").next).toHaveBeenCalledOnce();
    expect(open(limiter, "u0").res.status).toHaveBeenCalledWith(429);
  });
  it("releases once on close/error/finish and permits reconnect", () => {
    const limiter = createStreamLimiter();
    const sockets = Array.from({ length: 12 }, () => open(limiter, "u"));
    expect(open(limiter, "u").res.status).toHaveBeenCalledWith(429);
    sockets[0].res.emit("close");
    sockets[0].res.emit("finish");
    sockets[0].res.emit("error", new Error("closed"));
    expect(open(limiter, "u").next).toHaveBeenCalledOnce();
    expect(open(limiter, "u").res.status).toHaveBeenCalledWith(429);
  });
});
