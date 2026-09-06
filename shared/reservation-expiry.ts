// Уведомления по брони: предупреждение перед истечением и факт аннулирования.
//
// Бронь живёт RESERVATION_TTL_MS (10 минут) и не продлевается, поэтому здесь
// нет «notifiedFor»-проверки как у поездки: expiresAt не двигается, маска не
// может протухнуть.

/** Биты reservations.notifiedMask. */
export const RESERVATION_BIT_WARN_2MIN = 1;

/** За сколько до конца брони предупреждаем. */
export const RESERVATION_WARN_MS = 2 * 60 * 1000;

export interface ReservationNotice {
  bit: number;
  nextMask: number;
  title: string;
  body: string;
}

/**
 * Тег push-уведомлений по брони. Уникален на бронь, поэтому предупреждение и
 * последующее «бронь отменена» заменяют друг друга, а брони на разные
 * велосипеды остаются отдельными карточками.
 */
export function reservationTag(reservationId: number): string {
  return `reservation:${reservationId}`;
}

export interface ReservationCandidate {
  expiresAt: number;
  notifiedMask: number;
}

/**
 * Предупреждение «бронь скоро истечёт», или null — если рано либо уже слали.
 */
export function nextReservationNotice(
  reservation: ReservationCandidate,
  bikeId: string,
  now: number,
): ReservationNotice | null {
  const remainingMs = reservation.expiresAt - now;
  if (remainingMs > RESERVATION_WARN_MS) return null;
  if ((reservation.notifiedMask & RESERVATION_BIT_WARN_2MIN) !== 0) return null;
  // Бронь уже истекла — этим займётся sweep аннулирования, а не предупреждение.
  if (remainingMs <= 0) return null;

  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return {
    bit: RESERVATION_BIT_WARN_2MIN,
    nextMask: reservation.notifiedMask | RESERVATION_BIT_WARN_2MIN,
    title: `Бронь: осталось ${minutes} мин.`,
    body: `${bikeId} — начните аренду, иначе бронь снимется и велосипед освободится.`,
  };
}

/** Текст уведомления об аннулировании брони по истечении срока. */
export function reservationExpiredTexts(bikeId: string): { title: string; body: string } {
  return {
    title: "Бронь отменена",
    body: `${bikeId} — время брони вышло, велосипед снова доступен всем.`,
  };
}
