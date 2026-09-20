import { describe, expect, it } from "vitest";
import { mutationTopics } from "./admin-live-policy";
import { parseTimestamp, parseAdminPage } from "../../shared/admin-data";

describe("admin event policy", () => {
  it("publishes dependent topics only after successful writes", () => {
    expect(mutationTopics("POST", "/api/rides/45/feedback", 200)).toContain("feedback");
    expect(mutationTopics("POST", "/api/tickets/3/comments", 200)).toContain("service");
    expect(mutationTopics("POST", "/api/auth/verify", 200)).toContain("users");
    expect(mutationTopics("PATCH", "/api/map-objects/3", 200)).toContain("map");
    expect(mutationTopics("GET", "/api/admin/users", 200)).toEqual([]);
    expect(mutationTopics("POST", "/api/rides/45/feedback", 500)).toEqual([]);
    expect(mutationTopics("POST", "/api/admin/support/chats/4/read", 200)).toEqual([]);
  });
  it("parking archival is a committed mutation even with HTTP 409", () => {
    expect(mutationTopics("DELETE", "/api/admin/parkings/3", 409)).toContain("parkings");
    expect(mutationTopics("POST", "/api/rides/start", 409)).toEqual([]);
  });
});

describe("admin input boundaries", () => {
  it("accepts epoch zero for all-time, not missing/empty/negative timestamps", () => {
    expect(parseTimestamp("0", 99)).toBe(0);
    for (const invalid of [undefined, "", null, "-1", "Infinity", [], "no"]) {
      expect(parseTimestamp(invalid, 99)).toBe(99);
    }
  });
  it("bounds pagination and parameter lengths", () => {
    expect(parseAdminPage({ limit: "Infinity", offset: "Infinity" })).toMatchObject({ limit: 50, offset: 0 });
    expect(parseAdminPage({ limit: "9999", offset: "-10", search: " x " })).toMatchObject({ limit: 200, offset: 0, search: "x" });
  });
});
