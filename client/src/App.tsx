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
// Exit animation: pages dispatch "overlay:back" event → OverlayRouter plays
// slide-down for 300ms, then calls history.back() itself.
function OverlayRouter({ loc, isOverlay }: { loc: string; isOverlay: boolean }) {
  const [visible, setVisible] = useState(isOverlay);
  const [exiting, setExiting] = useState(false);

  // On enter: reset animation state
  useEffect(() => {
    if (isOverlay) {
      setVisible(true);
      setExiting(false);
    }
  }, [isOverlay, loc]);

  // Listen for back-navigation requests from child pages
  useEffect(() => {
    const handler = () => {
      if (!visible || exiting) return;
      setExiting(true);
      setTimeout(() => {
        setExiting(false);
        setVisible(false);
        window.history.back();
      }, 300);
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
      {/* MapPage is always mounted to keep Yandex Map alive */}
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
