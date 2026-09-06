import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mapPage = readFileSync(resolve(process.cwd(), "client/src/pages/MapPage.tsx"), "utf8");
const rideCard = readFileSync(resolve(process.cwd(), "client/src/pages/map/ActiveRideCard.tsx"), "utf8");
const reservationBanner = readFileSync(resolve(process.cwd(), "client/src/pages/map/ReservationBanner.tsx"), "utf8");
const mapLibre = readFileSync(resolve(process.cwd(), "client/src/components/MapLibreMap.tsx"), "utf8");

// Во время аренды карта раньше жёстко следовала за GPS (followUser), из-за чего
// пользователь не мог свободно её двигать: каждый GPS-tick возвращал видовой порт
// к велосипеду. Теперь центр — явное состояние страницы, меняемое только по
// осознанным событиям; телеметрия велосипеда двигает только его метку.
describe("MapPage: свободная карта + явный фокус на велосипед", () => {
  it("постоянное слежение за GPS во время аренды выключено", () => {
    expect(mapPage).toMatch(/followUser=\{false\}/);
    expect(mapPage).not.toMatch(/followUser=\{activeRides\.length > 0\}/);
  });

  it("центр карты — собственное состояние страницы, а не напрямую geoCenter", () => {
    expect(mapPage).toContain("const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);");
    expect(mapPage).toMatch(/center=\{mapCenter\}/);
    expect(mapPage).toMatch(/centerZoom=\{mapCenterZoom\}/);
  });

  it("кнопка «моё местоположение» сохраняет прежний зум 14", () => {
    expect(mapPage).toMatch(/if \(!geoCenter\) return;\s*setMapCenter\(geoCenter\);\s*setMapCenterZoom\(14\);/);
  });

  it("фокус берёт координаты велосипеда из /api/bikes и переводит их через mapToReal", () => {
    expect(mapPage).toMatch(/const \[lat, lng\] = mapToReal\(b\.lng, b\.lat\);/);
    expect(mapPage).toMatch(/setMapCenter\(\[lat, lng\]\);/);
  });

  it("первичный фокус на велосипед выполняется один раз на bikeId (обновления флота карту не двигают)", () => {
    expect(mapPage).toContain("const focusedOnceBikeRef = useRef<string | null>(null);");
    expect(mapPage).toMatch(/if \(focusedOnceBikeRef\.current === bikeId\) return;/);
    expect(mapPage).toMatch(/\}, \[focusedRide\?\.bikeId, focusBike\]\);/);
  });

  it("возврат в приложение при активной аренде возвращает фокус на велосипед", () => {
    expect(mapPage).toMatch(/document\.addEventListener\("visibilitychange", onReturn\);/);
    expect(mapPage).toMatch(/window\.addEventListener\("focus", onReturn\);/);
    expect(mapPage).toMatch(/window\.addEventListener\("pageshow", onReturn\);/);
  });

  it("автофокус после 10 секунд бездействия, с перезапуском таймера и очисткой слушателей", () => {
    expect(mapPage).toContain("const IDLE_FOCUS_MS = 10_000;");
    expect(mapPage).toMatch(/idleTimer = setTimeout\(\(\) => \{[\s\S]{0,200}focusCurrentRideRef\.current\?\.\(null\);[\s\S]{0,120}arm\(\);/);
    expect(mapPage).toMatch(/return \(\) => \{\s*if \(idleTimer\) clearTimeout\(idleTimer\);/);
    expect(mapPage).toMatch(/document\.removeEventListener\("visibilitychange", onReturn\);/);
  });

  it("слушатели бездействия живут только пока есть активная аренда", () => {
    expect(mapPage).toMatch(/if \(!hasActiveRide\) return;/);
    expect(mapPage).toMatch(/\}, \[hasActiveRide\]\);/);
  });
});

describe("Карточка аренды и баннер брони фокусируют карту", () => {
  it("клик по свободной области карточки вызывает onFocusBike", () => {
    expect(rideCard).toMatch(/onClick=\{handleCardClick\}/);
    expect(rideCard).toMatch(/onFocusBike\(\);/);
  });

  it("клики по кнопкам внутри карточки фокус не вызывают", () => {
    expect(rideCard).toMatch(/if \(target\?\.closest\?\.\(NON_FOCUS_SELECTOR\)\) return;/);
    expect(rideCard).toMatch(/const NON_FOCUS_SELECTOR =[\s\S]{0,160}button/);
  });

  it("баннер брони центрирует карту, но кнопка отмены остаётся самостоятельной", () => {
    expect(reservationBanner).toMatch(/onClick=\{handleBannerClick\}/);
    expect(reservationBanner).toMatch(/if \(target\?\.closest\?\.\(NON_FOCUS_SELECTOR\)\) return;/);
    expect(reservationBanner).toMatch(/const NON_FOCUS_SELECTOR = 'button,/);
  });

  it("MapPage прокидывает фокус в обе поверхности", () => {
    expect(mapPage).toMatch(/onFocusBike=\{\(\) => focusBike\(focusedRide\.bikeId, EXPLICIT_FOCUS_ZOOM\)\}/);
    expect(mapPage).toMatch(/onFocusBike=\{\(\) => focusBike\(r\.bikeId, EXPLICIT_FOCUS_ZOOM\)\}/);
  });
});

describe("MapLibreMap: центрирование без сброса пользовательского зума", () => {
  it("centerZoom === null сохраняет текущий зум, undefined оставляет прежние 14", () => {
    expect(mapLibre).toMatch(/centerZoom\?: number \| null;/);
    expect(mapLibre).toMatch(/\.\.\.\(z === null \? \{\} : \{ zoom: z \?\? 14 \}\)/);
  });

  it("эффект центрирования по-прежнему триггерится только сменой ссылки center", () => {
    expect(mapLibre).toMatch(/duration: 1000,\s*\}\);\s*\}, \[center\]\);/);
  });
});
