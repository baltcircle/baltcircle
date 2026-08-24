// Post-ride feedback: 1-5 star rating, followed by a reason pool that depends
// on the rating tier — mirrors the pattern used by Wush/Bolt-style
// bikesharing apps: 1-3★ shows a "what went wrong" pool, 4★ shows a "what
// could be better" pool, 5★ shows a "what you liked" pool. Shared between
// client (renders the pool) and server (validates submitted reason ids
// actually belong to the pool for the submitted rating — see
// shared/schema.ts's createRideFeedbackSchema / server storage.submitRideFeedback).
export type FeedbackTier = "low" | "mid" | "high";

export function feedbackTierForRating(rating: number): FeedbackTier {
  if (rating <= 3) return "low";
  if (rating === 4) return "mid";
  return "high";
}

export interface FeedbackReasonOption {
  id: string;
  label: string;
}

export const FEEDBACK_TIER_TITLES: Record<FeedbackTier, string> = {
  low: "Что пошло не так?",
  mid: "Что можно улучшить?",
  high: "Что понравилось?",
};

export const FEEDBACK_REASONS: Record<FeedbackTier, FeedbackReasonOption[]> = {
  low: [
    { id: "dirty", label: "Велосипед был грязный" },
    { id: "brakes", label: "Плохо работали тормоза" },
    { id: "chain", label: "Слетала или скрипела цепь" },
    { id: "handlebar_saddle", label: "Разболтан руль или седло" },
    { id: "wheel_flat", label: "Спущенное колесо / прокол" },
    { id: "lock_issue", label: "Проблема с замком велосипеда" },
    { id: "hard_to_find", label: "Долго искал велосипед" },
    { id: "gps_inaccurate", label: "Неточный трек поездки" },
    { id: "billing_issue", label: "Некорректно списали деньги" },
    { id: "app_bug", label: "Ошибка в приложении" },
    { id: "other", label: "Другое" },
  ],
  mid: [
    { id: "not_fully_clean", label: "Велосипед был не совсем чистый" },
    { id: "slow_lock", label: "Долго открывался или закрывался замок" },
    { id: "hard_parking", label: "Сложно найти место для парковки" },
    { id: "price_high", label: "Цена показалась высокой" },
    { id: "minor_app_issue", label: "Небольшие неудобства в приложении" },
    { id: "route", label: "Неудобный маршрут" },
    { id: "other", label: "Другое" },
  ],
  high: [
    { id: "comfortable_bike", label: "Удобный и исправный велосипед" },
    { id: "easy_app", label: "Приложением легко пользоваться" },
    { id: "fast_start", label: "Быстрый старт поездки" },
    { id: "good_parking", label: "Удобная парковка рядом" },
    { id: "good_price", label: "Хорошая цена" },
    { id: "support", label: "Отличная поддержка" },
    { id: "other", label: "Другое" },
  ],
};

export const FEEDBACK_REASON_IDS: Record<FeedbackTier, readonly string[]> = {
  low: FEEDBACK_REASONS.low.map((r) => r.id),
  mid: FEEDBACK_REASONS.mid.map((r) => r.id),
  high: FEEDBACK_REASONS.high.map((r) => r.id),
};
