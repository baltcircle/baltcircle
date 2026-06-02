import { Link, useLocation } from "wouter";
import { Logo } from "./Logo";
import { useTheme } from "@/lib/theme";
import {
  Map, QrCode, Wallet, Route, ShieldCheck, Wrench, BarChart3,
  Sun, Moon, Bike, ChevronRight,
} from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Map;
  group: "rider" | "ops";
  testId: string;
}
const NAV: NavItem[] = [
  { href: "/",          label: "Карта",        icon: Map,         group: "rider", testId: "nav-map" },
  { href: "/rent",      label: "Аренда",       icon: QrCode,      group: "rider", testId: "nav-rent" },
  { href: "/tariffs",   label: "Тарифы",       icon: Wallet,      group: "rider", testId: "nav-tariffs" },
  { href: "/rides",     label: "Поездки",      icon: Route,       group: "rider", testId: "nav-rides" },
  { href: "/admin",     label: "Парк",         icon: ShieldCheck, group: "ops",   testId: "nav-admin" },
  { href: "/analytics", label: "Аналитика",    icon: BarChart3,   group: "ops",   testId: "nav-analytics" },
  { href: "/maintenance", label: "Сервис",     icon: Wrench,      group: "ops",   testId: "nav-maintenance" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [loc] = useLocation();
  const { theme, toggle } = useTheme();
  const matchActive = (href: string) => href === "/" ? loc === "/" : loc.startsWith(href);

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-background text-foreground">
      {/* Sidebar — desktop */}
      <aside
        className="hidden lg:flex lg:flex-col w-64 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border"
        data-testid="sidebar"
      >
        <div className="px-5 py-6 border-b border-sidebar-border/40">
          <Link href="/" data-testid="link-home"><Logo /></Link>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
          <SidebarGroup label="Пользователь" items={NAV.filter(n => n.group === "rider")} isActive={matchActive} />
          <SidebarGroup label="Операционный центр" items={NAV.filter(n => n.group === "ops")} isActive={matchActive} />
        </nav>
        <div className="px-3 py-4 border-t border-sidebar-border/40 space-y-2">
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
            <div className="mt-1 opacity-70">demo@baltcircle.app</div>
          </div>
        </div>
      </aside>

      {/* Mobile top header */}
      <header className="lg:hidden sticky top-0 z-30 bg-sidebar text-sidebar-foreground border-b border-sidebar-border flex items-center justify-between px-4 h-14">
        <Link href="/" data-testid="link-home-mobile"><Logo /></Link>
        <button
          onClick={toggle}
          className="p-2 rounded-md hover-elevate"
          aria-label="Сменить тему"
          data-testid="button-theme-toggle-mobile"
        >
          {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </header>

      <main className="flex-1 min-w-0 pb-24 lg:pb-0">{children}</main>

      {/* Mobile bottom tabs */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-card border-t border-card-border h-16 grid grid-cols-5 px-1"
        data-testid="bottom-nav"
      >
        {[NAV[0], NAV[1], NAV[2], NAV[4], NAV[5]].map(item => {
          const Icon = item.icon;
          const active = matchActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              data-testid={item.testId + "-mobile"}
              className={`flex flex-col items-center justify-center gap-0.5 text-[10px] ${active ? "text-primary" : "text-muted-foreground"}`}
            >
              <Icon className="w-5 h-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
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
