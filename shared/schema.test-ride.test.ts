import { describe, it, expect } from "vitest";
import { startTestRideSchema, TEST_RIDE_MIN_MINUTES, TEST_RIDE_MAX_MINUTES } from "./schema";

describe("startTestRideSchema", () => {
  it("длительность необязательна — без неё берётся окно тарифа", () => {
    const r = startTestRideSchema.safeParse({ bikeId: "BC-014", tariff: "h1" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.durationMinutes).toBeUndefined();
  });

  it("принимает границы диапазона", () => {
    for (const minutes of [TEST_RIDE_MIN_MINUTES, 16, TEST_RIDE_MAX_MINUTES]) {
      const r = startTestRideSchema.safeParse({ bikeId: "BC-014", tariff: "h1", durationMinutes: minutes });
      expect(r.success, `minutes=${minutes}`).toBe(true);
    }
  });

  it.each([
    ["ноль ставит дедлайн в момент старта", 0],
    ["отрицательное значение", -5],
    ["больше максимума — тестовая поездка держала бы велосипед слишком долго", TEST_RIDE_MAX_MINUTES + 1],
    ["дробное значение", 2.5],
  ])("отклоняет: %s", (_label, minutes) => {
    const r = startTestRideSchema.safeParse({ bikeId: "BC-014", tariff: "h1", durationMinutes: minutes });
    expect(r.success).toBe(false);
  });

  it("отклоняет строку вместо числа", () => {
    const r = startTestRideSchema.safeParse({ bikeId: "BC-014", tariff: "h1", durationMinutes: "16" });
    expect(r.success).toBe(false);
  });

  it("тариф всё ещё обязателен и ограничен каталогом", () => {
    expect(startTestRideSchema.safeParse({ bikeId: "BC-014", durationMinutes: 16 }).success).toBe(false);
    expect(startTestRideSchema.safeParse({ bikeId: "BC-014", tariff: "h9", durationMinutes: 16 }).success).toBe(false);
  });

  it("пресеты UI укладываются в допустимый диапазон", () => {
    // Значения продублированы из RentalStartModal.TEST_MINUTE_PRESETS: если
    // там появится значение вне диапазона, форма будет молча слать 400.
    for (const minutes of [2, 5, 7, 16, 30]) {
      expect(startTestRideSchema.safeParse({ bikeId: "BC-014", tariff: "h1", durationMinutes: minutes }).success).toBe(true);
    }
  });
});
