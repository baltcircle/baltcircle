// Предупреждения об окончании оплаченного окна аренды.
//
// Чистая логика «какое уведомление (если вообще) положено этой поездке прямо
// сейчас» — вынесена из storage, чтобы её можно было проверить тестами без БД
// и push-инфраструктуры.
//
// Пороги считаются от effectivePaidUntilAt (shared/pause.ts), а не от сырого
// paidUntilAt: во время паузы внутри бесплатного грейса дедлайн реально
// сдвигается, и предупреждать по сырому значению значило бы врать райдеру.

import { effectivePaidUntilAt, type PausableRide } from "./pause";

/** Биты expiryNotifiedMask. */
export const EXPIRY_BIT_10MIN = 1;
export const EXPIRY_BIT_5MIN = 2;
export const EXPIRY_BIT_OVERTIME = 4;

export const EXPIRY_WARN_10MIN_MS = 10 * 60 * 1000;
export const EXPIRY_WARN_5MIN_MS = 5 * 60 * 1000;

export type ExpiryStage = "warn10" | "warn5" | "overtime";

/**
 * Тег push-уведомлений о дедлайне поездки. Общий для всех трёх стадий (за 10
 * минут, за 5 минут, овертайм) и уникальный на поездку: свежее предупреждение
 * заменяет предыдущее в шторке, но две одновременные аренды на разных
 * велосипедах не затирают друг друга.
 *
 * Формат живёт в shared, потому что тег нужен обеим сторонам: сервер им
 * помечает push, клиент по нему снимает карточку, которая перестала быть
 * правдой. Тег, известный только одной стороне, — это «Начался овертайм»,
 * висящий на экране блокировки после завершённой поездки.
 */
export function rideExpiryTag(rideId: number): string {
  return `ride:${rideId}:expiry`;
}

export interface ExpiryNotice {
  stage: ExpiryStage;
  bit: number;
  /**
   * Маска, которую надо записать после отправки. Включает все пороги строго
   * «выше» текущего: если сервер простоял 20 минут и поездка сразу оказалась в
   * овертайме, предупреждения «10 минут» и «5 минут» задним числом не летят,
   * но и не остаются висеть как неотправленные.
   */
  nextMask: number;
  title: string;
  body: string;
}

/** Поездка в объёме, нужном для расчёта предупреждений. */
export interface ExpiryCandidate extends PausableRide {
  paidUntilAt: number | null;
  expiryNotifiedMask: number;
  expiryNotifiedFor: number | null;
}

/**
 * Маска, актуальная для ТЕКУЩЕГО значения paidUntilAt. Если дедлайн сдвинули
 * (продление аренды, зачёт паузы), прошлая маска относится к другому окну и
 * считается нулевой — продлённая поездка снова получит все предупреждения.
 */
export function effectiveMask(ride: ExpiryCandidate): number {
  if (ride.paidUntilAt == null) return 0;
  if (ride.expiryNotifiedFor !== ride.paidUntilAt) return 0;
  return ride.expiryNotifiedMask;
}

function texts(stage: ExpiryStage, bikeId: string): { title: string; body: string } {
  switch (stage) {
    case "warn10":
      return {
        title: "Аренда заканчивается через 10 минут",
        body: `Велосипед ${bikeId}: скоро закончится оплаченное время. Продлите аренду или завершите поездку на парковке.`,
      };
    case "warn5":
      return {
        title: "Аренда заканчивается через 5 минут",
        body: `Велосипед ${bikeId}: осталось 5 минут оплаченного времени. Продлите аренду или завершите поездку на парковке.`,
      };
    case "overtime":
      return {
        title: "Начался овертайм",
        body: `Велосипед ${bikeId}: оплаченное время закончилось, включилась поминутная тарификация. Завершите поездку или продлите аренду.`,
      };
  }
}

/**
 * Что отправить этой поездке сейчас, или null — если ничего.
 *
 * За один проход отправляется максимум одно уведомление: sweep ходит раз в
 * минуту, поэтому пороги 10 и 5 минут естественно попадают в разные проходы.
 */
export function nextExpiryNotice(
  ride: ExpiryCandidate,
  bikeId: string,
  now: number,
): ExpiryNotice | null {
  if (ride.paidUntilAt == null) return null;

  const remainingMs = effectivePaidUntilAt(ride, now) - now;
  // Длина оплаченного окна: для минутных тарифов предупреждение «за 10 минут»
  // бессмысленно — оно прилетело бы сразу после старта аренды.
  const windowMs = ride.paidUntilAt - ride.startedAt;
  const mask = effectiveMask(ride);

  let stage: ExpiryStage | null = null;
  let bit = 0;
  let nextMask = 0;

  if (remainingMs <= 0) {
    stage = "overtime";
    bit = EXPIRY_BIT_OVERTIME;
    nextMask = EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN | EXPIRY_BIT_OVERTIME;
  } else if (remainingMs <= EXPIRY_WARN_5MIN_MS && windowMs > EXPIRY_WARN_5MIN_MS) {
    stage = "warn5";
    bit = EXPIRY_BIT_5MIN;
    nextMask = EXPIRY_BIT_10MIN | EXPIRY_BIT_5MIN;
  } else if (remainingMs <= EXPIRY_WARN_10MIN_MS && windowMs > EXPIRY_WARN_10MIN_MS) {
    stage = "warn10";
    bit = EXPIRY_BIT_10MIN;
    nextMask = EXPIRY_BIT_10MIN;
  }

  if (stage === null || (mask & bit) !== 0) return null;

  return { stage, bit, nextMask: mask | nextMask, ...texts(stage, bikeId) };
}
