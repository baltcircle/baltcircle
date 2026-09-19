import type { PublicPaymentMethod } from "@shared/schema";

const KEY = "takeride:card-binding-notices";
type SessionStore = Pick<Storage, "getItem" | "setItem">;

// Remember only attempts started/observed in this tab, not old failed rows.
// Session storage survives the bank redirect; the in-memory set handles denied
// storage access. Consuming any terminal result prevents repeated notices.
export function createCardBindingNotices(store?: SessionStore) {
  const pending = new Set<number>();
  try {
    const saved: unknown = JSON.parse(store?.getItem(KEY) ?? "[]");
    if (Array.isArray(saved)) {
      for (const id of saved) if (Number.isSafeInteger(id) && id > 0) pending.add(id);
    }
  } catch { /* Storage unavailable or invalid: use the in-memory set. */ }
  const persist = () => {
    try { store?.setItem(KEY, JSON.stringify(Array.from(pending))); } catch { /* In-memory fallback. */ }
  };
  return {
    track(id: number) {
      if (!Number.isSafeInteger(id) || id <= 0 || pending.has(id)) return;
      pending.add(id);
      persist();
    },
    consume(method: PublicPaymentMethod): boolean {
      if (method.type !== "card" || !["active", "failed"].includes(method.status)) return false;
      if (!pending.delete(method.id)) return false;
      persist();
      return method.status === "failed" && method.lastErrorCode === "DUPLICATE_CARD";
    },
  };
}
