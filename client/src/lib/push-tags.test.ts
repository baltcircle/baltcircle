import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rideExpiryTag } from "@shared/ride-expiry";
import { closeNotificationsByTag, closeRideExpiryNotifications } from "./push";

interface FakeNotification { tag: string; close: () => void }

function installServiceWorker(byTag: Record<string, FakeNotification[]>) {
  const getNotifications = vi.fn(async ({ tag }: { tag: string }) => byTag[tag] ?? []);
  const registration = { getNotifications };
  const nav = { serviceWorker: { getRegistration: vi.fn(async () => registration) } };
  vi.stubGlobal("navigator", nav);
  return { getNotifications, nav };
}

function notification(tag: string): FakeNotification {
  return { tag, close: vi.fn() };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rideExpiryTag", () => {
  it("одинаков для всех трёх стадий одной поездки", () => {
    // Три предупреждения об одном дедлайне должны заменять друг друга,
    // а не копиться стопкой — за это отвечает общий тег.
    expect(rideExpiryTag(42)).toBe(rideExpiryTag(42));
  });

  it("различается у разных поездок", () => {
    // Две одновременные аренды — две независимые карточки.
    expect(rideExpiryTag(42)).not.toBe(rideExpiryTag(43));
  });
});

describe("closeNotificationsByTag", () => {
  it("закрывает только карточки указанного тега", async () => {
    const mine = notification(rideExpiryTag(42));
    const other = notification(rideExpiryTag(43));
    installServiceWorker({
      [rideExpiryTag(42)]: [mine],
      [rideExpiryTag(43)]: [other],
    });

    await closeNotificationsByTag([rideExpiryTag(42)]);

    expect(mine.close).toHaveBeenCalledTimes(1);
    expect(other.close).not.toHaveBeenCalled();
  });

  it("закрывает все карточки под одним тегом", async () => {
    const a = notification("t");
    const b = notification("t");
    installServiceWorker({ t: [a, b] });

    await closeNotificationsByTag(["t"]);

    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it("ничего не делает на пустом списке тегов", async () => {
    const { nav } = installServiceWorker({});
    await closeNotificationsByTag([]);
    expect(nav.serviceWorker.getRegistration).not.toHaveBeenCalled();
  });

  it("молчит без service worker", async () => {
    vi.stubGlobal("navigator", {});
    await expect(closeNotificationsByTag(["t"])).resolves.toBeUndefined();
  });

  it("молчит, когда регистрации ещё нет", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: vi.fn(async () => undefined) } });
    await expect(closeNotificationsByTag(["t"])).resolves.toBeUndefined();
  });

  it("не бросает, если getNotifications упал", async () => {
    // Приватный режим и урезанные права не должны ронять завершение поездки.
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({
          getNotifications: vi.fn(async () => { throw new Error("denied"); }),
        })),
      },
    });
    await expect(closeNotificationsByTag(["t"])).resolves.toBeUndefined();
  });
});

describe("closeRideExpiryNotifications", () => {
  it("снимает карточку дедлайна своей поездки, не трогая чужую", async () => {
    const mine = notification(rideExpiryTag(7));
    const other = notification(rideExpiryTag(8));
    installServiceWorker({
      [rideExpiryTag(7)]: [mine],
      [rideExpiryTag(8)]: [other],
    });

    closeRideExpiryNotifications(7);
    await vi.waitFor(() => expect(mine.close).toHaveBeenCalledTimes(1));
    expect(other.close).not.toHaveBeenCalled();
  });
});
