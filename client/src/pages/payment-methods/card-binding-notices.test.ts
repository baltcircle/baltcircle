import { expect, it } from "vitest";
import { createCardBindingNotices } from "./card-binding-notices";
import type { PublicPaymentMethod } from "@shared/schema";

const method = (status: string, code = "DUPLICATE_CARD") =>
  ({ id: 7, type: "card", status, lastErrorCode: code }) as PublicPaymentMethod;

it("notifies once for a tracked duplicate, never for historical failures", () => {
  const notices = createCardBindingNotices();
  expect(notices.consume(method("failed"))).toBe(false);
  notices.track(7);
  expect(notices.consume(method("pending"))).toBe(false);
  expect(notices.consume(method("failed"))).toBe(true);
  expect(notices.consume(method("failed"))).toBe(false);
});

it("keeps ordinary failures and successful bindings silent", () => {
  const notices = createCardBindingNotices();
  for (const m of [method("active"), method("failed", "AUTH_FAIL")]) {
    notices.track(7);
    expect(notices.consume(m)).toBe(false);
    expect(notices.consume(method("failed"))).toBe(false);
  }
});

it("persists the current attempt across reloads but does not replay a shown notice", () => {
  const data = new Map<string, string>();
  const session = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } };
  createCardBindingNotices(session).track(7);
  expect(createCardBindingNotices(session).consume(method("failed"))).toBe(true);
  expect(createCardBindingNotices(session).consume(method("failed"))).toBe(false);
});

it("works in memory when session storage is blocked", () => {
  const session = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const notices = createCardBindingNotices(session);
  notices.track(7);
  expect(notices.consume(method("failed"))).toBe(true);
});
