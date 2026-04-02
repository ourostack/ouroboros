import path from "path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Self-referencing package resolution: tests mock @ouro.bot/cli via
      // vi.doMock, but vitest still needs to resolve the package entry.
      // In CI, dist/ doesn't exist yet, so point to the source entry.
      "@ouro.bot/cli/runOuroCli": path.resolve(__dirname, "src/heart/daemon/daemon-cli.ts"),
      "@ouro.bot/cli": path.resolve(__dirname, "src/heart/daemon/ouro-entry.ts"),
    },
  },
  test: {
    globals: true,
    exclude: ["dist/**", "node_modules/**", "packages/**", ".claude/**", "src/__tests__/senses/cli/*.tsx"],
    maxWorkers: 1,
    setupFiles: ["src/__tests__/nerves/global-capture.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/**/*.d.ts",
        "src/**/*.tsx",
        "src/senses/cli/**",
        "src/senses/*-entry.ts",
        "src/reflection/*-entry.ts",
        "src/repertoire/coding/types.ts",
        "src/mind/friends/store.ts",
        "src/repertoire/tasks/types.ts",
        "src/nerves/coverage/cli-main.ts",
        "src/heart/providers/anthropic-token.ts",
        "src/nerves/observation.ts",
        "src/heart/daemon/outlook-render.ts",
      ],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
})
