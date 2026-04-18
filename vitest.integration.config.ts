import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@ouro.bot/cli/runOuroCli": path.resolve(__dirname, "src/heart/daemon/daemon-cli.ts"),
      "@ouro.bot/cli": path.resolve(__dirname, "src/heart/daemon/ouro-entry.ts"),
    },
  },
  test: {
    globals: true,
    include: ["src/__tests__/integration/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "packages/**", ".claude/**"],
    maxWorkers: 1,
    setupFiles: ["src/__tests__/nerves/global-capture.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
