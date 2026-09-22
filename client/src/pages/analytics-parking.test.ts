import { describe, expect, it } from "vitest";
import { filterParkingUsage } from "./analytics-parking";

describe("analytics parking city filter", () => {
  const rows = [
    { id: "K-01", city: "Калининград", rideStarts: 0 },
    { id: "Z-01", city: "Зеленоградск", rideStarts: 3 },
    { id: "OLD", city: "", rideStarts: 0 },
  ];
  it("retains every parking for all cities, including legacy rows", () => {
    expect(filterParkingUsage(rows, "all")).toEqual(rows);
  });
  it("filters by the server city and preserves zero-ride rows", () => {
    expect(filterParkingUsage(rows, "Калининград")).toEqual([rows[0]]);
  });
  it("returns no rows for a city without parking", () => {
    expect(filterParkingUsage(rows, "Балтийск")).toEqual([]);
  });
});
