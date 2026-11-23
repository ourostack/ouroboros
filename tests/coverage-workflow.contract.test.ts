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

  it("holds a pull request's shards behind the yield job, and never waits or skips them on a push", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )
    const yieldJob = workflow.split("\n  yield:\n")[1].split("\n\n")[0]
    const shardJob = workflow.split("\n  coverage-shard:\n")[1].split("\n    steps:")[0]

    expect(yieldJob).toContain("if: github.event_name == 'pull_request'")
    expect(yieldJob).toContain("yield-to-default-branch/yield.mjs")
    expect(yieldJob).toContain("continue-on-error: true")
    expect(shardJob).toContain("needs: [yield]")
    expect(shardJob).toContain("needs.yield.result == 'success' || needs.yield.result == 'skipped'")
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

  // The release paths moved to scripts/release-paths.cjs, shared by the preflight and the release job on main.
  it("releases for releasable src changes, not src test-only churn", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts", "release-paths.cjs"),
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

  it("releases for packaged skill changes, and says when a change publishes nothing", () => {
    const paths = readFileSync(
      join(process.cwd(), "scripts", "release-paths.cjs"),
      "utf8",
    )
    const preflight = readFileSync(
      join(process.cwd(), "scripts", "release-preflight.cjs"),
      "utf8",
    )

    expect(paths).toContain('file.startsWith("skills/")')
    expect(preflight).toContain("no releasable changes: landing this publishes no new version")
  })

  it("publishes with the registry-safe npm channel selected before publish", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )
    const tagPolicy = readFileSync(
      join(process.cwd(), "scripts", "npm-dist-tag-policy.cjs"),
      "utf8",
    )

    expect(workflow).toContain("Resolve @ouro.bot/cli publish tag")
    expect(workflow).toContain("Resolve ouro.bot wrapper publish tag")
    expect(workflow).toContain('node scripts/npm-dist-tag-policy.cjs publish-tag "@ouro.bot/cli"')
    expect(workflow).toContain('node scripts/npm-dist-tag-policy.cjs publish-tag "ouro.bot"')
    expect(tagPolicy).toContain("could not read npm dist-tags")
    expect(tagPolicy).toContain("latest dist-tag points at stable")
    expect(tagPolicy).not.toContain("repair-latest-if-prerelease")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("contents: read")
    expect(workflow).toContain("node-version: 24")
    expect(workflow).toContain("package-manager-cache: false")
    expect(workflow).toContain("trusted publishing requires npm >=11.5.1 on Node >=22.14")
    expect(workflow).toContain('node scripts/npm-publish-idempotency.cjs publish "${{ steps.cli-publish-tag.outputs.tag }}"')
    expect(workflow).toContain('node ../../scripts/npm-publish-idempotency.cjs publish "${{ steps.wrapper-publish-tag.outputs.tag }}"')
    expect(workflow).toContain("lookupPublishedVersion(`ouro.bot@${localVersion}`)")
    expect(workflow).not.toContain("--provenance")
    expect(workflow).not.toContain("npm dist-tag add")
    expect(workflow).toContain('scripts/npm-verify-exact-version.sh "@ouro.bot/cli" "$LOCAL"')
    expect(workflow).toContain('scripts/npm-verify-exact-version.sh "ouro.bot" "$LOCAL"')
  })

  it("keeps npm trusted-publishing package repository metadata exact", () => {
    const cliPackage = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    )
    const wrapperPackage = JSON.parse(
      readFileSync(join(process.cwd(), "packages", "ouro.bot", "package.json"), "utf8"),
    )

    expect(cliPackage.repository).toEqual({
      type: "git",
      url: "git+https://github.com/ourostack/ouroboros.git",
    })
    expect(wrapperPackage.repository).toEqual({
      type: "git",
      url: "git+https://github.com/ourostack/ouroboros.git",
    })
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
