import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./db/bootstrap", () => ({ db: mocks, pool: { query: vi.fn() }, bootstrapReady: Promise.resolve() }));
import { storage } from "./storage";
import { bikeEvents, BIKE_EVENT_CHANNEL, notifyFleetDataChanged } from "./storage/events";

beforeEach(() => {
  vi.clearAllMocks();
  storage.invalidateBikesCache({ silent: true });
});
describe("fleet cache follows raw SQL writes", () => {
  it("does not serve a cached row after a direct OMNI status event", async () => {
    mocks.select.mockReturnValueOnce({ from: () => Promise.resolve([{ id: "BC-1", status: "available", battery: 80 }]) })
      .mockReturnValueOnce({ from: () => Promise.resolve([{ id: "BC-1", status: "lost", battery: 70 }]) });
    expect((await storage.listBikes())[0].status).toBe("available");
    bikeEvents.emit(BIKE_EVENT_CHANNEL);
    expect((await storage.listBikes())[0].status).toBe("lost");
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });
  it("invalidates ordinary telemetry without sending a ride/status event", async () => {
    const listener = vi.fn();
    bikeEvents.on(BIKE_EVENT_CHANNEL, listener);
    try {
      mocks.select.mockReturnValueOnce({ from: () => Promise.resolve([{ id: "BC-1", battery: 80 }]) })
        .mockReturnValueOnce({ from: () => Promise.resolve([{ id: "BC-1", battery: 70 }]) });
      expect((await storage.listBikes())[0].battery).toBe(80);
      notifyFleetDataChanged();
      expect((await storage.listBikes())[0].battery).toBe(70);
      expect(listener).not.toHaveBeenCalled();
    } finally { bikeEvents.off(BIKE_EVENT_CHANNEL, listener); }
  });
});
