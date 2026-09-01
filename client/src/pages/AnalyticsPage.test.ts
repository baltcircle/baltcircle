import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/AnalyticsPage.tsx"), "utf8");
const normalized = source.replace(/\s+/g, " ");

describe("AnalyticsPage feedback-by-rating table", () => {
  it("declares feedbackCounts on the admin analytics payload type", () => {
    expect(source).toContain("feedbackCounts: { low: number; mid: number; high: number };");
  });

  it("renders exactly three rows: 1-3, 4, and 5 stars", () => {
    expect(source).toContain('data-testid="analytics-feedback-low"');
    expect(source).toContain('data-testid="analytics-feedback-mid"');
    expect(source).toContain('data-testid="analytics-feedback-high"');
    expect(normalized).toContain("1-3 звезды");
    expect(normalized).toContain("4 звезды");
    expect(normalized).toContain("5 звёзд");
  });

  it("shows each tier's feedback count", () => {
    expect(source).toContain("{a.feedbackCounts.low}");
    expect(source).toContain("{a.feedbackCounts.mid}");
    expect(source).toContain("{a.feedbackCounts.high}");
  });
});
