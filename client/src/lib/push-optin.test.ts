import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  shouldAutoShowPushOptIn,
  markPushOptInShown,
  dismissPushOptInForever,
  PUSH_OPTIN_MAX_AUTO_SHOWS,
  PUSH_OPTIN_COOLDOWN_MS,
} from "./push-optin";

const NOW = 1_800_000_000_000;

// Минимальный localStorage: vitest.config использует environment "node",
// поэтому реального window/localStorage здесь нет.
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
  return store;
}

describe("push opt-in gate", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    vi.restoreAllMocks();
  });

  it("предлагает на чистом состоянии, когда разрешение ещё не спрашивали", () => {
    expect(shouldAutoShowPushOptIn("default", NOW)).toBe(true);
  });

  it.each(["granted-subscribed", "granted-unsubscribed", "denied", "ios-need-standalone", "unsupported"])(
    "не предлагает в состоянии %s",
    (state) => {
      expect(shouldAutoShowPushOptIn(state, NOW)).toBe(false);
    },
  );

  it("после показа молчит весь кулдаун", () => {
    markPushOptInShown(NOW);
    expect(shouldAutoShowPushOptIn("default", NOW + PUSH_OPTIN_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldAutoShowPushOptIn("default", NOW + PUSH_OPTIN_COOLDOWN_MS)).toBe(true);
  });

  it("останавливается после лимита показов", () => {
    let t = NOW;
    for (let i = 0; i < PUSH_OPTIN_MAX_AUTO_SHOWS; i += 1) {
      expect(shouldAutoShowPushOptIn("default", t)).toBe(true);
      markPushOptInShown(t);
      t += PUSH_OPTIN_COOLDOWN_MS;
    }
    expect(shouldAutoShowPushOptIn("default", t)).toBe(false);
  });

  it("«не сейчас» гасит навсегда", () => {
    dismissPushOptInForever();
    expect(shouldAutoShowPushOptIn("default", NOW + 10 * PUSH_OPTIN_COOLDOWN_MS)).toBe(false);
  });

  it("повреждённый JSON не роняет и ведёт себя как чистое состояние", () => {
    store.set("bc.push.optin", "{не json");
    expect(shouldAutoShowPushOptIn("default", NOW)).toBe(true);
  });

  it("не падает без localStorage (Private Mode)", () => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    expect(() => markPushOptInShown(NOW)).not.toThrow();
    expect(() => dismissPushOptInForever()).not.toThrow();
    // Без хранилища гейт всегда открыт — это лучше, чем молчать навсегда.
    expect(shouldAutoShowPushOptIn("default", NOW)).toBe(true);
  });

  it("не смешивается с состоянием подсказки «На экран Домой»", () => {
    markPushOptInShown(NOW);
    expect(store.has("bc.pwa.ios-hint")).toBe(false);
    expect(store.has("bc.push.optin")).toBe(true);
  });
});
