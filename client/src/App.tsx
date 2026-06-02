import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { AppShell } from "@/components/AppShell";
import { MapPage } from "@/pages/MapPage";
import { RentPage } from "@/pages/RentPage";
import { TariffsPage } from "@/pages/TariffsPage";
import { RidesPage } from "@/pages/RidesPage";
import { AdminPage } from "@/pages/AdminPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import NotFound from "@/pages/not-found";

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={MapPage} />
      <Route path="/rent" component={RentPage} />
      <Route path="/tariffs" component={TariffsPage} />
      <Route path="/rides" component={RidesPage} />
      <Route path="/admin" component={AdminPage} />
      <Route path="/analytics" component={AnalyticsPage} />
      <Route path="/maintenance" component={MaintenancePage} />
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
