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

describe("AnalyticsPage layout", () => {
  it("centers the title with no separate eyebrow label above it", () => {
    expect(source).not.toContain("\u041e\u043f\u0435\u0440\u0430\u0446\u0438\u043e\u043d\u043d\u044b\u0439 \u0446\u0435\u043d\u0442\u0440");
    expect(source).toContain('font-display text-2xl lg:text-3xl font-light text-center">\u0410\u043d\u0430\u043b\u0438\u0442\u0438\u043a\u0430');
  });

  it("drops the \u041e\u0442\u043a\u0440\u044b\u0442\u044b\u0445 \u0437\u0430\u044f\u0432\u043e\u043a and \u0410\u043a\u0442\u0438\u0432\u043d\u044b\u0445 \u043f\u043e\u0435\u0437\u0434\u043e\u043a KPI cards", () => {
    expect(source).not.toContain("analytics-kpi-open-tickets");
    expect(source).not.toContain("analytics-kpi-active-rides");
  });

  it("places \u041e\u0442\u0437\u044b\u0432\u044b \u043e \u043f\u043e\u0435\u0437\u0434\u043a\u0430\u0445 and \u041f\u0430\u0440\u043a\u043e\u0432\u043a\u0438 side by side in a two-column grid", () => {
    const feedbackIdx = source.indexOf('data-testid="analytics-feedback"');
    const parkingIdx = source.indexOf('data-testid="analytics-parking"');
    const gridIdx = source.lastIndexOf('grid md:grid-cols-2 gap-6 mb-6', feedbackIdx);
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(parkingIdx).toBeGreaterThan(feedbackIdx);
    expect(gridIdx).toBeGreaterThan(-1);
  });

  it("renders \u041f\u043e\u0432\u0442\u043e\u0440\u044f\u044e\u0449\u0438\u0435\u0441\u044f \u043f\u0440\u043e\u0431\u043b\u0435\u043c\u044b as the last card on the page", () => {
    const repeatedIdx = source.indexOf('data-testid="analytics-repeated-bikes"');
    const parkingIdx = source.indexOf('data-testid="analytics-parking"');
    expect(repeatedIdx).toBeGreaterThan(parkingIdx);
  });
});
