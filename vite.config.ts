import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
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
