import { createContext, useContext, useLayoutEffect, useState } from "react";
import { applyThemeChrome } from "./theme-chrome";

type Theme = "light" | "dark";
export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "baltcircle-theme";

function systemPrefersDark() {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

function resolve(mode: ThemeMode): Theme {
  if (mode === "system") return systemPrefersDark() ? "dark" : "light";
  return mode;
}

const ThemeContext = createContext<{
  theme: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}>({
  theme: "light",
  mode: "system",
  setMode: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [theme, setTheme] = useState<Theme>(() => resolve(readStoredMode()));

  // Apply the resolved theme to <html> and keep it in sync with both the
  // chosen mode and — when mode is "system" — the live OS preference.
  useLayoutEffect(() => {
    const apply = () => {
      const resolved = resolve(mode);
      setTheme(resolved);
      applyThemeChrome(resolved);
    };
    apply();

    if (mode !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    // Paint the guard, html backdrop and browser chrome in the same event,
    // without waiting for navigation or an effect after the next frame.
    const resolved = resolve(next);
    applyThemeChrome(resolved);
    setTheme(resolved);
    setModeState(next);
    try { window.localStorage?.setItem(STORAGE_KEY, next); } catch { /* storage may be blocked */ }
  };

  // toggle flips the resolved theme into an explicit light/dark mode.
  const toggle = () => setMode(theme === "dark" ? "light" : "dark");

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
