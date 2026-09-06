import { afterEach, describe, expect, it, vi } from "vitest";

async function importWithBuildId(buildId: string | undefined) {
  vi.resetModules();
  if (buildId === undefined) {
    vi.unstubAllGlobals();
  } else {
    vi.stubGlobal("__BUILD_ID__", buildId);
  }
  return import("./app-version");
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn as unknown as typeof fetch);
  return fn;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("app-version: чтение версии сервера", () => {
  it("запрашивает /version.json в обход кэша", async () => {
    const { fetchServerBuildId } = await importWithBuildId("abc123");
    const fetchFn = mockFetch(() => jsonResponse({ buildId: "def456" }));

    await expect(fetchServerBuildId()).resolves.toBe("def456");
    expect(fetchFn).toHaveBeenCalledWith("/version.json", expect.objectContaining({ cache: "no-store" }));
  });

  it("сетевая ошибка не пробрасывается наружу", async () => {
    const { fetchServerBuildId } = await importWithBuildId("abc123");
    mockFetch(() => Promise.reject(new Error("offline")));
    await expect(fetchServerBuildId()).resolves.toBeNull();
  });

  it("SPA-fallback с HTML вместо JSON даёт null, а не падение", async () => {
    const { fetchServerBuildId } = await importWithBuildId("abc123");
    mockFetch(() => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }) as Response);
    await expect(fetchServerBuildId()).resolves.toBeNull();
  });

  it("не-200 и ответ без buildId дают null", async () => {
    const { fetchServerBuildId } = await importWithBuildId("abc123");

    mockFetch(() => jsonResponse({ buildId: "x" }, false));
    await expect(fetchServerBuildId()).resolves.toBeNull();

    mockFetch(() => jsonResponse({}));
    await expect(fetchServerBuildId()).resolves.toBeNull();
  });
});

describe("app-version: сравнение версий", () => {
  it("другая версия на сервере считается устаревшей загруженной", async () => {
    const { isOutdated } = await importWithBuildId("abc123");
    expect(isOutdated("def456")).toBe(true);
    expect(isOutdated("abc123")).toBe(false);
  });

  it("недоступная версия сервера не считается обновлением", async () => {
    const { isOutdated } = await importWithBuildId("abc123");
    expect(isOutdated(null)).toBe(false);
  });

  it("в dev-режиме проверка отключена", async () => {
    // Без define (vitest, dev-сервер) BUILD_ID === "dev" — иначе баннер
    // «доступна новая версия» висел бы у разработчика постоянно.
    const { BUILD_ID, isOutdated } = await importWithBuildId(undefined);
    expect(BUILD_ID).toBe("dev");
    expect(isOutdated("anything")).toBe(false);
  });
});
