import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adminCreateBikeSchema } from "@shared/schema";
import {
  buildBikeSavePayload,
  liveLockBatteryDisplay,
  lockPickerOptions,
} from "./BikesPage";

const IMEI = "862596083776074";
const source = readFileSync(resolve(process.cwd(), "client/src/pages/BikesPage.tsx"), "utf8");

describe("bound lock IMEI column", () => {
  it("renders the bound lock IMEI and shows a dash when no IMEI is bound", () => {
    expect(source).toContain('<TableHead>Замок ID</TableHead>');
    expect(source).toContain('{b.lockImei || "—"}');
    expect(source).not.toContain('{b.lockId || "—"}');
  });
});

describe("bike lock picker", () => {
  it("selects and submits the numeric IMEI instead of the display text", () => {
    const [option] = lockPickerOptions([{ imei: IMEI, lastSeen: Date.now() }], null);

    // This models Radix Select calling onValueChange with the selected item's
    // value; the label must not be allowed to become the binding identifier.
    let selectedImei = "";
    const onValueChange = (value: string) => { selectedImei = value; };
    onValueChange(option.value);

    expect(option).toEqual({ value: IMEI, label: IMEI });
    expect(selectedImei).toBe(IMEI);
    expect(adminCreateBikeSchema.parse({
      id: "BC-100",
      model: "City",
      battery: 100,
      lockImei: selectedImei,
    }).lockImei).toBe(IMEI);
  });

  it("keeps an already-bound lock selectable with its numeric IMEI only", () => {
    expect(lockPickerOptions([], IMEI)).toEqual([{ value: IMEI, label: IMEI }]);
  });
});

describe("live lock battery display", () => {
  it("renders charge as a display-only field with a freshness label", () => {
    expect(source).toContain('data-testid="display-bike-battery"');
    expect(source).toContain('data-testid="text-bike-battery-freshness"');
    expect(source).not.toContain('data-testid="input-bike-battery"');
    expect(source).not.toContain("form.battery");
  });

  it("shows the reported charge and recent freshness for a connected lock", () => {
    const now = Date.now();

    expect(liveLockBatteryDisplay({
      battery: 73,
      lockImei: IMEI,
      lockLastSeen: now - 2 * 60_000,
    })).toEqual({ value: "73%", freshness: "обновлено 2 мин назад" });
  });

  it("keeps the reported charge but makes stale telemetry visible", () => {
    const now = Date.now();

    expect(liveLockBatteryDisplay({
      battery: 27,
      lockImei: IMEI,
      lockLastSeen: now - 2 * 24 * 60 * 60_000,
    })).toEqual({ value: "27%", freshness: "обновлено 2 д назад" });
  });

  it("shows no data when no lock telemetry is available", () => {
    expect(liveLockBatteryDisplay({
      battery: 100,
      lockImei: null,
      lockLastSeen: null,
    })).toEqual({ value: "—", freshness: "Нет данных" });

    expect(liveLockBatteryDisplay({
      battery: 100,
      lockImei: IMEI,
      lockLastSeen: null,
    })).toEqual({ value: "—", freshness: "Нет данных" });
  });
});

describe("bike save payload", () => {
  const form = {
    id: "BC-100",
    model: "City",
    status: "available" as const,
    serial: "",
    lockId: "",
    lockImei: IMEI,
    parkingId: "",
    notes: "",
  };

  it("does not submit battery when creating a bike, leaving the schema default", () => {
    const payload = buildBikeSavePayload(form, null);

    expect(payload).not.toHaveProperty("battery");
    expect(adminCreateBikeSchema.parse(payload).battery).toBe(100);
  });

  it("does not submit battery when updating a bike", () => {
    const payload = buildBikeSavePayload(form, { id: form.id, lockImei: IMEI });

    expect(payload).not.toHaveProperty("battery");
    expect(payload).not.toHaveProperty("lockImei");
  });
});
