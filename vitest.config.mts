import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    env: {
      DEMO_MODE: "true",
      // Embedded Postgres started by tests/global-setup.ts (port 5434, data dir .data/pg-test).
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5434/mergeport_test",
      MERGEPORT_DB: path.resolve(import.meta.dirname, ".data", "test.db"), // anchor path for the vault key file only
    },
  },
});
