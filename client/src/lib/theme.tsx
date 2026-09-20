import { createContext, useContext, useLayoutEffect, useState } from "react";

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

function applyDocumentTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
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
  const [{ mode, theme }, setSelection] = useState(() => {
    const mode = readStoredMode();
    return { mode, theme: resolve(mode) };
  });

  // Apply the initial/system theme before paint. Mode and resolved theme are
  // one state, so the map cannot receive a new mode with the previous theme.
  useLayoutEffect(() => {
    const apply = () => {
      const resolved = resolve(mode);
      applyDocumentTheme(resolved);
      setSelection((current) => current.mode === mode && current.theme === resolved
        ? current
        : { mode, theme: resolved });
    };
    apply();

    if (mode !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mode]);

  const setMode = (next: ThemeMode) => {
    const resolved = resolve(next);
    // Update the live drawer/document in this handler, not a later effect.
    // React consumers (including the mounted map) receive both values together.
    applyDocumentTheme(resolved);
    setSelection({ mode: next, theme: resolved });
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked/full store must not prevent switching for this session.
    }
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
