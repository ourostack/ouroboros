import { readFileSync } from "fs"
import { join } from "path"

import { describe, expect, it } from "vitest"

describe("coverage workflow contract", () => {
  it("uploads run artifacts from the temp-run root and tolerates fast-fail skips", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain("Resolve Coverage Artifact Root")
    expect(workflow).toContain("join(tmpdir(), 'ouroboros-test-runs', 'ouroboros-agent-harness')")
    expect(workflow).toContain("path: ${{ env.COVERAGE_ARTIFACT_ROOT }}")
    expect(workflow).toContain("if-no-files-found: ignore")
    expect(workflow).not.toContain("${{ env.HOME }}/.agentstate/test-runs/ouroboros-agent-harness")
  })

  it("uses the current Node 24-compatible GitHub action majors", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain("uses: actions/checkout@v6")
    expect(workflow).toContain("uses: actions/setup-node@v6")
    expect(workflow).toContain("uses: actions/upload-artifact@v7")
    expect(workflow).not.toContain("uses: actions/checkout@v4")
    expect(workflow).not.toContain("uses: actions/setup-node@v4")
    expect(workflow).not.toContain("uses: actions/upload-artifact@v4")
  })

  it("requires version bumps for releasable src changes, not src test-only churn", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain('git diff --name-only "origin/${{ github.base_ref }}...HEAD" -- src/ skills/ ":(exclude)src/__tests__/**"')
    expect(workflow).toContain("grep -Eq '^(src/|skills/)'")
  })

  it("requires version bumps for packaged skill changes", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain('git diff --name-only "origin/${{ github.base_ref }}...HEAD" -- src/ skills/ ":(exclude)src/__tests__/**"')
    expect(workflow).toContain("grep -Eq '^(src/|skills/)'")
    expect(workflow).toContain("No releasable src/ or packaged skills changes detected — version bump not required")
  })

  it("publishes the CLI and bootstrap wrapper on the supported latest npm channel", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain("npm publish --access public --provenance --tag latest")
    expect(workflow).toContain('verify_tag "@ouro.bot/cli@latest" "$LOCAL"')
    expect(workflow).toContain('verify_tag "ouro.bot@latest" "$LOCAL"')
    expect(workflow).not.toContain("npm dist-tag add")
    expect(workflow).not.toContain("npm publish --access public --provenance --tag alpha")
    expect(workflow).not.toContain("@alpha")
  })

  it("runs the outlook-ui package typecheck and test suite before the root coverage gate continues", () => {
    const gate = readFileSync(
      join(process.cwd(), "scripts", "run-coverage-gate.cjs"),
      "utf8",
    )

    expect(gate).toContain('runNpm(["run", "typecheck:outlook-ui"])')
    expect(gate).toContain("outlook_ui_typecheck")
    expect(gate).toContain('runNpm(["run", "test:outlook-ui"])')
    expect(gate).toContain("outlook_ui_tests")

    const packageJson = readFileSync(
      join(process.cwd(), "package.json"),
      "utf8",
    )

    expect(packageJson).toContain('"typecheck:outlook-ui": "tsc --noEmit -p packages/outlook-ui/tsconfig.json"')
    expect(packageJson).toContain('"test:outlook-ui": "npm test --prefix packages/outlook-ui"')
  })
})
