import { describe, expect, it } from "vitest";
import { findNearestParkingWithinRadius, findNearestParkingWithinRadiusFromRealCoords, mapToReal } from "./geo";

const activeParking = (overrides: Record<string, unknown> = {}) => ({
  id: "P-1",
  lat: 350,
  lng: 215,
  radius: 30,
  status: "active",
  archivedAt: null,
  ...overrides,
});

describe("findNearestParkingWithinRadius", () => {
  it("returns a parking when the point is within that parking's radius", () => {
    expect(findNearestParkingWithinRadius(350, 217, [activeParking()])?.id).toBe("P-1");
  });

  it("chooses the nearest parking when eligible radii overlap", () => {
    const farther = activeParking({ id: "P-farther", lng: 214, radius: 50 });
    const nearest = activeParking({ id: "P-nearest", lng: 217, radius: 50 });

    expect(findNearestParkingWithinRadius(350, 218, [farther, nearest])?.id).toBe("P-nearest");
  });

  it("returns null outside every eligible parking radius", () => {
    expect(findNearestParkingWithinRadius(350, 220, [activeParking()])).toBeNull();
  });

  it("excludes archived and inactive parkings even when they are geographically closest", () => {
    const inactive = activeParking({ id: "P-inactive", lng: 217, status: "inactive", radius: 50 });
    const archived = activeParking({ id: "P-archived", lng: 218, archivedAt: 1, radius: 50 });
    const eligible = activeParking({ id: "P-eligible", lng: 219, radius: 50 });

    expect(findNearestParkingWithinRadius(350, 217, [inactive, archived, eligible])?.id).toBe("P-eligible");
  });
});

// Parking rows store map-space coordinates in all cases; only the QUERY point
// differs between the two entry points — findNearestParkingWithinRadius takes
// a map-space point (bikes.lat/lng) and converts it, while the
// FromRealCoords variant takes a point that is ALREADY real WGS84 (an OMNI
// lock's own GPS fix) and must skip that conversion. [lat, lng] here means
// real-world coordinates, produced via mapToReal from a map-space point so
// the fixture matches whatever anchor town the test environment resolves to.
describe("findNearestParkingWithinRadiusFromRealCoords", () => {
  it("returns a parking when the real-coordinate point is within that parking's radius", () => {
    const parking = activeParking({ radius: 500 });
    const [realLat, realLng] = mapToReal(parking.lng, parking.lat);

    expect(findNearestParkingWithinRadiusFromRealCoords(realLat, realLng, [parking])?.id).toBe("P-1");
  });

  it("returns null when the real-coordinate point is outside every eligible parking radius", () => {
    const parking = activeParking({ radius: 1 });
    // Offset from the parking's own real position by ~1km (~0.01 deg lat), far
    // outside a 1m radius.
    const [realLat, realLng] = mapToReal(parking.lng, parking.lat);

    expect(findNearestParkingWithinRadiusFromRealCoords(realLat + 0.01, realLng, [parking])).toBeNull();
  });

  it("does NOT double-convert a real point the way the map-space variant would", () => {
    // Feeding the raw map-space numbers into the FromRealCoords variant (as if
    // it applied mapToReal a second time) must NOT match — this pins down
    // that the two entry points are not interchangeable.
    const parking = activeParking({ radius: 30 });

    expect(findNearestParkingWithinRadiusFromRealCoords(parking.lat, parking.lng, [parking])).toBeNull();
  });

  it("excludes archived and inactive parkings for real-coordinate matching too", () => {
    const archived = activeParking({ id: "P-archived", archivedAt: 1, radius: 500 });
    const [realLat, realLng] = mapToReal(archived.lng, archived.lat);

    expect(findNearestParkingWithinRadiusFromRealCoords(realLat, realLng, [archived])).toBeNull();
  });
});
