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
