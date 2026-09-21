import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueryErrorNotice, RiderQueryErrorNotice } from "./QueryErrorNotice";

describe("rider query errors", () => {
  const query = { isError: true, dataUpdatedAt: 1_700_000_000_000, refetch: vi.fn() };
  const render = (extra = {}, props = {}) => renderToStaticMarkup(createElement(
    RiderQueryErrorNotice, { query: { ...query, ...extra }, ...props },
  ));

  it("does not show a service banner after a background payment refresh fails", () => {
    expect(render({ data: [{ id: 1 }] })).toBe("");
  });

  it("also keeps valid empty and null cached results quiet", () => {
    expect(render({ data: [] })).toBe("");
    expect(render({ data: null })).toBe("");
  });

  it("keeps a friendly retry when the first load failed", () => {
    const html = render({ data: undefined, dataUpdatedAt: 0 });
    expect(html).toContain("Повторить");
    expect(html).toContain("Не удалось открыть этот раздел");
    expect(html).not.toMatch(/сервера|снимок|\\d{2}:\\d{2}:\\d{2}/);
  });

  it("does not hide blocking rental or session-verification failures", () => {
    const html = render({ data: { id: 1 } }, {
      blocking: true, message: "Не удалось проверить аккаунт. Попробуйте ещё раз.",
    });
    expect(html).toContain("Не удалось проверить аккаунт");
    expect(html).toContain("Повторить");
    expect(html).not.toContain("снимок");
  });

  it("disables retry while it is already fetching", () => {
    expect(render({ data: undefined, isFetching: true })).toContain('disabled=""');
  });

  it("does not render successful queries", () => {
    expect(render({ isError: false })).toBe("");
  });

  it("preserves technical diagnostics in the admin component", () => {
    const html = renderToStaticMarkup(createElement(QueryErrorNotice, { query }));
    expect(html).toContain("сохранённый снимок");
    expect(html).toContain("Повторить");
  });
});
