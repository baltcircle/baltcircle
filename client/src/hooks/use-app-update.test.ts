import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hook = readFileSync(resolve(process.cwd(), "client/src/hooks/use-app-update.ts"), "utf8");
const banner = readFileSync(resolve(process.cwd(), "client/src/components/UpdateBanner.tsx"), "utf8");
const app = readFileSync(resolve(process.cwd(), "client/src/App.tsx"), "utf8");
const staticServer = readFileSync(resolve(process.cwd(), "server/static.ts"), "utf8");
const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

describe("Автообновление: сборка", () => {
  it("id сборки вшивается в бандл и кладётся рядом в version.json", () => {
    expect(viteConfig).toContain("__BUILD_ID__");
    expect(viteConfig).toContain('fileName: "version.json"');
    // Один и тот же BUILD_ID в обоих местах — иначе клиент вечно считал бы
    // себя устаревшим и перезагружался по кругу.
    expect(viteConfig).toMatch(/const BUILD_ID = resolveBuildId\(\);/);
    expect(viteConfig).toMatch(/__BUILD_ID__: JSON\.stringify\(BUILD_ID\)/);
    expect(viteConfig).toMatch(/buildId: BUILD_ID/);
  });
});

describe("Автообновление: заголовки кэша", () => {
  it("index.html, version.json, sw.js и манифест не кэшируются", () => {
    for (const f of ["/index.html", "/version.json", "/sw.js", "/manifest.webmanifest"]) {
      expect(staticServer).toContain(`"${f}"`);
    }
    expect(staticServer).toContain("no-cache, must-revalidate");
  });

  it("SPA-fallback тоже отдаётся без кэша", () => {
    const fallback = staticServer.slice(staticServer.indexOf('app.use("/{*path}"'));
    expect(fallback).toContain("no-cache, must-revalidate");
  });

  it("хэшированные ассеты кэшируются навсегда", () => {
    expect(staticServer).toContain("public, max-age=31536000, immutable");
  });
});

describe("Автообновление: поведение клиента", () => {
  it("проверка идёт при возврате во вкладку и по таймеру", () => {
    expect(hook).toContain('document.addEventListener("visibilitychange"');
    expect(hook).toContain('window.addEventListener("pageshow"');
    expect(hook).toContain("setInterval");
  });

  it("молча перезагружается только без активной аренды и после долгого фона", () => {
    expect(hook).toMatch(/!hasActiveRide\(\)/);
    expect(hook).toMatch(/hiddenFor >= SILENT_RELOAD_HIDDEN_MS/);
    expect(hook).toContain('queryClient.getQueryData<Ride[]>(["/api/rides/active"])');
  });

  it("есть защита от петли перезагрузок", () => {
    expect(hook).toContain("silentAllowedRef");
    expect(hook).toContain("RELOAD_GUARD_KEY");
    expect(hook).toMatch(/if \(guard\.to === BUILD_ID\)/);
  });

  it("слушатели и запрос снимаются при размонтировании", () => {
    expect(hook).toContain("ctrl.abort()");
    expect(hook).toContain("clearInterval(timer)");
    expect(hook).toContain('document.removeEventListener("visibilitychange"');
  });

  it("баннер не блокирует интерфейс и даёт отложить", () => {
    expect(banner).toContain("pointer-events-none");
    expect(banner).toContain('data-testid="button-app-update-apply"');
    expect(banner).toContain('data-testid="button-app-update-dismiss"');
    expect(banner).not.toContain("Dialog");
  });

  it("баннер смонтирован внутри QueryClientProvider", () => {
    const providerStart = app.indexOf("<QueryClientProvider");
    const bannerAt = app.indexOf("<UpdateBanner />");
    expect(providerStart).toBeGreaterThan(-1);
    expect(bannerAt).toBeGreaterThan(providerStart);
  });
});
