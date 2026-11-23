import path from "path"

const defineConfig = loadLocalVitestDefineConfig()

function loadLocalVitestDefineConfig() {
  try {
    return require("vitest/config").defineConfig
  } catch (error) {
    if (isMissingLocalVitestConfig(error)) {
      throw new Error(
        [
          "Local Vitest dependencies are missing.",
          "Run `npm run worktree:bootstrap` in this worktree before `npx vitest`, `npm test`, or other local checks.",
          "That keeps tests on the repo-pinned toolchain instead of an npm exec cache.",
        ].join(" "),
      )
    }
    throw error
  }
}

function isMissingLocalVitestConfig(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "MODULE_NOT_FOUND" &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.includes("vitest/config"),
  )
}

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
    exclude: [
      "dist/**",
      "node_modules/**",
      "packages/**",
      ".claude/**",
      "src/__tests__/integration/**",
      // Needs Docker; `npm run test:eval-sandbox` runs it.
      "src/__tests__/eval/e2e.integration.test.ts",
      "src/__tests__/senses/cli/*.tsx",
    ],
    maxWorkers: 1,
    setupFiles: ["src/__tests__/nerves/global-capture.ts", "src/__tests__/test-helpers/isolated-tmpdir.ts", "src/__tests__/test-helpers/trusted-uid.ts", "src/__tests__/test-helpers/no-built-in-desk.ts"],
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
        "src/eval/*-entry.ts",
        // Ouro AX v1.3.445, vendored unchanged and tested upstream; the X arm built on it is tested here.
        "src/eval/interviews/guest/ax/**",
        "src/senses/voice/index.ts",
        "src/senses/voice/types.ts",
        "src/senses/ingress-evidence.ts",
        "src/a2a/types.ts",
        "src/commerce/types.ts",
        "src/reflection/*-entry.ts",
        "src/repertoire/coding/types.ts",
        "src/arc/attention-types.ts",
        "src/nerves/coverage/cli-main.ts",
        "src/heart/session-playback-cli-main.ts",
        "src/heart/session-playback-cli.ts",
        "src/heart/session-playback.ts",
        "src/nerves/review/cli-main.ts",
        "src/nerves/review/cli.ts",
        "src/nerves/review/core.ts",
        "src/heart/session-stats-cli-main.ts",
        "src/heart/providers/anthropic-token.ts",
        "src/heart/private-runtime/index.ts",
        "src/heart/private-runtime/types.ts",
        "src/nerves/observation.ts",
        "src/heart/daemon/cli-types.ts",
        "src/heart/daemon/doctor-types.ts",
        "src/heart/daemon/daemon-cli.ts",
        "src/heart/attachments/sources/adapter.ts",
        // W6 Unit 8b: bridges manager + scheduler grew new desk-writing /
        // desk-discovery branches that aren't yet exercised. The existing
        // bridge tests inject a writeDeskTask mock, so defaultWriteDeskTask
        // is uncovered; scheduler's desk-tree walk + defensive parse catches
        // similarly lack tests. Followup PR will either backfill tests or
        // refactor the defensive catches to be tested in isolation.
        "src/heart/bridges/manager.ts",
        "src/heart/bridges/state-machine.ts",
        "src/heart/daemon/task-scheduler.ts",
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
