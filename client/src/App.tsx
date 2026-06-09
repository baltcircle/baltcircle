import { Switch, Route, Router, Redirect, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { useEffect } from "react";
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
import { SettingsPage } from "@/pages/SettingsPage";
import { SupportPage } from "@/pages/SupportPage";
import { SafetyPage } from "@/pages/SafetyPage";
import { LegalIndexPage } from "@/pages/LegalIndexPage";
import { LegalDocPage } from "@/pages/LegalDocPage";
import { AdminPage } from "@/pages/AdminPage";
import { BikesPage } from "@/pages/BikesPage";
import { UsersPage } from "@/pages/UsersPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import { MapEditorPage } from "@/pages/MapEditorPage";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <Switch>
      {/* Customer / rider interface */}
      <Route path="/" component={MapPage} />
      {/* QR deep link: a scanned bike URL (".../#/bike/BC-001") lands here, is
          stashed, and redirects to the map which auto-opens the rental flow. */}
      <Route path="/bike/:id">{(params) => <BikeDeepLink id={params.id} />}</Route>
      <Route path="/rent" component={RentPage} />
      <Route path="/tariffs" component={TariffsPage} />
      <Route path="/rides" component={RidesPage} />
      <Route path="/profile" component={ProfilePage} />
      <Route path="/payment-methods" component={PaymentMethodsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/support" component={SupportPage} />
      <Route path="/safety" component={SafetyPage} />

      {/* Legal documents */}
      <Route path="/legal" component={LegalIndexPage} />
      <Route path="/legal/:slug">{(params) => <LegalDocPage slug={params.slug} />}</Route>

      {/* Legacy legal routes — keep existing registration links working */}
      <Route path="/privacy"><Redirect to="/legal/privacy" /></Route>
      <Route path="/consent"><Redirect to="/legal/consent" /></Route>

      {/* Admin / operator interface — gated to operator/admin roles */}
      <Route path="/admin"><AdminGuard><AdminPage /></AdminGuard></Route>
      <Route path="/admin/bikes"><AdminGuard><BikesPage /></AdminGuard></Route>
      <Route path="/admin/users"><AdminGuard><UsersPage /></AdminGuard></Route>
      <Route path="/admin/map"><AdminGuard><MapEditorPage /></AdminGuard></Route>
      <Route path="/admin/analytics"><AdminGuard><AnalyticsPage /></AdminGuard></Route>
      <Route path="/admin/maintenance"><AdminGuard><MaintenancePage /></AdminGuard></Route>

      {/* Legacy admin deep-links — redirect to the namespaced routes */}
      <Route path="/analytics"><Redirect to="/admin/analytics" /></Route>
      <Route path="/maintenance"><Redirect to="/admin/maintenance" /></Route>

      <Route component={NotFound} />
    </Switch>
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
          <Router hook={useHashLocation}>
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
