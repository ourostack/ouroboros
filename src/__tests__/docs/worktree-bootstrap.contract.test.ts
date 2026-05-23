import * as fs from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"

describe("worktree bootstrap contract", () => {
  it("provides an explicit dependency bootstrap command for fresh worktrees", () => {
    const packageJsonPath = path.resolve(process.cwd(), "package.json")
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))

    expect(packageJson.scripts["worktree:bootstrap"]).toBe("npm install --ignore-scripts")
  })

  it("rejects new npm exec installs by default", () => {
    const npmrcPath = path.resolve(process.cwd(), ".npmrc")
    const npmrc = fs.readFileSync(npmrcPath, "utf-8")

    expect(npmrc).toMatch(/^yes=false$/m)
  })

  it("makes cached transient Vitest runs fail with bootstrap guidance", () => {
    const unitConfig = fs.readFileSync(path.resolve(process.cwd(), "vitest.config.ts"), "utf-8")
    const integrationConfig = fs.readFileSync(
      path.resolve(process.cwd(), "vitest.integration.config.ts"),
      "utf-8",
    )

    for (const content of [unitConfig, integrationConfig]) {
      expect(content).toContain("loadLocalVitestDefineConfig")
      expect(content).toContain("npm run worktree:bootstrap")
      expect(content).toContain("repo-pinned toolchain")
    }
  })

  it("documents the bootstrap before local test commands", () => {
    const agentInstructions = fs.readFileSync(path.resolve(process.cwd(), "AGENTS.md"), "utf-8")
    const contributing = fs.readFileSync(path.resolve(process.cwd(), "CONTRIBUTING.md"), "utf-8")
    const testingConventions = fs.readFileSync(
      path.resolve(process.cwd(), "docs", "testing-conventions.md"),
      "utf-8",
    )

    for (const content of [agentInstructions, contributing, testingConventions]) {
      expect(content).toContain("npm run worktree:bootstrap")
    }
    expect(contributing).toContain("Do not run direct `npx vitest`")
    expect(testingConventions).toContain("Do not use direct `npx vitest`")
  })
})
