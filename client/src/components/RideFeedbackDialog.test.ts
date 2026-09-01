import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/components/RideFeedbackDialog.tsx"), "utf8");

describe("RideFeedbackDialog category/sub-reason UI", () => {
  it("renders top-level category chips and expands sub-reason chips beneath a selected category", () => {
    expect(source).toContain("FEEDBACK_REASONS[tier].map((opt) =>");
    expect(source).toContain("if (!opt.subReasons || !reasons.includes(opt.id)) return null;");
    expect(source).toContain("opt.subReasons.map((sub) =>");
  });

  it("keeps the submit button enabled once a rating is picked, regardless of reason selection", () => {
    // Submission must be allowed with just a top-level category selected
    // (or even none) — the button only gates on `tier` (derived from
    // `rating`), never on `reasons.length`.
    expect(source).toMatch(/\{tier \? \(\s*<Button[\s\S]{0,150}disabled=\{submitMut\.isPending\}/);
  });
});

describe("RideFeedbackDialog reason state resets", () => {
  it("clears reasons when a star tap crosses into a different rating tier", () => {
    // Regression: switching e.g. 3★ (low) → 4★ (mid) after picking reasons
    // left stale low-tier ids in `reasons`; the server then rejected the
    // whole submission with "Некорректная причина отзыва" since those ids
    // aren't valid for the submitted rating's tier (see server/storage/feedback.ts).
    expect(source).toContain("const handleRatingSelect = (n: number) => {");
    expect(source).toContain("if (rating > 0 && feedbackTierForRating(rating) !== feedbackTierForRating(n)) {");
    expect(source).toContain("setReasons([]);");
    expect(source).toContain("onClick={() => handleRatingSelect(n)}");
  });

  it("clears a category's sub-reason ids together with the category itself", () => {
    // Regression: unchecking a category (e.g. "Велосипед") hid its sub-reason
    // panel but left previously picked sub-reason ids (e.g. "bike_brakes")
    // selected and invisible, so re-opening the category silently restored
    // old picks instead of starting clean.
    expect(source).toContain("const toggleParentReason = (opt: FeedbackReasonOption) => {");
    expect(source).toContain("const subIds = new Set(opt.subReasons?.map((s) => s.id) ?? []);");
    expect(source).toContain("return prev.filter((r) => r !== opt.id && !subIds.has(r));");
    expect(source).toContain("onClick={() => toggleParentReason(opt)}");
  });

  it("applies touch-manipulation to rating and reason chips to avoid iOS ghost-click double toggles", () => {
    expect(source.match(/touch-manipulation/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
