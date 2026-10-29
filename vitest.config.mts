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
      MERGEPORT_DB: path.resolve(import.meta.dirname, ".data", "test.db"),
    },
  },
});
