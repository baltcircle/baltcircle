import { describe, expect, it } from "vitest";
import { isNavItemActive } from "./navigation";

const sections = [
  "/admin", "/admin/bikes", "/admin/rides", "/admin/users",
  "/admin/map", "/admin/parkings", "/admin/analytics",
  "/admin/reviews", "/admin/maintenance", "/admin/support",
];

describe("active navigation indicator", () => {
  it.each(sections)("highlights only the open section at %s", (path) => {
    expect(sections.filter((href) => isNavItemActive(path, href))).toEqual([path]);
  });

  it.each([
    ["/admin/support/tickets", "/admin/support"],
    ["/admin/maintenance/42", "/admin/maintenance"],
    ["/admin/rides/123", "/admin/rides"],
  ])("keeps the parent section active on %s, not the dashboard", (path, parent) => {
    expect(sections.filter((href) => isNavItemActive(path, href))).toEqual([parent]);
  });

  it("moves the indicator back to the dashboard when returning", () => {
    const active = (path: string) => sections.filter((href) => isNavItemActive(path, href));
    expect(active("/admin")).toEqual(["/admin"]);
    expect(active("/admin/rides")).toEqual(["/admin/rides"]);
    expect(active("/admin/users")).toEqual(["/admin/users"]);
    expect(active("/admin")).toEqual(["/admin"]);
  });

  it("handles trailing slashes without matching similarly named sections", () => {
    expect(isNavItemActive("/admin/", "/admin")).toBe(true);
    expect(isNavItemActive("/admin/rides/", "/admin/rides")).toBe(true);
    expect(isNavItemActive("/admin/rides-other", "/admin/rides")).toBe(false);
    expect(isNavItemActive("/administrator", "/admin")).toBe(false);
  });

  it("preserves rider navigation behavior", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/rides", "/")).toBe(false);
    expect(isNavItemActive("/rides/42", "/rides")).toBe(true);
  });
});
