// Пороги предупреждений об окончании оплаченного окна (shared/ride-expiry.ts).
import { describe, expect, it } from "vitest";

import {
  EXPIRY_BIT_10MIN, EXPIRY_BIT_5MIN, EXPIRY_BIT_OVERTIME,
  effectiveMask, nextExpiryNotice, type ExpiryCandidate,
} from "./ride-expiry";

const MIN = 60_000;
const NOW = 1_700_000_000_000;

function ride(overrides: Partial<ExpiryCandidate> = {}): ExpiryCandidate {
  return {
    startedAt: NOW - 50 * MIN,
    paidUntilAt: NOW + 30 * MIN,
    pausedAt: null,
    totalPausedMs: 0,
    expiryNotifiedMask: 0,
    expiryNotifiedFor: null,
    ...overrides,
  };
}

describe("nextExpiryNotice: пороги", () => {
  it("молчит, пока до конца больше 10 минут", () => {
    expect(nextExpiryNotice(ride({ paidUntilAt: NOW + 11 * MIN }), "BC-01", NOW)).toBeNull();
  });

  it("ровно 10 минут — предупреждение о 10 минутах", () => {
    const n = nextExpiryNotice(ride({ paidUntilAt: NOW + 10 * MIN }), "BC-01", NOW);
    expect(n?.stage).toBe("warn10");
    expect(n?.bit).toBe(EXPIRY_BIT_10MIN);
    expect(n?.nextMask).toBe(EXPIRY_BIT_10MIN);
    expect(n?.body).toContain("BC-01");
  });

  it("5 минут — предупреждение о 5 минутах, порог 10 гасится заодно", () => {
    const n = nextExpiryNotice(ride({ paidUntilAt: NOW + 5 * MIN }), "BC-01", NOW);
    expect(n?.stage).toBe("warn5");
    expect(n?.nextMask).toBe(EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN);
  });

  it("дедлайн прошёл — овертайм, оба ранних порога гасятся", () => {
    const n = nextExpiryNotice(ride({ paidUntilAt: NOW - MIN }), "BC-01", NOW);
    expect(n?.stage).toBe("overtime");
    expect(n?.nextMask).toBe(EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN | EXPIRY_BIT_OVERTIME);
  });

  it("простой сервера не рассылает пропущенные предупреждения задним числом", () => {
    // Sweep не работал 20 минут: райдер получает только «овертайм», а не три
    // уведомления подряд.
    const n = nextExpiryNotice(ride({ paidUntilAt: NOW - 20 * MIN }), "BC-01", NOW);
    expect(n?.stage).toBe("overtime");
  });
});

describe("nextExpiryNotice: дедупликация", () => {
  it("не повторяет уже отправленный порог", () => {
    const r = ride({
      paidUntilAt: NOW + 8 * MIN,
      expiryNotifiedMask: EXPIRY_BIT_10MIN,
      expiryNotifiedFor: NOW + 8 * MIN,
    });
    expect(nextExpiryNotice(r, "BC-01", NOW)).toBeNull();
  });

  it("после «10 минут» на пятой минуте шлёт следующий порог", () => {
    const r = ride({
      paidUntilAt: NOW + 4 * MIN,
      expiryNotifiedMask: EXPIRY_BIT_10MIN,
      expiryNotifiedFor: NOW + 4 * MIN,
    });
    expect(nextExpiryNotice(r, "BC-01", NOW)?.stage).toBe("warn5");
  });

  it("продление аренды обнуляет маску и возвращает все предупреждения", () => {
    // Маска записана для старого дедлайна — для нового она не действует.
    const r = ride({
      paidUntilAt: NOW + 9 * MIN,
      expiryNotifiedMask: EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN | EXPIRY_BIT_OVERTIME,
      expiryNotifiedFor: NOW - 30 * MIN,
    });
    expect(effectiveMask(r)).toBe(0);
    expect(nextExpiryNotice(r, "BC-01", NOW)?.stage).toBe("warn10");
  });
});

describe("nextExpiryNotice: пауза и короткие тарифы", () => {
  it("пауза внутри бесплатного грейса отодвигает дедлайн — предупреждение ждёт", () => {
    // Сырой paidUntilAt уже внутри 10-минутного окна, но 6 минут паузы
    // добавятся к оплаченному времени при возобновлении.
    const r = ride({ paidUntilAt: NOW + 9 * MIN, pausedAt: NOW - 6 * MIN, totalPausedMs: 0 });
    expect(nextExpiryNotice(r, "BC-01", NOW)).toBeNull();
  });

  it("исчерпанный грейс паузы дедлайн больше не двигает", () => {
    const r = ride({
      paidUntilAt: NOW + 4 * MIN,
      pausedAt: NOW - 30 * MIN,
      totalPausedMs: 10 * MIN, // грейс израсходован полностью
    });
    expect(nextExpiryNotice(r, "BC-01", NOW)?.stage).toBe("warn5");
  });

  it("минутный тариф не получает предупреждений «за 10» и «за 5» минут", () => {
    // Окно короче порога: такое предупреждение прилетело бы сразу после старта.
    const r = ride({ startedAt: NOW - 30_000, paidUntilAt: NOW + 30_000 });
    expect(nextExpiryNotice(r, "BC-01", NOW)).toBeNull();
    const overtime = nextExpiryNotice(
      ride({ startedAt: NOW - 90_000, paidUntilAt: NOW - 30_000 }), "BC-01", NOW,
    );
    expect(overtime?.stage).toBe("overtime");
  });

  it("часовой тариф порог «за 5» получает, часовой — оба", () => {
    const r = ride({ startedAt: NOW - 55 * MIN, paidUntilAt: NOW + 5 * MIN });
    expect(nextExpiryNotice(r, "BC-01", NOW)?.stage).toBe("warn5");
  });

  it("без paidUntilAt (исторические строки) не шлёт ничего", () => {
    expect(nextExpiryNotice(ride({ paidUntilAt: null }), "BC-01", NOW)).toBeNull();
  });
});

// Пресеты длительности тестовой поездки (RentalStartModal.TEST_MINUTE_PRESETS)
// продают конкретное обещание оператору: «16 минут — все три уведомления».
// Обещание держится порогом windowMs, поэтому его надо проверять здесь.
describe("пресеты тестовой поездки дают обещанные уведомления", () => {
  /** Стадии, которые реально придут за поездку длиной windowMinutes. */
  function stagesFor(windowMinutes: number): string[] {
    const startedAt = NOW;
    const paidUntilAt = startedAt + windowMinutes * MIN;
    let mask = 0;
    const seen: string[] = [];
    // Идём минутными шагами, как sweep, и на минуту дальше дедлайна.
    for (let t = startedAt; t <= paidUntilAt + MIN; t += MIN) {
      const n = nextExpiryNotice(
        ride({ startedAt, paidUntilAt, expiryNotifiedMask: mask, expiryNotifiedFor: paidUntilAt }),
        "BC-01",
        t,
      );
      if (n) {
        seen.push(n.stage);
        mask = n.nextMask;
      }
    }
    return seen;
  }

  it("2 минуты — только овертайм", () => {
    expect(stagesFor(2)).toEqual(["overtime"]);
  });

  it("5 минут — только овертайм: окно не длиннее ни одного порога", () => {
    expect(stagesFor(5)).toEqual(["overtime"]);
  });

  it("7 минут — «за 5» и овертайм", () => {
    expect(stagesFor(7)).toEqual(["warn5", "overtime"]);
  });

  it("16 минут — все три", () => {
    expect(stagesFor(16)).toEqual(["warn10", "warn5", "overtime"]);
  });

  it("30 минут — все три", () => {
    expect(stagesFor(30)).toEqual(["warn10", "warn5", "overtime"]);
  });
});
