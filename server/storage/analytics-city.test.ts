import { describe, expect, it, vi } from "vitest";

vi.mock("../db/bootstrap", () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ c: 0, s: 0, a: 0, r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 }] })) },
}));
import { AnalyticsMixin } from "./analytics";
import type { Bike, Parking } from "@shared/schema";

describe("admin analytics parking city payload", () => {
  it("includes the persisted city even when a parking has no rides", async () => {
    class Base {
      async listBikes(): Promise<Bike[]> { return []; }
      async listParkings(): Promise<Parking[]> {
        return [{ id: "K-01", name: "Тест", city: "Калининград", capacity: 10, occupied: 2 } as Parking];
      }
    }
    const storage = new (AnalyticsMixin(Base))();
    const result = await storage.adminAnalytics({ from: 0, to: 100 });
    expect(result.parkingUsage).toEqual([
      { id: "K-01", name: "Тест", city: "Калининград", capacity: 10, occupied: 2, rideStarts: 0 },
    ]);
  });
});
