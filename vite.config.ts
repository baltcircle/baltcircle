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
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Split large, independent vendors into their own chunks so they cache
    // separately and don't bloat the main entry. Route-level code-splitting
    // (React.lazy) handles the page/feature code; this handles heavy libs.
    rollupOptions: {
      output: {
        // maplibre-gl loads from CDN at runtime (see MapLibreMap) so it is not
        // bundled. recharts is heavy and only used by the admin AnalyticsPage —
        // splitting it keeps it out of the rider entry.
        manualChunks: {
          "vendor-react": ["react", "react-dom", "wouter", "@tanstack/react-query"],
          "vendor-charts": ["recharts"],
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
