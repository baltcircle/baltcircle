import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sheet = readFileSync(resolve(process.cwd(), "client/src/components/IosInstallSheet.tsx"), "utf8");
const drawer = readFileSync(resolve(process.cwd(), "client/src/components/DrawerMenu.tsx"), "utf8");
const mapPage = readFileSync(resolve(process.cwd(), "client/src/pages/MapPage.tsx"), "utf8");
const push = readFileSync(resolve(process.cwd(), "client/src/lib/push.ts"), "utf8");

// На iOS нет beforeinstallprompt: установить PWA программно нельзя, а без
// установки Safari не даёт подписаться на Web Push. Поэтому инструкция — не
// украшение, а единственный путь к уведомлениям о поездке.
describe("IosInstallSheet: инструкция «На экран Домой»", () => {
  it("содержит три шага установки в правильном порядке", () => {
    const share = sheet.indexOf("Нажмите «Поделиться»");
    const home = sheet.indexOf("Выберите «На экран");
    const add = sheet.indexOf("Нажмите «Добавить»");
    expect(share).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(share);
    expect(add).toBeGreaterThan(home);
  });

  it("объясняет связь установки с уведомлениями", () => {
    expect(sheet).toMatch(/уведомлени/i);
  });

  it("«Больше не показывать» доступно только при авто-показе", () => {
    expect(sheet).toMatch(/auto\s*&&/);
    expect(sheet).toContain("dismissIosInstallHintForever");
  });
});

describe("Интеграция подсказки", () => {
  it("пункт в бургер-меню виден только на iOS вне установленной PWA", () => {
    expect(drawer).toContain("canInstallIosPwa");
    expect(drawer).toMatch(/showInstallEntry\s*&&/);
    expect(drawer).toContain('data-testid="button-drawer-install-pwa"');
    expect(drawer).toContain("<IosInstallSheet");
  });

  it("ручное открытие из меню не использует гейт авто-показа", () => {
    expect(drawer).not.toContain("shouldAutoShowIosInstallHint");
    expect(drawer).not.toMatch(/<IosInstallSheet[^>]*\sauto\b/);
  });

  it("на карте окно всплывает при старте аренды и ровно один раз на поездку", () => {
    expect(mapPage).toContain("shouldAutoShowIosInstallHint");
    expect(mapPage).toContain("markIosInstallHintShown");
    // Ключ гейта — id поездки: перемонтирование карты после редиректа с оплаты
    // не должно показывать окно повторно в той же аренде.
    expect(mapPage).toMatch(/const key = String\(newestRideId\);/);
    expect(mapPage).toMatch(/<IosInstallSheet[^>]*\bauto\b/);
  });

  it("определение iOS/standalone не продублировано в push.ts", () => {
    expect(push).toContain('from "./pwa"');
    expect(push).not.toMatch(/function isIos\(/);
    expect(push).not.toMatch(/function isStandalone\(/);
  });
});
