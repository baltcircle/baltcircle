// Post-ride feedback: 1-5 star rating, followed by a reason pool that depends
// on the rating tier — mirrors the pattern used by Wush/Bolt/Yandex Go-style
// bikesharing apps: 1-3★ shows a "what went wrong" pool with two categories
// (Велосипед / Приложение) that expand into specific sub-reasons on tap, 4★
// shows a flat "what could be better" pool, 5★ shows a flat "what you liked"
// pool. Shared between client (renders the pool) and server (validates
// submitted reason ids actually belong to the pool for the submitted rating —
// see shared/schema.ts's createRideFeedbackSchema / server storage.submitRideFeedback).
export type FeedbackTier = "low" | "mid" | "high";

export function feedbackTierForRating(rating: number): FeedbackTier {
  if (rating <= 3) return "low";
  if (rating === 4) return "mid";
  return "high";
}

export interface FeedbackReasonOption {
  id: string;
  label: string;
  // Present only for top-level categories that expand into a more specific
  // sub-reason pool once tapped (currently only the low tier's "Велосипед"
  // and "Приложение"). Selecting the parent alone (no sub-reason chosen) is
  // a valid, submittable answer — sub-reasons just add detail on top of it.
  subReasons?: FeedbackReasonOption[];
}

export const FEEDBACK_TIER_TITLES: Record<FeedbackTier, string> = {
  low: "Что пошло не так?",
  mid: "Что можно улучшить?",
  high: "Что понравилось?",
};

export const FEEDBACK_REASONS: Record<FeedbackTier, FeedbackReasonOption[]> = {
  low: [
    {
      id: "bike",
      label: "Велосипед",
      subReasons: [
        { id: "bike_brakes", label: "Тормоза плохо работают" },
        { id: "bike_handlebar_seat", label: "Руль/сидушка разболтаны" },
        { id: "bike_wheel_deformed", label: "Колесо деформировано" },
        { id: "bike_bell_holder", label: "Звонок/ Держатель для телефона не работает" },
        { id: "bike_chain", label: "Цепь слетала/скрипела" },
        { id: "bike_lock", label: "Трудности с замком" },
      ],
    },
    {
      id: "app",
      label: "Приложение",
      subReasons: [
        { id: "app_inconvenient", label: "Неудобное приложение" },
        { id: "app_slow", label: "Долго грузило" },
        { id: "app_payment", label: "Проблема с оплатой" },
      ],
    },
    { id: "no_parking", label: "Парковки нет в удобном месте" },
    { id: "other", label: "Другое" },
  ],
  mid: [
    { id: "bike_comfort", label: "Комфорт велосипедов" },
    { id: "app_experience", label: "Работу приложения" },
    { id: "parking_count", label: "Количество парковок" },
    { id: "other", label: "Другое" },
  ],
  high: [
    { id: "great_bikes", label: "Классные велосипеды" },
    { id: "convenient_app", label: "Удобное приложение" },
    { id: "parking_location", label: "Расположение парковок" },
    { id: "other", label: "Другое" },
  ],
};

function flattenIds(options: FeedbackReasonOption[]): string[] {
  return options.flatMap((o) => [o.id, ...(o.subReasons ? flattenIds(o.subReasons) : [])]);
}

// Flattened (parent + sub-reason) id pool per tier — used server-side to
// validate that every submitted id actually belongs to the submitted
// rating's tier, regardless of nesting depth.
export const FEEDBACK_REASON_IDS: Record<FeedbackTier, readonly string[]> = {
  low: flattenIds(FEEDBACK_REASONS.low),
  mid: flattenIds(FEEDBACK_REASONS.mid),
  high: flattenIds(FEEDBACK_REASONS.high),
};
