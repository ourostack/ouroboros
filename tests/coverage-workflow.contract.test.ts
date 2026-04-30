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
    const script = readFileSync(
      join(process.cwd(), "scripts", "release-preflight.cjs"),
      "utf8",
    )

    expect(script).toContain('file.startsWith("skills/")')
    expect(script).toContain('(file.startsWith("src/") && !file.startsWith("src/__tests__/"))')
  })

  it("runs the shared release preflight before coverage on pull requests", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )
    const packageJson = readFileSync(
      join(process.cwd(), "package.json"),
      "utf8",
    )

    expect(workflow).toContain("Release preflight (PRs only)")
    expect(workflow).toContain('npm run release:preflight -- --base-ref "origin/${{ github.base_ref }}"')
    expect(packageJson).toContain('"release:preflight": "node scripts/release-preflight.cjs"')
  })

  it("requires version bumps for packaged skill changes", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts", "release-preflight.cjs"),
      "utf8",
    )

    expect(script).toContain('file.startsWith("skills/")')
    expect(script).toContain("No releasable src/ or packaged skills changes detected — version bump not required")
  })

  it("publishes prereleases on their prerelease npm channel", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain("Resolve npm publish tag")
    expect(workflow).toContain("semver.prerelease(version)")
    expect(workflow).toContain('npm publish --access public --provenance --tag "$TAG"')
    expect(workflow).toContain('npm publish --access public --provenance --tag "${{ steps.publish-tag.outputs.tag }}"')
    expect(workflow).toContain('npm dist-tag add "@ouro.bot/cli@${LOCAL}" "$TAG"')
    expect(workflow).toContain('npm dist-tag add "ouro.bot@${LOCAL}" "$TAG"')
    expect(workflow).toContain('verify_tag "@ouro.bot/cli@${TAG}" "$LOCAL"')
    expect(workflow).toContain('verify_tag "ouro.bot@${TAG}" "$LOCAL"')
  })

  it("runs the mailbox-ui package typecheck and test suite before the root coverage gate continues", () => {
    const gate = readFileSync(
      join(process.cwd(), "scripts", "run-coverage-gate.cjs"),
      "utf8",
    )

    expect(gate).toContain('runNpm(["run", "typecheck:mailbox-ui"])')
    expect(gate).toContain("mailbox_ui_typecheck")
    expect(gate).toContain('runNpm(["run", "test:mailbox-ui"])')
    expect(gate).toContain("mailbox_ui_tests")

    const packageJson = readFileSync(
      join(process.cwd(), "package.json"),
      "utf8",
    )

    expect(packageJson).toContain('"typecheck:mailbox-ui": "tsc --noEmit -p packages/mailbox-ui/tsconfig.json"')
    expect(packageJson).toContain('"test:mailbox-ui": "npm test --prefix packages/mailbox-ui"')
  })
})
