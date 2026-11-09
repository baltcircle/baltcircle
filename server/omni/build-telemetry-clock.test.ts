// Production, 2026-11-09: BC-002 reported a fix whose GNSS date was ~29.7h
// ahead; the old symmetric 7-day skew window stored it as-is, so it looked
// "fresh" to every time-window query for over a day.
import { describe, expect, it, vi } from "vitest";

// server.ts -> store.ts imports the shared pg pool; keep this suite DB-free.
vi.mock("../db/bootstrap", () => ({
  pool: { query: async () => ({ rows: [] }) },
  db: {},
  bootstrapReady: Promise.resolve(),
}));

import { buildTelemetry } from "./server";
import { MAX_GPS_CLOCK_AHEAD_MS, MAX_GPS_CLOCK_BEHIND_MS } from "@shared/geo";
import type { OmniMessage } from "@shared/omni/protocol";

const RECEIVED_AT = Date.UTC(2026, 10, 9, 20, 43, 41);
const position = (fixedAt: number | null): OmniMessage => ({
  type: "position", cmd: "D0", tracking: true, valid: true,
  fix: { lat: 54.959, lng: 20.4806, satellites: 9, hdop: 1.2, altitudeM: 10, fixedAt },
});
const storedAt = (fixedAt: number | null) => buildTelemetry("BC-002", "861234567890123", position(fixedAt), RECEIVED_AT)!.row.t;

describe("buildTelemetry GPS clock bounds", () => {
  it("replaces a future-dated GNSS timestamp with the receipt time", () => {
    expect(storedAt(RECEIVED_AT + 106_986_000)).toBe(RECEIVED_AT);
    expect(storedAt(RECEIVED_AT + MAX_GPS_CLOCK_AHEAD_MS + 1)).toBe(RECEIVED_AT);
  });

  it("keeps a GNSS timestamp within the allowed lead", () => {
    expect(storedAt(RECEIVED_AT + MAX_GPS_CLOCK_AHEAD_MS)).toBe(RECEIVED_AT + MAX_GPS_CLOCK_AHEAD_MS);
    expect(storedAt(RECEIVED_AT - 3_000)).toBe(RECEIVED_AT - 3_000);
  });

  it("keeps delayed uploads within the past window and rejects older dates", () => {
    expect(storedAt(RECEIVED_AT - 60 * 60 * 1000)).toBe(RECEIVED_AT - 60 * 60 * 1000);
    expect(storedAt(RECEIVED_AT - MAX_GPS_CLOCK_BEHIND_MS - 1)).toBe(RECEIVED_AT);
    expect(storedAt(null)).toBe(RECEIVED_AT);
  });
});
