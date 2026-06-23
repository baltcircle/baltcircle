import { Link, useLocation } from "wouter";
import { Logo } from "./Logo";
import { useTheme } from "@/lib/theme";
import { useAppViewport } from "@/hooks/use-app-viewport";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { UserRole } from "@shared/schema";
import {
  Map, QrCode, Route, ShieldCheck, Wrench, BarChart3,
  Sun, Moon, Bike, ChevronRight, ArrowLeft, User, Users, MapPin, Crosshair,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Map;
  testId: string;
  // Roles allowed to see this entry. Omitted = all staff roles. A mechanic only
  // sees the service + fleet entries; everything else is operator/admin.
  roles?: UserRole[];
}

// Customer / rider interface — the default experience. Tariffs are not exposed
// in the customer nav; they surface only inside the scan / rental flow.
const RIDER_NAV: NavItem[] = [
  { href: "/",        label: "Карта",   icon: Map,    testId: "nav-map" },
  { href: "/rent",    label: "Аренда",  icon: QrCode, testId: "nav-rent" },
  { href: "/rides",   label: "Поездки", icon: Route,  testId: "nav-rides" },
];

// Operator / admin interface — separated under /admin. `roles` narrows an entry
// to specific staff roles; entries without it are operator/admin only.
const OPS_NAV: NavItem[] = [
  { href: "/admin",             label: "Дашборд",      icon: ShieldCheck, testId: "nav-admin",       roles: ["operator", "admin"] },
  { href: "/admin/bikes",       label: "Велосипеды",   icon: Bike,        testId: "nav-bikes",       roles: ["mechanic", "operator", "admin"] },
  { href: "/admin/rides",       label: "Поездки",      icon: Route,       testId: "nav-admin-rides", roles: ["operator", "admin"] },
  { href: "/admin/users",       label: "Пользователи", icon: Users,       testId: "nav-users",       roles: ["operator", "admin"] },
  { href: "/admin/map",         label: "Карта",        icon: Map,         testId: "nav-map-editor",  roles: ["operator", "admin"] },
  { href: "/admin/operations-map", label: "Оперкарта",  icon: Crosshair,  testId: "nav-operations-map", roles: ["operator", "admin"] },
  { href: "/admin/parkings",    label: "Парковки",     icon: MapPin,      testId: "nav-parkings",    roles: ["operator", "admin"] },
  { href: "/admin/analytics",   label: "Аналитика",    icon: BarChart3,   testId: "nav-analytics",   roles: ["operator", "admin"] },
  { href: "/admin/maintenance", label: "Сервис",       icon: Wrench,      testId: "nav-maintenance", roles: ["mechanic", "operator", "admin"] },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [loc] = useLocation();
  const { theme, toggle } = useTheme();
  // Hide operator entry points until the session resolves and the role is
  // known to be operator/admin. Defaulting to hidden avoids a flash of the
  // admin link for unregistered or regular riders.
  const { isStaff, role } = useCurrentUser();

  const isAdmin = loc === "/admin" || loc.startsWith("/admin/");
  // Mechanics see a trimmed operator nav (service + fleet only); operators and
  // admins see the full set. Riders use the customer nav.
  const opsNav = OPS_NAV.filter((item) => !item.roles || (role != null && item.roles.includes(role)));
  const nav = isAdmin ? opsNav : RIDER_NAV;
  // Where the operator entry points should land. Mechanics can't open the
  // dashboard, so send them to the first section they're allowed to see.
  const opsHome = opsNav[0]?.href ?? "/admin";
  const matchActive = (href: string) =>
    href === "/" ? loc === "/" : loc === href || loc.startsWith(href + "/");

  // The customer map page is a single-screen, non-scrolling layout: lock the
  // shell to the exact visible viewport and clip overflow. All other routes
  // (admin, profile, tariffs, …) keep the default min-h-screen scroll behaviour.
  const isCustomerMap = loc === "/";
  useAppViewport(isCustomerMap);

  return (
    <div
      data-testid="app-shell"
      style={
        isCustomerMap
          ? { height: "var(--app-height, 100svh)" }
          : undefined
      }
      className={`flex flex-col lg:flex-row bg-background text-foreground ${
        isCustomerMap
          ? "h-[100svh] [@supports(height:100dvh)]:h-[100dvh] overflow-hidden"
          : "min-h-screen"
      }`}
    >
      {/* Sidebar — desktop */}
      <aside
        className="hidden lg:flex lg:flex-col w-64 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border"
        data-testid="sidebar"
      >
        <div className="px-5 py-6 border-b border-sidebar-border/40">
          <Link href={isAdmin ? opsHome : "/"} data-testid="link-home"><Logo /></Link>
          {isAdmin && (
            <div
              className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-sidebar-accent/60 px-2.5 py-1 text-[10px] uppercase tracking-[0.18em]"
              data-testid="admin-badge"
            >
              <ShieldCheck className="w-3 h-3" /> Операторская панель
            </div>
          )}
        </div>
        <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
          <SidebarGroup
            label={isAdmin ? "Операторская панель" : "Пользователь"}
            items={nav}
            isActive={matchActive}
          />
        </nav>
        <div className="px-3 py-4 border-t border-sidebar-border/40 space-y-2">
          {/* Cross-link between the two interfaces (no auth yet). */}
          {isAdmin ? (
            <Link
              href="/"
              data-testid="link-exit-admin"
              className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent hover-elevate"
            >
              <ArrowLeft className="w-4 h-4 opacity-80" /> К приложению
            </Link>
          ) : isStaff ? (
            <Link
              href={opsHome}
              data-testid="link-admin"
              className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent hover-elevate"
            >
              <ShieldCheck className="w-4 h-4 opacity-80" /> Операторская
            </Link>
          ) : null}
          <button
            onClick={toggle}
            className="w-full flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent hover-elevate"
            data-testid="button-theme-toggle"
          >
            <span className="flex items-center gap-2 opacity-90">
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              {theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            </span>
            <ChevronRight className="w-4 h-4 opacity-50" />
          </button>

          <div className="px-3 py-2 text-xs opacity-70">
            <div className="flex items-center gap-1.5"><Bike className="w-3 h-3" /> демо-аккаунт</div>
            <div className="mt-1 opacity-70">demo@takeride.ru</div>
          </div>
        </div>
      </aside>

      {/* Mobile top header — the customer map route renders its own floating
          header inside MapPage for a full-bleed, map-first look, so suppress
          this one there to avoid a doubled header. */}
      {!isCustomerMap && (
      <header className="lg:hidden sticky top-0 z-30 bg-sidebar text-sidebar-foreground border-b border-sidebar-border flex items-center justify-between px-4 h-14">
        <Link href={isAdmin ? opsHome : "/"} data-testid="link-home-mobile" className="flex items-center gap-2">
          <Logo />
          {isAdmin && <span className="text-[10px] uppercase tracking-[0.18em] opacity-80">Оператор</span>}
        </Link>
        <div className="flex items-center gap-1">
          {isAdmin ? (
            <>
              <button
                onClick={toggle}
                className="p-2 rounded-md hover-elevate"
                aria-label="Сменить тему"
                data-testid="button-theme-toggle-mobile"
              >
                {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              <Link
                href="/"
                data-testid="link-exit-admin-mobile"
                aria-label="К приложению"
                className="p-2 rounded-md hover-elevate"
              >
                <ArrowLeft className="w-5 h-5" />
              </Link>
            </>
          ) : (
            <>
              <button
                onClick={toggle}
                className="p-2 rounded-md hover-elevate"
                aria-label="Сменить тему"
                data-testid="button-theme-toggle-mobile"
              >
                {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              <Link
                href="javascript:history.back()"
                data-testid="link-back-mobile"
                aria-label="Назад"
                className="p-1 rounded-full hover-elevate"
                onClick={(e) => { e.preventDefault(); history.back(); }}
              >
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-sidebar-accent/70 text-sidebar-foreground">
                  <ArrowLeft className="w-5 h-5" />
                </span>
              </Link>
            </>
          )}
        </div>
      </header>
      )}

      {/* Customer UI is map-first with no bottom tabs; admin keeps tab bar. */}
      <main
        className={`flex-1 min-w-0 ${isAdmin ? "pb-24" : "pb-0"} lg:pb-0 ${
          isCustomerMap ? "min-h-0 overflow-hidden" : ""
        }`}
      >
        {children}
      </main>

      {/* Mobile bottom tabs — operator interface only. */}
      {isAdmin && (
        <nav
          className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-card border-t border-card-border h-16 flex px-1"
          data-testid="bottom-nav"
        >
          {nav.map(item => {
            const Icon = item.icon;
            const active = matchActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={item.testId + "-mobile"}
                className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] ${active ? "text-primary" : "text-muted-foreground"}`}
              >
                <Icon className="w-5 h-5" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}

function SidebarGroup({ label, items, isActive }: {
  label: string;
  items: NavItem[];
  isActive: (h: string) => boolean;
}) {
  return (
    <div>
      <div className="px-3 mb-2 text-[10px] uppercase tracking-[0.22em] opacity-60">{label}</div>
      <div className="space-y-0.5">
        {items.map(item => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={item.testId}
              className={[
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm hover-elevate",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80",
              ].join(" ")}
            >
              <Icon className={`w-4 h-4 ${active ? "text-sidebar-primary" : ""}`} />
              <span className="font-light">{item.label}</span>
              {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-sidebar-primary" />}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
