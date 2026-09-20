import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("../storage", () => ({ storage: mock }));
import { registerAdminLiveRoutes } from "./admin-live";
import { bikeEvents, BIKE_EVENT_CHANNEL, fleetDataEvents } from "../storage/events";

const controllers: AbortController[] = [];
let server: Server | undefined;
afterEach(async () => {
  controllers.splice(0).forEach((c) => c.abort());
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  vi.clearAllMocks();
});
async function start() {
  mock.getUser.mockImplementation(async (id: string) => ({ id, role: id === "operator" ? "operator" : "rider" }));
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: req.headers["x-test-user"], reload: (cb: (err?: Error) => void) => cb() } as typeof req.session;
    next();
  });
  registerAdminLiveRoutes(app);
  app.post("/api/admin/users/test/role", (_req, res) => res.json({ ok: true }));
  app.post("/api/admin/users/fail/role", (_req, res) => res.status(500).json({ error: "test" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" ? address!.port : 0}`;
}
async function connect(base: string) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${base}/api/admin/events`, { headers: { "x-test-user": "operator" }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let buffer = "";
  const next = async () => {
    while (!buffer.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream ended before event");
      buffer += new TextDecoder().decode(chunk.value);
    }
    const end = buffer.indexOf("\n\n");
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return JSON.parse(frame.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
  };
  return { next, controller };
}
describe("authenticated admin SSE transport", () => {
  it("rejects anonymous and rider connections", async () => {
    const base = await start();
    expect((await fetch(`${base}/api/admin/events`)).status).toBe(401);
    expect((await fetch(`${base}/api/admin/events`, { headers: { "x-test-user": "rider" } })).status).toBe(403);
  });
  it("delivers writes to two sessions, recovers missed data on reconnect, cleans listeners", async () => {
    const fleetListeners = bikeEvents.listenerCount(BIKE_EVENT_CHANNEL);
    const telemetryListeners = fleetDataEvents.listenerCount("telemetry");
    const base = await start();
    const first = await connect(base);
    const second = await connect(base);
    for (const stream of [first, second]) {
      expect((await stream.next()).topics).toContain("users");
    }
    await fetch(`${base}/api/admin/users/test/role`, { method: "POST" });
    for (const stream of [first, second]) expect((await stream.next()).topics).toEqual(["users"]);
    first.controller.abort();
    second.controller.abort();
    await vi.waitFor(() => expect(bikeEvents.listenerCount(BIKE_EVENT_CHANNEL)).toBe(fleetListeners));
    expect(fleetDataEvents.listenerCount("telemetry")).toBe(telemetryListeners);
    const reconnected = await connect(base);
    const recovery = await reconnected.next();
    expect(recovery.topics).toContain("support");
    expect(recovery.topics).toContain("feedback");
  });
});
