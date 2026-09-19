import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const query = vi.hoisted(() => ({
  select: vi.fn(), from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
}));
vi.mock("../db/bootstrap", () => ({ db: query }));
vi.mock("../crypto/payment-tokens", () => ({
  decryptToken: (v: string | null) => v,
  hashTokenForLookup: (v: string) => `hash:${v}`,
  encryptToken: (v: string) => v,
}));
import { PaymentMethodMixin } from "./payment-method";

beforeEach(() => {
  vi.clearAllMocks();
  query.select.mockReturnValue(query);
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockResolvedValue([]);
});
const storage = new (PaymentMethodMixin(class {}))();
const compiled = () => new PgDialect().sqlToQuery(query.where.mock.calls[0][0] as SQL);

it("matches CardId or the RebillId blind index, never last4 or brand", async () => {
  await storage.findActiveCardDuplicate("user-1", "card-1", "secret-token", 42);
  const { sql, params } = compiled();
  expect(sql).toContain('"card_id"');
  expect(sql).toContain('"rebill_id_hash"');
  expect(sql).toContain(" OR ");
  expect(sql).not.toContain('"label"');
  expect(sql).not.toContain('"brand"');
  expect(params).toEqual(expect.arrayContaining(["user-1", "card-1", "hash:secret-token", 42]));
  expect(params).not.toContain("secret-token");
  expect(sql).toContain("'tbank'");
  expect(sql).toContain("'active'");
  expect(sql).toContain("'card'");
});

it("does not search without a provider identifier", async () => {
  expect(await storage.findActiveCardDuplicate("user-1", " ", null)).toBeUndefined();
  expect(query.select).not.toHaveBeenCalled();
});

it("supports RebillId alone without matching empty CardIds", async () => {
  await storage.findActiveCardDuplicate("user-1", null, " token ");
  const { sql, params } = compiled();
  expect(sql).toContain('"rebill_id_hash"');
  expect(sql).not.toContain('"card_id"');
  expect(params).toContain("hash:token");
});

it("returns the existing card by CardId alone", async () => {
  const existing = { id: 5, rebillId: null, accountToken: null };
  query.limit.mockResolvedValue([existing]);
  expect(await storage.findActiveCardDuplicate("user-1", " card-1 ", null, 42)).toEqual(existing);
  const { sql, params } = compiled();
  expect(sql).toContain('"card_id"');
  expect(sql).not.toContain('"rebill_id_hash"');
  expect(params).toContain("card-1");
});
