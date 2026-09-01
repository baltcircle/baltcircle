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
