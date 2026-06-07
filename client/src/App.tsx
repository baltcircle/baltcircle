import { Switch, Route, Router, Redirect } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
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
import { PrivacyPage } from "@/pages/PrivacyPage";
import { ConsentPage } from "@/pages/ConsentPage";
import { AdminPage } from "@/pages/AdminPage";
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
      <Route path="/rent" component={RentPage} />
      <Route path="/tariffs" component={TariffsPage} />
      <Route path="/rides" component={RidesPage} />
      <Route path="/profile" component={ProfilePage} />
      <Route path="/payment-methods" component={PaymentMethodsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/support" component={SupportPage} />
      <Route path="/safety" component={SafetyPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/consent" component={ConsentPage} />

      {/* Admin / operator interface — gated to operator/admin roles */}
      <Route path="/admin"><AdminGuard><AdminPage /></AdminGuard></Route>
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
