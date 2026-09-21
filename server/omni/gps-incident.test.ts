import { describe, expect, it, vi } from "vitest";
vi.mock("../db/bootstrap", () => ({
  pool: { query: async () => ({ rows: [] }) }, db: {},
  bootstrapReady: Promise.resolve(),
}));
import { buildTelemetry } from "./server";
import { PgOmniStore } from "./store";
import { pool } from "../db/bootstrap";
import { buildDevicePacket, decodeMessage, parseDeviceFrame } from "../../shared/omni/protocol";

const imei = "861234567890123"; // Synthetic, local only.
const at = Date.UTC(2026, 8, 21, 11, 40, 11);
function decode(params: (string | number)[]) {
  const parsed = parseDeviceFrame(buildDevicePacket({ imei, cmd: "D0", params, at }).toString());
  if (!parsed.ok) throw new Error(parsed.reason);
  const decoded = decodeMessage(parsed.frame);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.message;
}
const noFix = () => decode([1, "114011.00", "V", "", "", "", "", "", "", "210926", "", "", "N"]);
const freshFix = () => decode([1, "114011.00", "A", "5456.4000", "N", "02028.8000", "E", 8, 6.39, "210926", 20, "", "A"]);

describe("BC-002 incident: identical synthetic inputs before/after optimization", () => {
  it("preserves device no-fix as no-fix, without fabricated coordinates", () => {
    const message = noFix();
    expect(message).toMatchObject({ type: "position", valid: false, fix: null });
    const built = buildTelemetry("test-bike", imei, message, at)!;
    expect(built.row.lat).toBeNull();
    expect(built.row.lng).toBeNull();
    expect(built.live).toBeUndefined();
  });

  it("immediately accepts a valid fix following 20 no-fix reports", () => {
    for (let n = 0; n < 20; n++) buildTelemetry("test-bike", imei, noFix(), at - (20 - n) * 10000);
    const built = buildTelemetry("test-bike", imei, freshFix(), at)!;
    expect(built.row).toMatchObject({ lat: 54.94, lng: 20.48, satellites: 8, hdop: 6.39, t: at });
    expect(built.live?.x).toBeTypeOf("number");
    expect(built.throttleable).toBe(false);
  });

  it("updates the lock freshness before any batched route projection", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [{ last_latitude: "54.94", last_longitude: "20.48" }] } as never);
    try {
      expect(await new PgOmniStore().persistLockReport(imei, freshFix(), at)).toBe(true);
      const write = query.mock.calls.find(([sql]) => String(sql).includes("last_location_at = $2"));
      expect(write).toBeDefined();
      expect(write?.[1]).toEqual([imei, at, 54.94, 20.48]);
      expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO bike_telemetry"))).toBe(false);
    } finally { query.mockRestore(); }
  });
});
