import { describe, expect, it } from "vitest";
import { adminCreateBikeSchema } from "@shared/schema";
import { lockPickerOptions } from "./BikesPage";

const IMEI = "862596083776074";

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
