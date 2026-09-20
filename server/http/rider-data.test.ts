import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ getUser: vi.fn(), riderHistory: vi.fn(), riderStats: vi.fn() }));
vi.mock("../storage", () => ({ storage: mock }));
vi.mock("../storage/rider-read", () => mock);
import { registerRiderDataRoutes } from "./rider-data";
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  vi.clearAllMocks();
});
async function start() {
  mock.getUser.mockImplementation(async (id) => ({ id, role: "rider" }));
  mock.riderHistory.mockResolvedValue({ items: [], nextBefore: null });
  mock.riderStats.mockResolvedValue({ rides: 333, distanceM: 444000 });
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: req.headers["x-test-user"] } as typeof req.session;
    next();
  });
  registerRiderDataRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" ? address!.port : 0}`;
}
describe("owner-only rider reads", () => {
  it("rejects anonymous requests to both endpoints", async () => {
    const base = await start();
    for (const path of ["history", "stats"]) expect((await fetch(`${base}/api/rider/${path}`)).status).toBe(401);
    expect(mock.riderHistory).not.toHaveBeenCalled();
  });
  it("ignores foreign identity input and validates pagination", async () => {
    const base = await start();
    const headers = { "x-test-user": "owner" };
    expect((await fetch(`${base}/api/rider/history?userId=victim&before=1000:41`, { headers })).status).toBe(200);
    expect(mock.riderHistory).toHaveBeenCalledWith("owner", { startedAt: 1000, id: 41 });
    expect((await fetch(`${base}/api/rider/history?before=-1`, { headers })).status).toBe(400);
    const response = await fetch(`${base}/api/rider/stats?userId=victim`, { headers });
    expect(await response.json()).toEqual({ rides: 333, distanceM: 444000 });
    expect(mock.riderStats).toHaveBeenCalledWith("owner");
  });
});
