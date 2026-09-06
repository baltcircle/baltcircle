// Предупреждения об исчерпании бесплатной паузы.
//
// Бесплатный грейс (PAUSE_FREE_GRACE_MS) — кумулятивный на всю поездку, а не
// на одну паузу: райдер может встать пять раз по две минуты. Поэтому «сколько
// осталось» считается через remainingFreeGraceMs (shared/pause.ts), а не
// вычитанием из pausedAt — иначе вторая пауза обещала бы полный бюджет заново.
//
// Тот же приём, что и в ride-expiry: чистая логика без БД и push, чтобы её
// можно было прогнать тестами по минутным шагам.

import { PAUSE_FREE_GRACE_MS } from "./geo";
import { remainingFreeGraceMs, type PausableRide } from "./pause";

/** Биты pauseNotifiedMask. */
export const PAUSE_BIT_WARN_2MIN = 1;
export const PAUSE_BIT_GRACE_ENDED = 2;

/** За сколько до конца бесплатного бюджета предупреждаем. */
export const PAUSE_WARN_MS = 2 * 60 * 1000;

export type PauseStage = "warn2" | "graceEnded";

export interface PauseNotice {
  stage: PauseStage;
  bit: number;
  nextMask: number;
  title: string;
  body: string;
}

/** Поездка в объёме, нужном для расчёта предупреждений о паузе. */
export interface PauseCandidate extends PausableRide {
  pauseNotifiedMask: number;
  pauseNotifiedFor: number | null;
}

/**
 * Тег push-уведомлений о паузе. Один на поездку и общий для обеих стадий:
 * «осталось 2 мин.» заменяется на «бесплатное время истекло», а не копится.
 */
export function pauseNoticeTag(rideId: number): string {
  return `ride:${rideId}:pause`;
}

/**
 * Маска, актуальная для ТЕКУЩЕЙ паузы. Каждая новая пауза (другой pausedAt) —
 * новое событие: райдер, вставший второй раз, должен снова получить
 * предупреждение, если бюджет ещё не кончился.
 */
export function effectivePauseMask(ride: PauseCandidate): number {
  if (ride.pausedAt == null) return 0;
  if (ride.pauseNotifiedFor !== ride.pausedAt) return 0;
  return ride.pauseNotifiedMask;
}

function texts(stage: PauseStage, bikeId: string, remainingMs: number): { title: string; body: string } {
  if (stage === "warn2") {
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    return {
      title: `Пауза: осталось ${minutes} мин.`,
      body: `${bikeId} — дальше пауза платная по тарифу аренды.`,
    };
  }
  return {
    title: "Пауза: бесплатное время истекло",
    body: `${bikeId} — оплаченное время снова идёт. Продолжите поездку или завершите её на парковке.`,
  };
}

/**
 * Что отправить по текущей паузе прямо сейчас, или null — если ничего.
 *
 * За один проход максимум одно уведомление: sweep ходит раз в минуту, и порог
 * «2 минуты» естественно попадает в проход раньше, чем исчерпание бюджета.
 */
export function nextPauseNotice(
  ride: PauseCandidate,
  bikeId: string,
  now: number,
): PauseNotice | null {
  if (ride.pausedAt == null) return null;

  // Бюджет был исчерпан ещё ДО этой паузы — предупреждать не о чем: райдер уже
  // получил «бесплатное время истекло» на прошлой паузе, и повторять это на
  // каждой следующей остановке значит превратить уведомления в шум.
  if (Math.max(0, ride.totalPausedMs) >= PAUSE_FREE_GRACE_MS) return null;

  const remainingMs = remainingFreeGraceMs(ride, now);
  const mask = effectivePauseMask(ride);

  let stage: PauseStage | null = null;
  let bit = 0;
  let nextMask = 0;

  if (remainingMs <= 0) {
    stage = "graceEnded";
    bit = PAUSE_BIT_GRACE_ENDED;
    // Бюджет мог кончиться между проходами sweep — «осталось 2 минуты» задним
    // числом не летит, но и не остаётся висеть неотправленным.
    nextMask = PAUSE_BIT_WARN_2MIN | PAUSE_BIT_GRACE_ENDED;
  } else if (remainingMs <= PAUSE_WARN_MS) {
    stage = "warn2";
    bit = PAUSE_BIT_WARN_2MIN;
    nextMask = PAUSE_BIT_WARN_2MIN;
  }

  if (stage === null || (mask & bit) !== 0) return null;

  return { stage, bit, nextMask: mask | nextMask, ...texts(stage, bikeId, remainingMs) };
}
