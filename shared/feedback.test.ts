import { describe, expect, it } from "vitest";
import {
  feedbackTierForRating,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_IDS,
} from "./feedback";

describe("feedbackTierForRating", () => {
  it.each([
    [1, "low"], [2, "low"], [3, "low"],
    [4, "mid"],
    [5, "high"],
  ] as const)("maps rating %i to tier %s", (rating, tier) => {
    expect(feedbackTierForRating(rating)).toBe(tier);
  });
});

describe("FEEDBACK_REASONS low tier", () => {
  const bike = FEEDBACK_REASONS.low.find((o) => o.id === "bike");
  const app = FEEDBACK_REASONS.low.find((o) => o.id === "app");

  it("has exactly the 4 top-level categories from the spec", () => {
    expect(FEEDBACK_REASONS.low.map((o) => o.id)).toEqual(["bike", "app", "no_parking", "other"]);
  });

  it("nests the 6 bike sub-reasons under the Велосипед category", () => {
    expect(bike?.subReasons?.map((s) => s.label)).toEqual([
      "Тормоза плохо работают",
      "Руль/сидушка разболтаны",
      "Колесо деформировано",
      "Звонок/ Держатель для телефона не работает",
      "Цепь слетала/скрипела",
      "Трудности с замком",
    ]);
  });

  it("nests the 3 app sub-reasons under the Приложение category", () => {
    expect(app?.subReasons?.map((s) => s.label)).toEqual([
      "Неудобное приложение",
      "Долго грузило",
      "Проблема с оплатой",
    ]);
  });

  it("leaves 'no_parking' and 'other' without sub-reasons", () => {
    expect(FEEDBACK_REASONS.low.find((o) => o.id === "no_parking")?.subReasons).toBeUndefined();
    expect(FEEDBACK_REASONS.low.find((o) => o.id === "other")?.subReasons).toBeUndefined();
  });
});

describe("FEEDBACK_REASONS mid/high tiers", () => {
  it("mid tier has 4 flat categories with no sub-reasons", () => {
    expect(FEEDBACK_REASONS.mid.map((o) => o.label)).toEqual([
      "Комфорт велосипедов",
      "Работу приложения",
      "Количество парковок",
      "Другое",
    ]);
    expect(FEEDBACK_REASONS.mid.every((o) => !o.subReasons)).toBe(true);
  });

  it("high tier has 4 flat categories with no sub-reasons", () => {
    expect(FEEDBACK_REASONS.high.map((o) => o.label)).toEqual([
      "Классные велосипеды",
      "Удобное приложение",
      "Расположение парковок",
      "Другое",
    ]);
    expect(FEEDBACK_REASONS.high.every((o) => !o.subReasons)).toBe(true);
  });
});

describe("FEEDBACK_REASON_IDS", () => {
  it("flattens low-tier ids to include both categories and their sub-reasons", () => {
    expect(FEEDBACK_REASON_IDS.low).toContain("bike");
    expect(FEEDBACK_REASON_IDS.low).toContain("bike_brakes");
    expect(FEEDBACK_REASON_IDS.low).toContain("app_payment");
    expect(FEEDBACK_REASON_IDS.low).toContain("no_parking");
    expect(FEEDBACK_REASON_IDS.low).toContain("other");
    expect(FEEDBACK_REASON_IDS.low.length).toBe(2 + 6 + 3 + 2); // bike+app parents + subs + no_parking + other
  });

  it("does not leak low-tier ids into the mid/high pools", () => {
    expect(FEEDBACK_REASON_IDS.mid).not.toContain("bike_brakes");
    expect(FEEDBACK_REASON_IDS.high).not.toContain("bike_brakes");
  });
});
