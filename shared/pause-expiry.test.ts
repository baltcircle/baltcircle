import { describe, it, expect } from "vitest";
import { PAUSE_FREE_GRACE_MS } from "./geo";
import {
  nextPauseNotice, effectivePauseMask, pauseNoticeTag,
  PAUSE_BIT_WARN_2MIN, PAUSE_BIT_GRACE_ENDED, PAUSE_WARN_MS,
  type PauseCandidate,
} from "./pause-expiry";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function ride(over: Partial<PauseCandidate> = {}): PauseCandidate {
  return {
    startedAt: T0,
    paidUntilAt: T0 + 60 * MIN,
    pausedAt: null,
    totalPausedMs: 0,
    pauseNotifiedMask: 0,
    pauseNotifiedFor: null,
    ...over,
  };
}

describe("nextPauseNotice", () => {
  it("молчит, пока поездка не на паузе", () => {
    expect(nextPauseNotice(ride(), "BC-014", T0 + 5 * MIN)).toBeNull();
  });

  it("молчит в начале паузы, пока бюджета много", () => {
    const r = ride({ pausedAt: T0 });
    expect(nextPauseNotice(r, "BC-014", T0 + 1 * MIN)).toBeNull();
  });

  it("предупреждает ровно за 2 минуты до конца бюджета", () => {
    const r = ride({ pausedAt: T0 });
    const at = T0 + PAUSE_FREE_GRACE_MS - PAUSE_WARN_MS;
    const notice = nextPauseNotice(r, "BC-014", at);
    expect(notice?.stage).toBe("warn2");
    expect(notice?.title).toBe("Пауза: осталось 2 мин.");
    expect(notice?.body).toContain("BC-014");
  });

  it("сообщает об исчерпании бюджета", () => {
    const r = ride({ pausedAt: T0 });
    const notice = nextPauseNotice(r, "BC-014", T0 + PAUSE_FREE_GRACE_MS);
    expect(notice?.stage).toBe("graceEnded");
    expect(notice?.title).toBe("Пауза: бесплатное время истекло");
  });

  it("не шлёт «осталось 2 мин.» задним числом, если проспали порог", () => {
    // Сервер простоял, бюджет кончился между тиками: летит только итоговое
    // уведомление, но бит предупреждения всё равно гасится.
    const r = ride({ pausedAt: T0 });
    const notice = nextPauseNotice(r, "BC-014", T0 + PAUSE_FREE_GRACE_MS + 5 * MIN);
    expect(notice?.stage).toBe("graceEnded");
    expect(notice?.nextMask).toBe(PAUSE_BIT_WARN_2MIN | PAUSE_BIT_GRACE_ENDED);
  });

  it("не повторяет уже отправленное предупреждение", () => {
    const r = ride({
      pausedAt: T0,
      pauseNotifiedFor: T0,
      pauseNotifiedMask: PAUSE_BIT_WARN_2MIN,
    });
    const at = T0 + PAUSE_FREE_GRACE_MS - MIN;
    expect(nextPauseNotice(r, "BC-014", at)).toBeNull();
  });

  it("после предупреждения всё равно сообщает об исчерпании", () => {
    const r = ride({
      pausedAt: T0,
      pauseNotifiedFor: T0,
      pauseNotifiedMask: PAUSE_BIT_WARN_2MIN,
    });
    const notice = nextPauseNotice(r, "BC-014", T0 + PAUSE_FREE_GRACE_MS);
    expect(notice?.stage).toBe("graceEnded");
    expect(notice?.nextMask).toBe(PAUSE_BIT_WARN_2MIN | PAUSE_BIT_GRACE_ENDED);
  });

  it("учитывает бюджет, потраченный на прошлых паузах", () => {
    // 9 из 10 минут уже израсходованы: предупреждение положено сразу, а не
    // через 8 минут, как было бы при отсчёте от начала этой паузы.
    const r = ride({ pausedAt: T0 + 30 * MIN, totalPausedMs: 9 * MIN });
    const notice = nextPauseNotice(r, "BC-014", T0 + 30 * MIN);
    expect(notice?.stage).toBe("warn2");
    expect(notice?.title).toBe("Пауза: осталось 1 мин.");
  });

  it("молчит, если бюджет был исчерпан ещё до этой паузы", () => {
    // Райдер уже получил «бесплатное время истекло» на прошлой остановке —
    // повторять это на каждой следующей значит превратить пуши в шум.
    const r = ride({ pausedAt: T0 + 30 * MIN, totalPausedMs: PAUSE_FREE_GRACE_MS });
    expect(nextPauseNotice(r, "BC-014", T0 + 31 * MIN)).toBeNull();
  });

  it("новая пауза не наследует маску прошлой", () => {
    // Маска записана для другого pausedAt — вторая пауза должна снова
    // предупредить, если бюджет ещё остался.
    const r = ride({
      pausedAt: T0 + 30 * MIN,
      totalPausedMs: 8 * MIN,
      pauseNotifiedFor: T0,
      pauseNotifiedMask: PAUSE_BIT_WARN_2MIN | PAUSE_BIT_GRACE_ENDED,
    });
    expect(effectivePauseMask(r)).toBe(0);
    expect(nextPauseNotice(r, "BC-014", T0 + 30 * MIN)?.stage).toBe("warn2");
  });

  it("проходит полный цикл паузы ровно двумя уведомлениями", () => {
    let r = ride({ pausedAt: T0 });
    const stages: string[] = [];
    for (let i = 0; i <= 15; i++) {
      const at = T0 + i * MIN;
      const notice = nextPauseNotice(r, "BC-014", at);
      if (!notice) continue;
      stages.push(notice.stage);
      r = { ...r, pauseNotifiedMask: notice.nextMask, pauseNotifiedFor: r.pausedAt };
    }
    expect(stages).toEqual(["warn2", "graceEnded"]);
  });
});

describe("pauseNoticeTag", () => {
  it("уникален на поездку", () => {
    expect(pauseNoticeTag(1)).not.toBe(pauseNoticeTag(2));
  });

  it("не пересекается с тегом дедлайна аренды", () => {
    // Иначе «Пауза» затирала бы «Аренда: осталось 5 мин.» — это разные темы.
    expect(pauseNoticeTag(1)).not.toBe("ride:1:expiry");
  });
});
