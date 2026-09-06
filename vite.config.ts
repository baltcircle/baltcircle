import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import path from "node:path";

// Идентификатор сборки: вшивается в бандл (__BUILD_ID__) и параллельно
// кладётся в /version.json. Клиент сравнивает одно с другим и понимает,
// что на сервере лежит более свежая версия. В CI приоритет у BUILD_ID,
// иначе берём git sha, и только в последнюю очередь время сборки —
// последнее даёт новый id на каждый билд, но хотя бы никогда не совпадает
// между разными версиями кода.
function resolveBuildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return String(Date.now());
  }
}

const BUILD_ID = resolveBuildId();

// Версия отдаётся отдельным маленьким файлом, а не эндпоинтом API:
// проверка обновлений не должна зависеть от сессии, базы или живого
// Node-процесса — достаточно того, что на диске лежит новая статика.
function buildVersionFile(): Plugin {
  return {
    name: "takeride-version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId: BUILD_ID, builtAt: new Date().toISOString() }),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildVersionFile()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  // "/" — absolute asset URLs. "./" ломается на nested deep-linkах
  // (например /bike/BC-001): браузер резолвит ./assets/... как
  // /bike/assets/... сервер отдаёт SPA-fallback index.html → MIME mismatch → белый экран.
  base: "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Split large, independent vendors into their own chunks so they cache
    // separately and don't bloat the main entry. Route-level code-splitting
    // (React.lazy) handles the page/feature code; this handles heavy libs.
    rollupOptions: {
      output: {
        // maplibre-gl + pmtiles are bundled (Vite emits the map worker
        // same-origin). Split them into their own chunk so the heavy map libs
        // cache separately and stay out of the main entry. recharts is admin-only.
        manualChunks: {
          "vendor-react": ["react", "react-dom", "wouter", "@tanstack/react-query"],
          "vendor-charts": ["recharts"],
          "vendor-map": ["maplibre-gl", "pmtiles"],
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
