import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/AnalyticsPage.tsx"), "utf8");
const normalized = source.replace(/\s+/g, " ");

describe("AnalyticsPage feedback-by-rating table", () => {
  it("declares feedbackCounts on the admin analytics payload type", () => {
    expect(source).toContain("feedbackCounts: { r1: number; r2: number; r3: number; r4: number; r5: number };");
  });

  it("renders exactly five rows: 1, 2, 3, 4, and 5 stars", () => {
    expect(source).toContain('data-testid="analytics-feedback-1"');
    expect(source).toContain('data-testid="analytics-feedback-2"');
    expect(source).toContain('data-testid="analytics-feedback-3"');
    expect(source).toContain('data-testid="analytics-feedback-4"');
    expect(source).toContain('data-testid="analytics-feedback-5"');
    expect(normalized).toContain("1 звезда");
    expect(normalized).toContain("2 звезды");
    expect(normalized).toContain("3 звезды");
    expect(normalized).toContain("4 звезды");
    expect(normalized).toContain("5 звёзд");
  });

  it("shows each rating's feedback count", () => {
    expect(source).toContain("{a.feedbackCounts.r1}");
    expect(source).toContain("{a.feedbackCounts.r2}");
    expect(source).toContain("{a.feedbackCounts.r3}");
    expect(source).toContain("{a.feedbackCounts.r4}");
    expect(source).toContain("{a.feedbackCounts.r5}");
  });
});
