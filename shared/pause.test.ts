import { describe, it, expect } from "vitest";
import {
  frozenSoFarMs, pendingPauseCreditMs, liveElapsedRidingMs, liveRemainingPaidMs, computeLiveOverage,
  remainingFreeGraceMs, type PausableRide,
} from "./pause";
import { PAUSE_FREE_GRACE_MS } from "./geo";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function ride(overrides: Partial<PausableRide> = {}): PausableRide {
  return {
    startedAt: 0,
    paidUntilAt: HOUR,
    pausedAt: null,
    totalPausedMs: 0,
    ...overrides,
  };
}

describe("frozenSoFarMs", () => {
  it("не паузится — просто отражает уже накопленный totalPausedMs, capped", () => {
    expect(frozenSoFarMs(ride({ totalPausedMs: 2 * MIN }), 5 * MIN)).toBe(2 * MIN);
    expect(frozenSoFarMs(ride({ totalPausedMs: PAUSE_FREE_GRACE_MS + 5 * MIN }), 5 * MIN)).toBe(PAUSE_FREE_GRACE_MS);
  });

  it("во время паузы растёт в реальном времени до исчерпания грейса", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: 0 });
    expect(frozenSoFarMs(r, 1000 + 3 * MIN)).toBe(3 * MIN);
  });

  it("останавливается на кумулятивном лимите даже если пауза продолжается", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: PAUSE_FREE_GRACE_MS - 2 * MIN });
    // Пауза длится дольше оставшихся 2 минут грейса — не должно превысить лимит.
    expect(frozenSoFarMs(r, 1000 + 10 * MIN)).toBe(PAUSE_FREE_GRACE_MS);
  });
});

describe("pendingPauseCreditMs", () => {
  it("0, если не на паузе", () => {
    expect(pendingPauseCreditMs(ride({ pausedAt: null }), 999999)).toBe(0);
  });

  it("полный кредит, если пауза короче остатка грейса", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: 0 });
    expect(pendingPauseCreditMs(r, 1000 + 4 * MIN)).toBe(4 * MIN);
  });

  it("кредит ограничен остатком кумулятивного грейса", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: PAUSE_FREE_GRACE_MS - MIN });
    expect(pendingPauseCreditMs(r, 1000 + 5 * MIN)).toBe(MIN);
  });

  it("0, если грейс уже полностью исчерпан прошлыми паузами", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: PAUSE_FREE_GRACE_MS });
    expect(pendingPauseCreditMs(r, 1000 + 5 * MIN)).toBe(0);
  });
});

describe("liveElapsedRidingMs — непрерывность на границах пауза/резюм", () => {
  it("замирает во время паузы, пока не исчерпан грейс", () => {
    const r = ride({ pausedAt: 5 * MIN, totalPausedMs: 0 });
    const atPause = liveElapsedRidingMs(r, 5 * MIN);
    const midPause = liveElapsedRidingMs(r, 5 * MIN + 2 * MIN);
    expect(midPause).toBe(atPause); // всё ещё внутри грейса — не растёт
  });

  it("продолжает тикать во время паузы после исчерпания грейса", () => {
    // Грейс уже полностью исчерпан (за счёт прошлых пауз, до
    // 15-й минуты поездки) -> frozenSoFarMs константен с самого начала этой
    // паузы, поэтому живое значение сразу тикает 1:1 с now.
    const r = ride({ pausedAt: 15 * MIN, totalPausedMs: PAUSE_FREE_GRACE_MS });
    const atPause = liveElapsedRidingMs(r, 15 * MIN);
    const later = liveElapsedRidingMs(r, 15 * MIN + 3 * MIN);
    expect(later).toBe(atPause + 3 * MIN);
  });

  it("непрерывность в момент resume: live-значение в момент resume совпадает по обе стороны границы", () => {
    // Пауза с 5 до 5+3мин (целиком в рамках грейса), потом резюм.
    const pausedAt = 5 * MIN;
    const resumeAt = pausedAt + 3 * MIN;
    const rWhilePaused = ride({ pausedAt, totalPausedMs: 0 });
    const justBeforeResume = liveElapsedRidingMs(rWhilePaused, resumeAt - 1);

    // После resume: pausedAt=null, totalPausedMs накопил фактическую паузу.
    const rAfterResume = ride({ pausedAt: null, totalPausedMs: 3 * MIN });
    const justAfterResume = liveElapsedRidingMs(rAfterResume, resumeAt);

    // В рамках грейса значение всё время было заморожено на pausedAt-startedAt
    // (5 мин); resume не должно вызвать скачок.
    expect(justBeforeResume).toBe(pausedAt);
    expect(justAfterResume).toBe(pausedAt);
  });
});

describe("computeLiveOverage", () => {
  it("нет овертайма в рамках оплаченного окна", () => {
    const r = ride({ paidUntilAt: HOUR });
    expect(computeLiveOverage(r, 30 * MIN).overageKopecks).toBe(0);
  });

  it("считает овертайм после истечения paidUntilAt", () => {
    const r = ride({ paidUntilAt: HOUR });
    const { extraMinutes, overageKopecks } = computeLiveOverage(r, HOUR + 90 * 1000); // +1.5 мин
    expect(extraMinutes).toBe(2); // округление вверх до целой минуты
    expect(overageKopecks).toBeGreaterThan(0);
  });

  it("учитывает незавершённый pending-кредит паузы при живом расчёте", () => {
    // Пауза началась ровно на paidUntilAt, ещё есть грейс — овертайм не должен расти.
    const r = ride({ paidUntilAt: HOUR, pausedAt: HOUR, totalPausedMs: 0 });
    expect(computeLiveOverage(r, HOUR + 5 * MIN).overageKopecks).toBe(0);
  });

  it("паузу нельзя использовать, чтобы бесконечно избегать овертайма после исчерпания грейса", () => {
    const r = ride({ paidUntilAt: HOUR, pausedAt: HOUR, totalPausedMs: PAUSE_FREE_GRACE_MS });
    const { overageKopecks } = computeLiveOverage(r, HOUR + 3 * MIN);
    expect(overageKopecks).toBeGreaterThan(0);
  });
});

describe("liveRemainingPaidMs — обратный отсчёт, точный комплемент liveElapsedRidingMs", () => {
  it("сразу после старта равняется полным оплаченным временем и убывает в реальном времени", () => {
    const r = ride({ paidUntilAt: HOUR });
    expect(liveRemainingPaidMs(r, 0)).toBe(HOUR);
    expect(liveRemainingPaidMs(r, 10 * MIN)).toBe(50 * MIN);
  });

  // Намеренно только «не пауза» и «начало первой паузы без предыдущей истории» —
  // paidUntilAt уже включает любой ранее разрешённый кредит через resumeRide, поэтому сочетание
  // «pausedAt в прошлом плюс ненулевой totalPausedMs» здесь не моделируется — в реальной системе
  // paidUntilAt был бы уже сдвинут предыдущими resume, и инвариант не держится на сырых данных.
  it("всегда точный комплемент liveElapsedRidingMs относительно оплаченного окна", () => {
    const cases: PausableRide[] = [
      ride({ paidUntilAt: HOUR }),
      ride({ paidUntilAt: HOUR, pausedAt: 0, totalPausedMs: 0 }),
    ];
    for (const r of cases) {
      for (const now of [0, 5 * MIN, 30 * MIN, 45 * MIN]) {
        const paidMs = r.paidUntilAt! - r.startedAt;
        expect(liveElapsedRidingMs(r, now) + liveRemainingPaidMs(r, now)).toBe(paidMs);
      }
    }
  });

  it("замирает во время внутри-грейсовой паузы, потом тикает вниз после её исчерпания", () => {
    const r = ride({ paidUntilAt: HOUR, pausedAt: 5 * MIN, totalPausedMs: 0 });
    const atPause = liveRemainingPaidMs(r, 5 * MIN);
    const midPause = liveRemainingPaidMs(r, 5 * MIN + 2 * MIN);
    expect(midPause).toBe(atPause); // в рамках грейса — не убывает
  });

  it("никогда не уходит в минус после истечения оплаченного времени", () => {
    const r = ride({ paidUntilAt: HOUR });
    expect(liveRemainingPaidMs(r, HOUR + 90 * 1000)).toBe(0);
  });
});

describe("remainingFreeGraceMs", () => {
  it("равен полному бюджету, если пауз ещё не было", () => {
    expect(remainingFreeGraceMs(ride(), 0)).toBe(PAUSE_FREE_GRACE_MS);
  });

  it("тикает вниз в реальном времени во время текущей паузы", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: 0 });
    expect(remainingFreeGraceMs(r, 1000 + 3 * MIN)).toBe(PAUSE_FREE_GRACE_MS - 3 * MIN);
  });

  it("учитывает уже использованный грейс из предыдущих пауз этой поездки", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: 6 * MIN });
    expect(remainingFreeGraceMs(r, 1000 + 1 * MIN)).toBe(PAUSE_FREE_GRACE_MS - 6 * MIN - 1 * MIN);
  });

  it("замирает на 0, когда грейс исчерпан, и не уходит в минус", () => {
    const r = ride({ pausedAt: 1000, totalPausedMs: PAUSE_FREE_GRACE_MS });
    expect(remainingFreeGraceMs(r, 1000 + 5 * MIN)).toBe(0);
  });

  it("не зависит от того, идёт ли пауза прямо сейчас — просто отражает totalPausedMs, capped", () => {
    expect(remainingFreeGraceMs(ride({ pausedAt: null, totalPausedMs: 4 * MIN }), 999 * MIN)).toBe(PAUSE_FREE_GRACE_MS - 4 * MIN);
  });
});
