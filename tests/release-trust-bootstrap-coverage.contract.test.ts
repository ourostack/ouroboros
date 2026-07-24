import { execFileSync } from "child_process"
import { readFileSync } from "fs"
import { join } from "path"

import { describe, expect, it } from "vitest"

function loadCoverageWorkflow(): any {
  const source = readFileSync(join(process.cwd(), ".github", "workflows", "coverage.yml"), "utf8")
  return JSON.parse(execFileSync("ruby", [
    "-ryaml",
    "-rjson",
    "-e",
    "document = YAML.safe_load(STDIN.read, aliases: true); STDOUT.write(JSON.generate(document))",
  ], { input: source, encoding: "utf8" }))
}

describe("release trust bootstrap coverage contract", () => {
  it("runs protected V8 and per-slice LLVM coverage on both macOS architectures", () => {
    const workflow = loadCoverageWorkflow()
    const job = workflow.jobs["trust-coverage"]

    expect(job).toBeDefined()
    expect(job["runs-on"]).toBe("${{ matrix.runner }}")
    expect(job.permissions).toEqual({ contents: "read" })
    expect(job.strategy).toMatchObject({
      "fail-fast": false,
      matrix: { runner: ["macos-26", "macos-26-intel"] },
    })
    expect(job.environment).toBeUndefined()
    expect(job.steps.every((step: any) => step.if !== false && step.if !== "${{ false }}")).toBe(true)
    expect(job.steps.filter((step: any) => step.uses).every(
      (step: any) => /^[^\s@]+\/[^\s@]+@[a-f0-9]{40}$/.test(step.uses),
    )).toBe(true)

    const nativeStep = job.steps.find((step: any) => step.name === "Run native trust coverage")
    expect(nativeStep.env).toEqual({ OURO_NATIVE_COVERAGE: "1" })
    expect(nativeStep.run).toContain("tests/native/developer-id-pair-canary.test.ts")
    expect(nativeStep.run).toContain("tests/native/developer-id-signing.test.ts")
    expect(nativeStep.run).toContain("-fprofile-instr-generate")
    expect(nativeStep.run).toContain("-fcoverage-mapping")
    expect(nativeStep.run).toContain("llvm-profdata merge")
    expect(nativeStep.run).toContain("llvm-cov report")
    expect(nativeStep.run).toContain("--show-branch-summary")
    expect(nativeStep.run).toContain("lines: 100.00%")
    expect(nativeStep.run).toContain("branches: 100.00%")
    expect(nativeStep.run).toContain("functions: 100.00%")
  })

  it("collects all four non-packaged trust actions in V8 coverage", () => {
    const workflow = loadCoverageWorkflow()
    const job = workflow.jobs["trust-coverage"]
    const v8Step = job.steps.find((step: any) => step.name === "Run trust TCB V8 coverage")
    const actionPaths = [
      ".github/actions/release-trust/canonicalize.mjs",
      ".github/actions/release-trust/protected-store.mjs",
      ".github/actions/release-trust/workflow-closure.mjs",
      ".github/actions/release-trust/run-reconciliation.mjs",
    ]

    for (const actionPath of actionPaths) {
      expect(v8Step.run).toContain(`--coverage.include=${actionPath}`)
    }
    expect(v8Step.run).toContain("npm exec -- vitest run")
    expect(v8Step.run).toContain("--coverage.enabled=true")
    expect(v8Step.run).toContain("--coverage.thresholds.lines=100")
    expect(v8Step.run).toContain("--coverage.thresholds.branches=100")
    expect(v8Step.run).toContain("--coverage.thresholds.functions=100")
    expect(v8Step.run).toContain("--coverage.thresholds.statements=100")
  })
})
