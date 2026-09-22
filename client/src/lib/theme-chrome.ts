// Shared by MapLibre and the browser backdrop. No map dependency in theme setup.
export const MAP_WATER_COLORS = {
  light: "#8ddbf6",
  dark: "#213782",
} as const;

export function applyThemeChrome(theme: keyof typeof MAP_WATER_COLORS, doc: Document = document) {
  const color = MAP_WATER_COLORS[theme];
  doc.documentElement.classList.toggle("dark", theme === "dark");
  doc.documentElement.style.setProperty("--map-water", color);
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = color;
}
