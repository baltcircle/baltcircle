import { Switch, Route, Router, Redirect, useLocation } from "wouter";
import { useEffect, useState, useRef } from "react";
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
import { LegalIndexPage } from "@/pages/LegalIndexPage";
import { LegalDocPage } from "@/pages/LegalDocPage";
import { AdminPage } from "@/pages/AdminPage";
import { RidesAdminPage } from "@/pages/RidesAdminPage";
import { BikesPage } from "@/pages/BikesPage";
import { UsersPage } from "@/pages/UsersPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import { MapEditorPage } from "@/pages/MapEditorPage";
import { ParkingsPage } from "@/pages/ParkingsPage";
import { OperationsMapPage } from "@/pages/OperationsMapPage";
import NotFound from "@/pages/not-found";

// OverlayRouter — renders customer pages as a fixed overlay on top of the map.
//
// Two exit paths:
//   1. Button tap  → child dispatches "overlay:back" custom event
//   2. iOS edge-swipe / browser back → fires "popstate" before URL changes
//
// In both cases we play slide-down (0.3s) then let the navigation complete.
// While exiting, MapPage is already visible underneath (no black flash).
function OverlayRouter({ loc, isOverlay }: { loc: string; isOverlay: boolean }) {
  const [visible, setVisible] = useState(isOverlay);
  const [exiting, setExiting] = useState(false);
  const exitingRef = useRef(false); // stable ref so event handlers don't close over stale state

  const startExit = (thenNavigate?: () => void) => {
    if (exitingRef.current) return; // already animating
    exitingRef.current = true;
    setExiting(true);
    setTimeout(() => {
      exitingRef.current = false;
      setExiting(false);
      setVisible(false);
      thenNavigate?.();
    }, 300);
  };

  // On enter: reset
  useEffect(() => {
    if (isOverlay) {
      setVisible(true);
      setExiting(false);
      exitingRef.current = false;
    }
  }, [isOverlay, loc]);

  // 1. Button-driven back: child dispatches "overlay:back"
  useEffect(() => {
    const handler = () => {
      startExit(() => window.history.back());
    };
    window.addEventListener("overlay:back", handler);
    return () => window.removeEventListener("overlay:back", handler);
  }, []);

  // 2. iOS edge-swipe / browser back (popstate fires BEFORE URL changes in
  //    some browsers, or simultaneously). We push a synthetic history entry on
  //    mount so there is always one step to intercept, then on popstate we
  //    animate-out and let the navigation proceed.
  useEffect(() => {
    if (!visible) return;
    // Push a guard entry so swipe-back has something to pop
    window.history.pushState({ overlayGuard: true }, "");

    const onPopState = (e: PopStateEvent) => {
      // If we caused this pop by calling history.back() ourselves, ignore it
      if (exitingRef.current) return;
      // Animate, then allow the URL change to settle naturally
      setExiting(true);
      exitingRef.current = true;
      setTimeout(() => {
        exitingRef.current = false;
        setExiting(false);
        setVisible(false);
      }, 300);
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className={`fixed inset-0 z-50 ${exiting ? "animate-slide-down" : "animate-slide-up"}`}>
      <Switch>
        <Route path="/settings" component={SettingsPage} />
        <Route path="/rides" component={RidesPage} />
        <Route path="/payment-methods" component={PaymentMethodsPage} />
        <Route path="/support" component={SupportPage} />
        <Route path="/safety" component={SafetyPage} />
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

function AppRouter() {
  const [loc] = useLocation();
  const isHome = loc === "/" || loc.startsWith("/bike/");
  // Check if current route is an overlay (customer page over map)
  const isOverlay = OVERLAY_ROUTES.some(r => loc === r || loc.startsWith(r + "/"));
  return (
    <>
      {/* MapPage: always mounted (keeps Yandex Map alive).
          Visible on home AND on overlay routes — overlays sit at z-50 on top,
          so the map is already rendered when the exit animation plays. */}
      <div style={{ display: isHome || isOverlay ? "contents" : "none" }} aria-hidden={!isHome && !isOverlay}>
        <MapPage />
      </div>

      {/* Overlay customer pages — rendered as fixed layer on top of map with slide-up/down animation */}
      <OverlayRouter loc={loc} isOverlay={isOverlay} />

    <Switch>
      {/* Customer / rider interface */}
      <Route path="/"><></></Route>
      {/* QR deep link: a scanned bike URL (".../bike/BC-001") lands here, is
          stashed, and redirects to the map which auto-opens the rental flow. */}
      <Route path="/bike/:id">{(params) => <BikeDeepLink id={params.id} />}</Route>
      <Route path="/rent"><></></Route>
      <Route path="/tariffs"><></></Route>
      <Route path="/rides"><></></Route>
      <Route path="/profile" component={ProfilePage} />
      <Route path="/payment-methods"><></></Route>
      <Route path="/payment-result"><></></Route>
      <Route path="/settings"><></></Route>
      <Route path="/support"><></></Route>
      <Route path="/safety"><></></Route>

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

      {/* Legacy admin deep-links — redirect to the namespaced routes */}
      <Route path="/analytics"><Redirect to="/admin/analytics" /></Route>
      <Route path="/maintenance"><Redirect to="/admin/maintenance" /></Route>

      <Route component={NotFound} />
    </Switch>
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
