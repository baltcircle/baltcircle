import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canInstallIosPwa,
  dismissIosInstallHintForever,
  isIos,
  isStandalone,
  markIosInstallHintShown,
  shouldAutoShowIosInstallHint,
  IOS_HINT_COOLDOWN_MS,
  IOS_HINT_MAX_AUTO_SHOWS,
} from "./pwa";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPADOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";

function makeStorage(broken = false) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (broken) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("QuotaExceededError");
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

interface EnvOptions {
  ua?: string;
  touch?: boolean;
  standalone?: boolean;
  displayMode?: boolean;
  storage?: Storage;
}

function setEnv({ ua = IPHONE_UA, touch = true, standalone = false, displayMode = false, storage }: EnvOptions = {}) {
  const nav = { userAgent: ua, standalone };
  const win = {
    matchMedia: (q: string) => ({ matches: q.includes("standalone") ? displayMode : false }),
    navigator: nav,
  };
  const doc = touch ? { ontouchend: null } : {};
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("localStorage", storage ?? makeStorage());
}

beforeEach(() => setEnv());
afterEach(() => vi.unstubAllGlobals());

describe("pwa: определение платформы", () => {
  it("iPhone распознаётся как iOS", () => {
    expect(isIos()).toBe(true);
  });

  it("iPadOS маскируется под Mac и определяется по наличию тач-событий", () => {
    setEnv({ ua: IPADOS_UA, touch: true });
    expect(isIos()).toBe(true);

    setEnv({ ua: IPADOS_UA, touch: false });
    expect(isIos()).toBe(false);
  });

  it("Android не считается iOS", () => {
    setEnv({ ua: ANDROID_UA });
    expect(isIos()).toBe(false);
    expect(canInstallIosPwa()).toBe(false);
  });

  it("standalone определяется и через display-mode, и через navigator.standalone", () => {
    setEnv({ displayMode: true });
    expect(isStandalone()).toBe(true);

    setEnv({ standalone: true });
    expect(isStandalone()).toBe(true);

    setEnv();
    expect(isStandalone()).toBe(false);
  });

  it("подсказка уместна только на iOS вне установленной PWA", () => {
    expect(canInstallIosPwa()).toBe(true);

    setEnv({ standalone: true });
    expect(canInstallIosPwa()).toBe(false);
  });
});

describe("pwa: гейт авто-показа подсказки", () => {
  it("первый показ разрешён, повтор с тем же ключом — нет", () => {
    expect(shouldAutoShowIosInstallHint("101")).toBe(true);
    markIosInstallHintShown("101");
    expect(shouldAutoShowIosInstallHint("101")).toBe(false);
  });

  it("новая поездка внутри cooldown не открывает окно повторно", () => {
    const t0 = Date.UTC(2026, 0, 1);
    markIosInstallHintShown("101", t0);
    expect(shouldAutoShowIosInstallHint("102", t0 + IOS_HINT_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldAutoShowIosInstallHint("102", t0 + IOS_HINT_COOLDOWN_MS)).toBe(true);
  });

  it("после MAX авто-показов подсказка больше не всплывает", () => {
    let t = Date.UTC(2026, 0, 1);
    for (let i = 0; i < IOS_HINT_MAX_AUTO_SHOWS; i++) {
      expect(shouldAutoShowIosInstallHint(`r${i}`, t)).toBe(true);
      markIosInstallHintShown(`r${i}`, t);
      t += IOS_HINT_COOLDOWN_MS;
    }
    expect(shouldAutoShowIosInstallHint("r-final", t)).toBe(false);
  });

  it("«Больше не показывать» гасит подсказку навсегда", () => {
    dismissIosInstallHintForever();
    expect(shouldAutoShowIosInstallHint("999", Date.now() + 10 * IOS_HINT_COOLDOWN_MS)).toBe(false);
  });

  it("на Android/desktop гейт закрыт независимо от истории показов", () => {
    setEnv({ ua: ANDROID_UA });
    expect(shouldAutoShowIosInstallHint("101")).toBe(false);
  });

  it("недоступный localStorage (Private Mode) не роняет вызовы", () => {
    setEnv({ storage: makeStorage(true) });
    expect(() => markIosInstallHintShown("101")).not.toThrow();
    expect(() => dismissIosInstallHintForever()).not.toThrow();
    // Состояние не сохраняется — подсказка просто останется доступной.
    expect(shouldAutoShowIosInstallHint("101")).toBe(true);
  });
});
