import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit-test runner. Tests are colocated next to the code (*.test.ts) and mock the
// database layer, so no live Postgres is required to run them (audit H5).
export default defineConfig({
  test: {
    environment: "node",
    include: ["{server,shared,client}/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
