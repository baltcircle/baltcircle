import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/FeedbackAdminPage.tsx"), "utf8");
const rowSource = readFileSync(resolve(process.cwd(), "client/src/pages/feedback-admin/FeedbackRow.tsx"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "client/src/App.tsx"), "utf8");
const shellSource = readFileSync(resolve(process.cwd(), "client/src/components/AppShell.tsx"), "utf8");

describe("FeedbackAdminPage", () => {
  it("fetches from the admin feedback endpoint", () => {
    expect(source).toContain('"/api/admin/feedback"');
  });

  it("sorts by date, toggled from the \u0414\u0430\u0442\u0430 header", () => {
    expect(source).toContain('setDateDir((d) => (d === "asc" ? "desc" : "asc"))');
    expect(source).toContain("(a.createdAt - b.createdAt) * dir");
  });

  it("shows an empty state distinguishing no-data from no-search-results", () => {
    expect(source).toContain("\u041e\u0442\u0437\u044b\u0432\u043e\u0432 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.");
    expect(source).toContain("\u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u043e \u043f\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u0443.");
  });

  it("paginates client-side over the fetched list", () => {
    expect(source).toContain("useClientPagination(sorted)");
    expect(source).toContain("<TablePager");
  });

  it("filters by \u041f\u0443\u043d\u043a\u0442\u044b and \u041e\u0446\u0435\u043d\u043a\u0430 via Selects embedded in the column headers, like the Maintenance status filter", () => {
    expect(source).toContain('testId="select-feedback-category"');
    expect(source).toContain('allLabel="\u0412\u0441\u0435 \u043f\u0443\u043d\u043a\u0442\u044b"');
    expect(source).toContain("categoryOptions.map");
    expect(source).toContain("labels.includes(categoryFilter)");
    expect(source).toContain('testId="select-feedback-rating"');
    expect(source).toContain('allLabel="\u0412\u0441\u0435 \u043e\u0446\u0435\u043d\u043a\u0438"');
    expect(source).toContain("String(f.rating) !== ratingFilter");
    expect(source).toContain("function FilterSelectHead");
    expect(source).toContain("data-testid={testId}");
  });
});

describe("FeedbackRowItem", () => {
  it("renders the comment when present, and a dash otherwise", () => {
    expect(rowSource).toContain("f.comment ? f.comment :");
  });

  it("renders the star rating and formatted category labels", () => {
    expect(rowSource).toContain("formatFeedbackReasons(f.rating, f.reasons)");
    expect(rowSource).toContain("from \"@shared/feedback\"");
  });

  it("shows only the rating digit, without a /5 suffix", () => {
    expect(rowSource).not.toContain("/5");
    expect(rowSource).toContain("{rating}</span>");
  });
});

describe("Reviews route registration", () => {
  it("registers /admin/reviews behind AdminGuard for operator/admin", () => {
    expect(appSource).toContain(
      '<Route path="/admin/reviews"><AdminGuard roles={["operator", "admin"]}><FeedbackAdminPage /></AdminGuard></Route>',
    );
  });

  it("lazy-loads FeedbackAdminPage like the other admin pages", () => {
    expect(appSource).toContain(
      'const FeedbackAdminPage = lazy(() => import("@/pages/FeedbackAdminPage").then((m) => ({ default: m.FeedbackAdminPage })));',
    );
  });

  it("adds a nav entry for staff (operator/admin)", () => {
    expect(shellSource).toContain('href: "/admin/reviews"');
    expect(shellSource).toContain('label: "\u041e\u0442\u0437\u044b\u0432\u044b"');
    expect(shellSource).toContain('roles: ["operator", "admin"]');
  });
});
