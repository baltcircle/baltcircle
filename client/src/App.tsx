import { Switch, Route, Router, Redirect, useLocation } from "wouter";
import { useEffect, useState, useRef, lazy, Suspense } from "react";
import { PENDING_BIKE_KEY } from "@/lib/pending-bike";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { AppShell } from "@/components/AppShell";
import { AdminGuard } from "@/components/AdminGuard";
import { MapPage } from "@/pages/MapPage";
import { RentPage } from "@/pages/RentPage";
import { TariffsPage } from "@/pages/TariffsPage";
import { RidesPage } from "@/pages/RidesPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { PaymentMethodsPage } from "@/pages/PaymentMethodsPage";
import { PaymentResultPage } from "@/pages/PaymentResultPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SupportPage } from "@/pages/SupportPage";
import { SafetyPage } from "@/pages/SafetyPage";
import { InfoSectionPage } from "@/pages/InfoSectionPage";
import { InfoDocPage } from "@/pages/InfoDocPage";
// Admin/operator pages and legal docs are code-split: a rider never downloads
// this code, and the heavy chart/map-editor deps ride along in their own chunks.
// Info pages (/safety/*) НЕ lazy — они крошечные (~1.4 kB каждая) и делят
// один info.tsx с текстами; lazy давал видимую задержку и flash-fallback
// на КАЖДОМ переходе внутри раздела «Информация» (карта скрывалась и появлялся
// спиннер), потому что ближайший Suspense вверх по дереву — на весь AppRouter.
const LegalIndexPage = lazy(() => import("@/pages/LegalIndexPage").then((m) => ({ default: m.LegalIndexPage })));
const LegalDocPage = lazy(() => import("@/pages/LegalDocPage").then((m) => ({ default: m.LegalDocPage })));
const AdminPage = lazy(() => import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const RidesAdminPage = lazy(() => import("@/pages/RidesAdminPage").then((m) => ({ default: m.RidesAdminPage })));
const BikesPage = lazy(() => import("@/pages/BikesPage").then((m) => ({ default: m.BikesPage })));
const UsersPage = lazy(() => import("@/pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const MaintenancePage = lazy(() => import("@/pages/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
const SupportInboxPage = lazy(() => import("@/pages/SupportInboxPage").then((m) => ({ default: m.SupportInboxPage })));
const MapEditorPage = lazy(() => import("@/pages/MapEditorPage").then((m) => ({ default: m.MapEditorPage })));
const ParkingsPage = lazy(() => import("@/pages/ParkingsPage").then((m) => ({ default: m.ParkingsPage })));
const OperationsMapPage = lazy(() => import("@/pages/OperationsMapPage").then((m) => ({ default: m.OperationsMapPage })));
import NotFound from "@/pages/not-found";

// OverlayRouter — renders customer pages as a fixed overlay on top of the map.
// Exit animation: pages dispatch "overlay:back" event → OverlayRouter plays
// slide-down for 300ms, then calls history.back() itself.
//
// Переход между вложенными overlay-маршрутами (напр. /safety/foo → /safety)
// должен быть мгновенным: overlay-контейнер остаётсь смонтирован, меняется только
// внутренний <Switch>. Анимация slide-down/up включается только когда мы выходим
// в non-overlay маршрут (карта, /profile, /legal и т.п.).
function isOverlayPath(path: string): boolean {
  return OVERLAY_ROUTES.some((r) => path === r || path.startsWith(r + "/"));
}

function OverlayRouter({ loc, isOverlay }: { loc: string; isOverlay: boolean }) {
  const [visible, setVisible] = useState(isOverlay);
  const [exiting, setExiting] = useState(false);

  // On enter: show overlay. On exit via browser swipe (isOverlay → false
  // without overlay:back event): immediately hide without animation.
  useEffect(() => {
    if (isOverlay) {
      setVisible(true);
    } else if (!exiting) {
      // Browser swipe-back or programmatic popstate changed URL to a
      // non-overlay route — hide the overlay instantly so it doesn't
      // sit on top of the map and eat touch events. Не лезем, если в процессе
      // exit-анимации — её таймер сам скроет оверлей через 300ms.
      setVisible(false);
    }
  }, [isOverlay, loc, exiting]);

  // Listen for back-navigation requests from child pages
  useEffect(() => {
    const handler = () => {
      if (!visible || exiting) return;

      // Навигация назад: вызываем history.back() сразу, на следующем тике
      // читаем новый URL. Если он overlay — оверлей остаётся смонтирован,
      // внутренний <Switch> мгновенно покажет предыдущую overlay-страницу
      // без slide-анимаций. Если новый URL не overlay — играем slide-down 300ms
      // и потом скрываем оверлей.
      window.history.back();
      queueMicrotask(() => {
        if (isOverlayPath(window.location.pathname)) return;
        // Мы вышли в non-overlay (карта, /profile, /legal). isOverlay=false
        // уже обновился через popstate, и useEffect выше собирается
        // сделать setVisible(false). Чтобы успеть показать slide-down,
        // отлагаем скрытие: сейчас setVisible(true) перебьёт этот useEffect
        // и включит exit-класс, таймер через 300ms уберёт overlay.
        setExiting(true);
        setVisible(true);
        setTimeout(() => {
          setExiting(false);
          setVisible(false);
        }, 300);
      });
    };
    window.addEventListener("overlay:back", handler);
    return () => window.removeEventListener("overlay:back", handler);
  }, [visible, exiting]);

  if (!visible) return null;

  return (
    <div className={`fixed inset-0 z-50 ${exiting ? "animate-slide-down" : "animate-slide-up"}`}>
      <Switch>
        <Route path="/settings" component={SettingsPage} />
        <Route path="/rides" component={RidesPage} />
        <Route path="/payment-methods" component={PaymentMethodsPage} />
        <Route path="/support" component={SupportPage} />
        <Route path="/safety" component={SafetyPage} />
        <Route path="/safety/:section/:slug">{(params) => <InfoDocPage section={params.section} slug={params.slug} />}</Route>
        <Route path="/safety/:section">{(params) => <InfoSectionPage section={params.section} />}</Route>
        <Route path="/tariffs" component={TariffsPage} />
        <Route path="/rent" component={RentPage} />
        <Route path="/payment-result" component={PaymentResultPage} />
      </Switch>
    </div>
  );
}

// Customer routes rendered as overlays on top of the always-alive MapPage.
// Add new customer pages here — they will slide up over the map.
const OVERLAY_ROUTES = [
  "/settings",
  "/rides",
  "/payment-methods",
  "/support",
  "/safety",
  "/tariffs",
  "/rent",
  "/payment-result",
];

// Minimal fallback shown while a code-split route chunk loads. Deliberately
// plain (no heavy deps) so it appears instantly.
function PageFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary"
        role="status"
        aria-label="Загрузка"
      />
    </div>
  );
}

function AppRouter() {
  const [loc] = useLocation();
  const isHome = loc === "/" || loc.startsWith("/bike/");
  // Check if current route is an overlay (customer page over map)
  const isOverlay = OVERLAY_ROUTES.some(r => loc === r || loc.startsWith(r + "/"));
  return (
    <>
      {/* MapPage is always mounted to keep Yandex Map alive */}
      <div style={{ display: isHome || isOverlay ? "contents" : "none" }} aria-hidden={!isHome && !isOverlay}>
        <MapPage />
      </div>

      {/* Overlay customer pages — rendered as fixed layer on top of map with slide-up/down animation */}
      <OverlayRouter loc={loc} isOverlay={isOverlay} />

    {/* QR deep link: a scanned bike URL (".../bike/BC-001") lands here, is
        stashed, and redirects to the map which auto-opens the rental flow.
        Вне Suspense: BikeDeepLink синхронный, а Suspense-fallback перекрывал бы
        MapPage белым экраном пока грузятся lazy-чанки. */}
    <Switch>
      <Route path="/bike/:id">{(params) => <BikeDeepLink id={params.id} />}</Route>
      <Route><></></Route>
    </Switch>

    <Suspense fallback={<PageFallback />}>
    <Switch>
      {/* Customer / rider interface */}
      <Route path="/"><></></Route>
      {/* /bike/:id уже обработан выше в BikeDeepLink; здесь нужен пустой матч чтобы NotFound не сработал. */}
      <Route path="/bike/:id"><></></Route>
      <Route path="/rent"><></></Route>
      <Route path="/tariffs"><></></Route>
      <Route path="/rides"><></></Route>
      <Route path="/profile" component={ProfilePage} />
      <Route path="/payment-methods"><></></Route>
      <Route path="/payment-result"><></></Route>
      <Route path="/settings"><></></Route>
      <Route path="/support"><></></Route>
      <Route path="/safety"><></></Route>
      <Route path="/safety/:section"><></></Route>
      <Route path="/safety/:section/:slug"><></></Route>

      {/* Legal documents */}
      <Route path="/legal" component={LegalIndexPage} />
      <Route path="/legal/:slug">{(params) => <LegalDocPage slug={params.slug} />}</Route>

      {/* Legacy legal routes — keep existing registration links working */}
      <Route path="/privacy"><Redirect to="/legal/privacy" /></Route>
      <Route path="/consent"><Redirect to="/legal/consent" /></Route>

      {/* Admin / operator interface — gated by role. Mechanics may only reach
          service (maintenance) and the read-only fleet; the rest is
          operator/admin only. */}
      <Route path="/admin"><AdminGuard roles={["operator", "admin"]}><AdminPage /></AdminGuard></Route>
      <Route path="/admin/bikes"><AdminGuard roles={["mechanic", "operator", "admin"]}><BikesPage /></AdminGuard></Route>
      <Route path="/admin/rides"><AdminGuard roles={["operator", "admin"]}><RidesAdminPage /></AdminGuard></Route>
      <Route path="/admin/users"><AdminGuard roles={["operator", "admin"]}><UsersPage /></AdminGuard></Route>
      <Route path="/admin/map"><AdminGuard roles={["operator", "admin"]}><MapEditorPage /></AdminGuard></Route>
      <Route path="/admin/operations-map"><AdminGuard roles={["operator", "admin"]}><OperationsMapPage /></AdminGuard></Route>
      <Route path="/admin/parkings"><AdminGuard roles={["operator", "admin"]}><ParkingsPage /></AdminGuard></Route>
      <Route path="/admin/analytics"><AdminGuard roles={["operator", "admin"]}><AnalyticsPage /></AdminGuard></Route>
      <Route path="/admin/maintenance"><AdminGuard roles={["mechanic", "operator", "admin"]}><MaintenancePage /></AdminGuard></Route>
      <Route path="/admin/support"><AdminGuard roles={["operator", "admin"]}><SupportInboxPage /></AdminGuard></Route>

      {/* Legacy admin deep-links — redirect to the namespaced routes */}
      <Route path="/analytics"><Redirect to="/admin/analytics" /></Route>
      <Route path="/maintenance"><Redirect to="/admin/maintenance" /></Route>

      <Route component={NotFound} />
    </Switch>
    </Suspense>
    </>
  );
}

// Lands a scanned QR deep link: stash the bike code for the map to pick up,
// then redirect home. Normalizes the code so "bc-1" / "BC-001" both work.
function BikeDeepLink({ id }: { id: string }) {
  const [, navigate] = useLocation();
  useEffect(() => {
    const code = id.trim().toUpperCase();
    if (code) sessionStorage.setItem(PENDING_BIKE_KEY, code);
    navigate("/", { replace: true });
  }, [id, navigate]);
  return null;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Router>
            <AppShell>
              <AppRouter />
            </AppShell>
          </Router>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
