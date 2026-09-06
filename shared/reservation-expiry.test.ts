import { describe, it, expect } from "vitest";
import { RESERVATION_TTL_MS } from "./geo";
import {
  nextReservationNotice, reservationExpiredTexts, reservationTag,
  RESERVATION_BIT_WARN_2MIN, RESERVATION_WARN_MS,
} from "./reservation-expiry";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const EXPIRES = T0 + RESERVATION_TTL_MS;

describe("nextReservationNotice", () => {
  it("молчит сразу после брони", () => {
    expect(nextReservationNotice({ expiresAt: EXPIRES, notifiedMask: 0 }, "BC-014", T0)).toBeNull();
  });

  it("предупреждает ровно за 2 минуты", () => {
    const notice = nextReservationNotice(
      { expiresAt: EXPIRES, notifiedMask: 0 },
      "BC-014",
      EXPIRES - RESERVATION_WARN_MS,
    );
    expect(notice?.title).toBe("Бронь: осталось 2 мин.");
    expect(notice?.body).toContain("BC-014");
    expect(notice?.nextMask).toBe(RESERVATION_BIT_WARN_2MIN);
  });

  it("округляет остаток вверх до целых минут", () => {
    // 90 секунд — это «2 мин.» на карточке, а не «1 мин.»: округление вниз
    // обещало бы райдеру меньше времени, чем у него есть.
    const notice = nextReservationNotice(
      { expiresAt: EXPIRES, notifiedMask: 0 },
      "BC-014",
      EXPIRES - 90_000,
    );
    expect(notice?.title).toBe("Бронь: осталось 2 мин.");
  });

  it("не повторяет уже отправленное", () => {
    const notice = nextReservationNotice(
      { expiresAt: EXPIRES, notifiedMask: RESERVATION_BIT_WARN_2MIN },
      "BC-014",
      EXPIRES - MIN,
    );
    expect(notice).toBeNull();
  });

  it("молчит по уже истёкшей брони", () => {
    // Ею занимается sweep аннулирования — иначе райдер получил бы «осталось
    // 0 мин.» и следом «Бронь отменена».
    expect(nextReservationNotice({ expiresAt: EXPIRES, notifiedMask: 0 }, "BC-014", EXPIRES)).toBeNull();
    expect(nextReservationNotice({ expiresAt: EXPIRES, notifiedMask: 0 }, "BC-014", EXPIRES + MIN)).toBeNull();
  });

  it("даёт ровно одно предупреждение за жизнь брони", () => {
    let mask = 0;
    const titles: string[] = [];
    for (let i = 0; i <= 10; i++) {
      const notice = nextReservationNotice({ expiresAt: EXPIRES, notifiedMask: mask }, "BC-014", T0 + i * MIN);
      if (!notice) continue;
      titles.push(notice.title);
      mask = notice.nextMask;
    }
    expect(titles).toEqual(["Бронь: осталось 2 мин."]);
  });
});

describe("reservationExpiredTexts", () => {
  it("называет велосипед и объясняет последствие", () => {
    const t = reservationExpiredTexts("BC-014");
    expect(t.title).toBe("Бронь отменена");
    expect(t.body).toContain("BC-014");
  });
});

describe("reservationTag", () => {
  it("уникален на бронь", () => {
    expect(reservationTag(1)).not.toBe(reservationTag(2));
  });
});
