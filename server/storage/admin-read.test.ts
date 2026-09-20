import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mock = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../db/bootstrap", () => ({ db: mock }));
import { feedbackPage, rideStats } from "./admin-read";

beforeEach(() => vi.clearAllMocks());
const dialect = new PgDialect();
describe("complete administrative read models", () => {
  it("paginates feedback AFTER union and filtering, including rows past 500", async () => {
    mock.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 1201 }] });
    const result = await feedbackPage({ limit: "50", offset: "1000", search: "needle", rating: "5", direction: "asc" });
    const query = dialect.sqlToQuery(mock.execute.mock.calls[1][0]);
    expect(query.sql).toContain("UNION ALL");
    expect(query.sql.indexOf("UNION ALL")).toBeLessThan(query.sql.indexOf("LIMIT"));
    expect(query.params).toContain("%needle%");
    expect(query.params).toContain(1000);
    expect(result.total).toBe(1201);
    expect(result.items).toEqual([]);
  });
  it("uses a database aggregate rather than a bounded ride array for today's counter", async () => {
    mock.execute.mockResolvedValue({ rows: [{ ridesToday: 351 }] });
    expect(await rideStats(10, 99)).toEqual({ ridesToday: 351 });
    const query = dialect.sqlToQuery(mock.execute.mock.calls[0][0]);
    expect(query.sql).toMatch(/count\(\*\)/i);
    expect(query.sql).not.toContain("LIMIT");
    expect(query.params).toEqual([10, 99]);
  });
});
