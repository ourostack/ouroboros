import { readFileSync } from "fs"
import { join } from "path"

import { describe, expect, it } from "vitest"

describe("release trust bootstrap coverage contract", () => {
  it("runs protected V8 and per-slice LLVM coverage on both macOS architectures", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "coverage.yml"), "utf8")

    expect(workflow).toContain("trust-coverage")
    expect(workflow).toContain("macos-26")
    expect(workflow).toContain("macos-26-intel")
    expect(workflow).toContain("developer-id-pair-canary/driver.c")
    expect(workflow).toContain("developer-id-signing/driver.c")
    expect(workflow).toContain("-fprofile-instr-generate")
    expect(workflow).toContain("-fcoverage-mapping")
    expect(workflow).toContain("llvm-profdata")
    expect(workflow).toContain("llvm-cov")
    expect(workflow).toMatch(/lines[^\n]*100/i)
    expect(workflow).toMatch(/branches[^\n]*100/i)
    expect(workflow).toMatch(/functions[^\n]*100/i)
  })

  it("collects all four non-packaged trust actions in V8 coverage", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "coverage.yml"), "utf8")
    const actionPaths = [
      ".github/actions/release-trust/canonicalize.mjs",
      ".github/actions/release-trust/protected-store.mjs",
      ".github/actions/release-trust/workflow-closure.mjs",
      ".github/actions/release-trust/run-reconciliation.mjs",
    ]

    for (const actionPath of actionPaths) {
      expect(workflow).toContain(actionPath)
    }
    expect(workflow).toContain("--coverage")
    expect(workflow).toContain("100")
  })
})
