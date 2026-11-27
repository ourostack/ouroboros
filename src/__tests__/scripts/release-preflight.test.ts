import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, expect, it, vi } from "vitest"

const {
  assessChangeNote,
  assessCommitVersions,
  assessLockfileVersionSync,
  assessReleaseVersionUnchanged,
  assessWrapperPublishSync,
  collectChangedFiles,
  classifyOperationalContractChange,
  parseArgs,
  pathRequiresChangelogFreshness,
  readBaseState,
  runReleasePreflightCli,
  runReleasePreflightCliIfMain,
  runReleasePreflight,
  runRootDependencyAudit,
  versionBumpRequired,
  wrapperPackageChanged,
} = require(path.resolve(__dirname, "../../../scripts/release-preflight.cjs"))
const {
  REQUIRED_PACKAGE_ASSET_PATHS,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

type ExecResponse = {
  changedFiles?: string[]
  workingTreeChangedFiles?: string[]
  untrackedFiles?: string[]
  baseCliVersion?: string
  baseChangelogVersions?: string[] | null
  existingNotes?: string[]
  tipNotes?: string[]
  auditOutput?: string
  auditFailureOutput?: string
  versionCommits?: Array<{ sha: string; subject: string; from: string; to: string }>
  baseNotes?: Record<string, string>
}

type ReadResponse = {
  cliVersion?: string
  packageLockVersion?: string
  shrinkwrapVersion?: string
  wrapperVersion?: string
  changelogVersion?: string
  changelogChanges?: string[]
  notes?: Record<string, string>
}

function makeExecSyncImpl(response: ExecResponse = {}) {
  return (command: string): string => {
    // --no-renames: a renamed file is its old path and its new one, so a moved note or README is seen leaving.
    if (command.startsWith('git diff --name-only --no-renames "') && command.includes("...HEAD")) {
      return (response.changedFiles ?? []).join("\n")
    }

    if (command === "git diff --name-only --no-renames HEAD") {
      return (response.workingTreeChangedFiles ?? []).join("\n")
    }

    if (command === "git ls-files --others --exclude-standard") {
      return (response.untrackedFiles ?? []).join("\n")
    }

    if (command.startsWith("git merge-base ")) {
      return "base-sha\n"
    }

    if (command === "git log -G '^  \"version\": ' --format=%H%x1f%s 'origin/main..HEAD' -- package.json") {
      return (response.versionCommits ?? []).map((commit) => `${commit.sha}\x1f${commit.subject}`).join("\n")
    }

    const versionCommit = (response.versionCommits ?? []).find((commit) => command === `git show '${commit.sha}:package.json'` || command === `git show '${commit.sha}^1:package.json'`)
    if (versionCommit) {
      return JSON.stringify({ version: command.includes("^1:") ? versionCommit.from : versionCommit.to })
    }

    if (command === "git show 'base-sha:package.json'") {
      return JSON.stringify({ version: response.baseCliVersion ?? "0.1.0-alpha.407" })
    }

    if (command === "git show 'base-sha:changelog.json'") {
      if (response.baseChangelogVersions === null) throw new Error("no changelog at base")
      return JSON.stringify({
        versions: (response.baseChangelogVersions ?? ["0.1.0-alpha.407"]).map((version) => ({ version, changes: ["x"] })),
      })
    }

    const baseNote = Object.entries(response.baseNotes ?? {}).find(([file]) => command === `git show 'base-sha:${file}'`)
    if (baseNote) return baseNote[1]

    if (command === "git ls-tree -r --name-only 'base-sha' -- changes/") {
      return (response.existingNotes ?? []).join("\n")
    }

    if (command === "git ls-tree -r --name-only 'origin/main' -- changes/") {
      return (response.tipNotes ?? response.existingNotes ?? []).join("\n")
    }

    if (command.includes("npm audit --audit-level=moderate") && !command.includes("--offline")) {
      if (response.auditFailureOutput) {
        const error = new Error("audit failed") as Error & { stdout: Buffer }
        error.stdout = Buffer.from(response.auditFailureOutput)
        throw error
      }
      return response.auditOutput ?? "found 0 vulnerabilities\n"
    }

    if (command.includes("npm audit --audit-level=moderate --offline")) {
      return response.auditOutput ?? "found 0 vulnerabilities\n"
    }

    throw new Error(`unexpected command: ${command}`)
  }
}

function makeReadFileSyncImpl(response: ReadResponse = {}) {
  const cliVersion = response.cliVersion ?? "0.1.0-alpha.407"
  const wrapperVersion = response.wrapperVersion ?? cliVersion
  const changelogVersion = response.changelogVersion ?? cliVersion
  const changelogChanges = response.changelogChanges ?? ["release metadata aligned"]

  return (filePath: string): string => {
    const note = Object.entries(response.notes ?? {}).find(([file]) => filePath.endsWith(`/${file}`))
    if (note) return note[1]

    if (filePath.endsWith("/packages/ouro.bot/package.json")) {
      return JSON.stringify({
        version: wrapperVersion,
        repository: {
          type: "git",
          url: "git+https://github.com/ourostack/ouroboros.git",
        },
      })
    }

    if (filePath.endsWith("/package.json")) {
      return JSON.stringify({
        version: cliVersion,
        repository: {
          type: "git",
          url: "git+https://github.com/ourostack/ouroboros.git",
        },
      })
    }

    if (filePath.endsWith("/package-lock.json")) {
      const version = response.packageLockVersion ?? cliVersion
      return JSON.stringify({ version, packages: { "": { version } } })
    }

    if (filePath.endsWith("/npm-shrinkwrap.json")) {
      const version = response.shrinkwrapVersion ?? cliVersion
      return JSON.stringify({ version, packages: { "": { version } } })
    }

    if (filePath.endsWith("/.github/workflows/coverage.yml")) {
      return `
publish:
  permissions:
    contents: read
    id-token: write
  steps:
    - uses: actions/setup-node@v6
      with:
        node-version: 24
        registry-url: https://registry.npmjs.org
        package-manager-cache: false
    - name: Verify npm trusted-publishing toolchain (trusted publishing requires npm >=11.5.1 on Node >=22.14)
      run: |
        const fallback = "11.6.4"
    - name: Publish @ouro.bot/cli
      run: node scripts/npm-publish-idempotency.cjs publish "\${{ steps.cli-publish-tag.outputs.tag }}"
    - name: Publish ouro.bot
      run: node ../../scripts/npm-publish-idempotency.cjs publish "\${{ steps.wrapper-publish-tag.outputs.tag }}"
    - name: Verify selected npm dist-tags
      run: echo "selected npm dist-tags verified"
`
    }

    if (filePath.endsWith("/changelog.json")) {
      return JSON.stringify({
        versions: [{ version: changelogVersion, changes: changelogChanges }],
      })
    }

    throw new Error(`unexpected file read: ${filePath}`)
  }
}

function makePackageRootWithRequiredAssets(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-preflight-assets-"))
  for (const relativePath of REQUIRED_PACKAGE_ASSET_PATHS) {
    const filePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "ok")
  }
  return root
}

describe("release-preflight", () => {
  it("checks the required source asset before build without weakening packed-artifact validation", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const compiled = path.join(packageRoot, "dist/heart/daemon/sanctuary-host-supervisor-entry.js")
    const source = path.join(packageRoot, "src/heart/daemon/sanctuary-host-supervisor-entry.ts")
    fs.unlinkSync(compiled)
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, "export {}")
    try {
      const result = runReleasePreflight({}, {
        execSyncImpl: makeExecSyncImpl(),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      })
      expect(result.ok).toBe(true)
      expect(result.messages.join("\n")).toContain("source checkout")
      const { validatePackageAssets } = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))
      expect(validatePackageAssets(packageRoot).ok).toBe(false)
    } finally { fs.rmSync(packageRoot, { recursive: true, force: true }) }
  })

  it("flags releasable source and packaged skill changes but ignores src test churn", () => {
    expect(versionBumpRequired(["src/heart/daemon/daemon-cli.ts"])).toBe(true)
    expect(versionBumpRequired(["skills/work-planner/SKILL.md"])).toBe(true)
    expect(versionBumpRequired(["package.json"])).toBe(true)
    expect(versionBumpRequired(["scripts/package-assets.cjs"])).toBe(true)
    expect(versionBumpRequired(["scripts/package-e2e.cjs"])).toBe(true)
    expect(versionBumpRequired(["scripts/release-preflight.cjs"])).toBe(true)
    expect(versionBumpRequired(["scripts/release-smoke.cjs"])).toBe(true)
    expect(versionBumpRequired(["deploy/unraid/Dockerfile"])).toBe(true)
    expect(versionBumpRequired(["src/__tests__/scripts/changelog-gate.test.ts"])).toBe(false)
  })

  it("releases a change to any other file the package or image ships, such as a lockfile-only security fix", () => {
    for (const file of ["npm-shrinkwrap.json", "package-lock.json", "SerpentGuide.ouro/agent.json", "RepairGuide.ouro/psyche/SOUL.md", "assets/ouroboros.png"]) {
      expect(versionBumpRequired([file])).toBe(true)
    }
    expect(versionBumpRequired(["SerpentGuideNotes.md", "assetsplan.md"])).toBe(false)
  })

  it("ships nothing from a workspace package other than the ouro.bot wrapper", () => {
    expect(versionBumpRequired(["packages/some-ui/src/style.css", "packages/some-ui/index.html"])).toBe(false)
    expect(pathRequiresChangelogFreshness("packages/some-ui/src/style.css")).toBe(false)
  })

  it("flags implementation paths that require a fresh changelog entry", () => {
    expect(pathRequiresChangelogFreshness("src/heart/daemon/daemon-cli.ts")).toBe(true)
    expect(pathRequiresChangelogFreshness("scripts/release-preflight.cjs")).toBe(true)
    expect(pathRequiresChangelogFreshness("skills/work-planner/SKILL.md")).toBe(true)
    expect(pathRequiresChangelogFreshness("deploy/unraid/Dockerfile")).toBe(true)
    expect(pathRequiresChangelogFreshness("packages/ouro.bot/index.js")).toBe(true)
    expect(pathRequiresChangelogFreshness("packages/ouro.bot/package.json")).toBe(false)
    expect(pathRequiresChangelogFreshness("src/__tests__/scripts/release-preflight.test.ts")).toBe(false)
  })

  it("requires both lockfiles and their root records to match the CLI version", () => {
    const aligned = { version: "0.1.0-alpha.736", packages: { "": { version: "0.1.0-alpha.736" } } }
    expect(assessLockfileVersionSync("0.1.0-alpha.736", aligned, aligned)).toEqual({
      ok: true,
      message: "lockfile versions aligned (0.1.0-alpha.736)",
    })
    expect(assessLockfileVersionSync(
      "0.1.0-alpha.736",
      aligned,
      { version: "0.1.0-alpha.735", packages: { "": { version: "0.1.0-alpha.735" } } },
    ).ok).toBe(false)
  })

  it("requires a value for --base-ref", () => {
    expect(() => parseArgs(["--base-ref"])).toThrow("--base-ref requires a value")
  })

  it("classifies persisted RSVP operational contracts for release preflight visibility", () => {
    expect(classifyOperationalContractChange("src/rsvp/snapshot.ts")).toEqual({
      kind: "persisted-schema",
      message: "persisted schema changed: src/rsvp/snapshot.ts",
    })
    expect(classifyOperationalContractChange("src/senses/bluebubbles/semantic-receipts.ts")).toEqual({
      kind: "persisted-schema",
      message: "persisted schema changed: src/senses/bluebubbles/semantic-receipts.ts",
    })
    expect(classifyOperationalContractChange("src/__fixtures__/rsvp/july-9-context/manifest.json")).toEqual({
      kind: "replay-fixture",
      message: "replay fixture changed: src/__fixtures__/rsvp/july-9-context/manifest.json",
    })
    expect(classifyOperationalContractChange("fixtures/rsvp.fixture.json")).toEqual({
      kind: "replay-fixture",
      message: "replay fixture changed: fixtures/rsvp.fixture.json",
    })
    expect(classifyOperationalContractChange("fixtures/voice.trace.json")).toEqual({
      kind: "replay-fixture",
      message: "replay fixture changed: fixtures/voice.trace.json",
    })
    expect(classifyOperationalContractChange("src/heart/daemon/doctor.ts")).toEqual({
      kind: "doctor-category",
      message: "doctor category/check surface changed: src/heart/daemon/doctor.ts",
    })
    expect(classifyOperationalContractChange("src/rsvp/diagnostics.ts")).toEqual({
      kind: "doctor-category",
      message: "doctor category/check surface changed: src/rsvp/diagnostics.ts",
    })
    expect(classifyOperationalContractChange("src/rsvp/incident-bundle.ts")).toEqual({
      kind: "doctor-category",
      message: "doctor category/check surface changed: src/rsvp/incident-bundle.ts",
    })
    expect(classifyOperationalContractChange("docs/testing-guide.md")).toBeNull()
  })

  it("detects wrapper package changes separately from general release bumps", () => {
    expect(wrapperPackageChanged(["packages/ouro.bot/index.js"])).toBe(true)
    expect(wrapperPackageChanged(["src/heart/daemon/daemon-cli.ts"])).toBe(false)
    expect(wrapperPackageChanged([])).toBe(false)
  })

  it("collects committed, working-tree, and untracked changes for local preflight runs", () => {
    const changedFiles = collectChangedFiles("origin/main", makeExecSyncImpl({
      changedFiles: ["docs/agent-mail-setup.md", "src/heart/daemon/daemon-cli.ts"],
      workingTreeChangedFiles: ["src/heart/daemon/daemon-cli.ts", "src/mailroom/core.ts"],
      untrackedFiles: ["skills/mail/SKILL.md"],
    }))

    expect(changedFiles).toEqual([
      "docs/agent-mail-setup.md",
      "skills/mail/SKILL.md",
      "src/heart/daemon/daemon-cli.ts",
      "src/mailroom/core.ts",
    ])
  })

  it("passes when only docs changed and the changelog entry exists", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(true)
    expect(result.messages).toContain("no releasable changes: landing this publishes no new version")
    expect(result.messages).toContain("changelog gate: pass (0.1.0-alpha.407)")
    expect(result.messages).toContain("wrapper package unchanged")
    expect(result.messages).toContain("root npm audit: pass (found 0 vulnerabilities)")
    expect(result.messages).toContain("package assets verified")
    expect(result.messages.join("\n")).toContain("npm trusted-publisher local contract:")
  })

  it("can run with repo default read paths and package root", () => {
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
        }),
      },
    )

    expect(result.baseRef).toBe("origin/main")
    expect(result.changedFiles).toContain("docs/auth-and-providers.md")
    expect(result.messages).toContain("wrapper package unchanged")
  })

  it("surfaces RSVP persisted schema, replay fixture, and doctor category contract changes", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: [
            "src/rsvp/snapshot.ts",
            "src/__fixtures__/rsvp/july-9-context/manifest.json",
            "src/heart/daemon/doctor.ts",
            "changelog.json",
          ],
        }),
        readFileSyncImpl: makeReadFileSyncImpl({
          changelogChanges: ["RSVP operational contracts updated"],
        }),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.messages).toContain("operational contracts: persisted-schema, replay-fixture, doctor-category")
    expect(result.messages).toContain("persisted schema changed: src/rsvp/snapshot.ts")
    expect(result.messages).toContain("replay fixture changed: src/__fixtures__/rsvp/july-9-context/manifest.json")
    expect(result.messages).toContain("doctor category/check surface changed: src/heart/daemon/doctor.ts")
  })

  it("fails when the root npm dependency audit reports moderate-or-higher vulnerabilities", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
          auditFailureOutput: [
            "# npm audit report",
            "uuid  <11.1.1",
            "3 moderate severity vulnerabilities",
          ].join("\n"),
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("root npm audit failed")
    expect(result.errors.join("\n")).toContain("3 moderate severity vulnerabilities")
  })

  it("summarizes json npm audit vulnerabilities when the registry reports advisories", () => {
    const result = runRootDependencyAudit("/tmp/ouro", () => {
      const error = new Error("audit failed") as Error & { stdout: Buffer }
      error.stdout = Buffer.from(JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: {
          vite: {
            severity: "moderate",
            via: [{ title: "Vite development server vulnerability" }],
          },
        },
        metadata: {
          vulnerabilities: {
            moderate: 1,
            high: 0,
            critical: 0,
            total: 1,
          },
        },
      }))
      throw error
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("npm audit reported 1 moderate, 0 high, 0 critical vulnerabilities")
    expect(result.message).toContain("vite: moderate (Vite development server vulnerability)")
  })

  it("passes only when every reported advisory has an unexpired reviewed exception", () => {
    const report = (urls: string[]) => () => {
      const error = new Error("audit failed") as Error & { stdout: Buffer }
      error.stdout = Buffer.from(JSON.stringify({
        vulnerabilities: {
          "node-forge": { severity: "high", via: urls.map((url) => ({ title: "forge", url })) },
          "@bitwarden/cli": { severity: "high", via: ["node-forge"] },
        },
        metadata: { vulnerabilities: { moderate: 0, high: 2, critical: 0, total: 2 } },
      }))
      throw error
    }
    const exceptions = [{ advisory: "https://github.com/advisories/GHSA-a", package: "node-forge", reason: "no patched release", due: "2026-11-01" }]
    expect(runRootDependencyAudit("/tmp/ouro", report(["https://github.com/advisories/GHSA-a"]), { exceptions, today: "2026-10-02" }))
      .toEqual({ ok: true, message: "root npm audit: pass (accepted by docs/audit-exceptions.json: https://github.com/advisories/GHSA-a)" })
    expect(runRootDependencyAudit("/tmp/ouro", report(["https://github.com/advisories/GHSA-a"]), { exceptions, today: "2026-11-01" }).ok).toBe(false)
    expect(runRootDependencyAudit("/tmp/ouro", report(["https://github.com/advisories/GHSA-a"]), { exceptions, today: "2026-11-02" }).ok).toBe(false)
    expect(runRootDependencyAudit("/tmp/ouro", report(["https://github.com/advisories/GHSA-a"]), { exceptions: [{ ...exceptions[0], package: "another-package" }], today: "2026-10-02" }).ok).toBe(false)
    expect(runRootDependencyAudit("/tmp/ouro", report(["https://github.com/advisories/GHSA-a", "https://github.com/advisories/GHSA-b"]), { exceptions, today: "2026-10-02" }).ok).toBe(false)
    expect(runRootDependencyAudit("/tmp/ouro", report([]), { exceptions, today: "2026-10-02" }).ok).toBe(false)
  })

  it("binds an exception to the advisory's source dependency even when npm propagates it to another package", () => {
    const report = (name: string) => () => {
      const error = new Error("audit failed") as Error & { stdout: Buffer }
      error.stdout = Buffer.from(JSON.stringify({ vulnerabilities: {
        consumer: { severity: "high", via: [{ name, url: "https://github.com/advisories/GHSA-a" }] },
      } }))
      throw error
    }
    const exceptions = [{ advisory: "https://github.com/advisories/GHSA-a", package: "picomatch", reason: "no patched release", due: "2026-11-24" }]
    expect(runRootDependencyAudit("/tmp/ouro", report("picomatch"), { exceptions, today: "2026-11-17" }).ok).toBe(true)
    expect(runRootDependencyAudit("/tmp/ouro", report("other-package"), { exceptions, today: "2026-11-17" }).ok).toBe(false)
  })

  it("reads reviewed audit exceptions from the package root and ignores malformed entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-exceptions-"))
    try {
      const fail = () => {
        const error = new Error("audit failed") as Error & { stdout: Buffer }
        error.stdout = Buffer.from(JSON.stringify({ vulnerabilities: { x: { severity: "high", via: [{ title: "x" }] } } }))
        throw error
      }
      expect(runRootDependencyAudit(root, fail, { today: "2026-10-02" }).ok).toBe(false)
      fs.mkdirSync(path.join(root, "docs"))
      fs.writeFileSync(path.join(root, "docs", "audit-exceptions.json"), JSON.stringify({ items: [
        { advisory: "(advisory without url)", package: "x", reason: "reviewed", due: "2026-12-01" },
        { advisory: "https://example/a", reason: "", due: "2026-12-01" },
        { advisory: "https://example/b", reason: "r", due: "soon" },
      ] }))
      expect(runRootDependencyAudit(root, fail, { today: "2026-10-02" }).ok).toBe(true)
      for (const invalid of [{ package: "" }, { package: undefined }, { due: "2026-02-30" }]) {
        fs.writeFileSync(path.join(root, "docs", "audit-exceptions.json"), JSON.stringify({ items: [
          { advisory: "(advisory without url)", package: "x", reason: "reviewed", due: "2026-12-01", ...invalid },
        ] }))
        expect(runRootDependencyAudit(root, fail, { today: "2026-10-02" }).ok).toBe(false)
      }
      fs.writeFileSync(path.join(root, "docs", "audit-exceptions.json"), JSON.stringify({}))
      expect(runRootDependencyAudit(root, fail, { today: "2026-10-02" }).ok).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("reports root npm audit failures even when npm prints no details", () => {
    const result = runRootDependencyAudit("/tmp/ouro", () => {
      throw new Error("audit failed")
    })

    expect(result).toEqual({
      ok: false,
      message: "root npm audit failed: npm audit --audit-level=moderate reported vulnerable dependencies",
    })
  })

  it("bounds the root npm dependency audit so release preflight cannot hang forever", () => {
    const calls: Array<{ command: string; options: { timeout?: number } }> = []
    const result = runRootDependencyAudit("/tmp/ouro", (command: string, options: { timeout?: number }) => {
      calls.push({ command, options })
      if (command.includes("--offline")) return "found 0 vulnerabilities\n"
      const error = new Error("audit timed out") as Error & { signal?: string }
      error.signal = "SIGTERM"
      throw error
    })

    expect(calls).toEqual([
      {
        command: expect.stringContaining("timeout 120s npm audit --audit-level=moderate"),
        options: expect.objectContaining({ timeout: 130_000 }),
      },
      {
        command: expect.stringContaining("timeout 120s npm audit --audit-level=moderate --offline"),
        options: expect.objectContaining({ timeout: 130_000 }),
      },
    ])
    expect(result).toEqual({
      ok: true,
      message: "root npm audit: pass (found 0 vulnerabilities; offline cache fallback after registry timeout)",
    })
  })

  it("treats shell timeout exit status as an audit endpoint timeout", () => {
    const result = runRootDependencyAudit("/tmp/ouro", (command: string) => {
      if (command.includes("--offline")) return JSON.stringify({
        metadata: { vulnerabilities: { total: 0 } },
        vulnerabilities: {},
      })
      const error = new Error("audit command timed out") as Error & { status?: number }
      error.status = 124
      throw error
    })

    expect(result).toEqual({
      ok: true,
      message: "root npm audit: pass (found 0 vulnerabilities; offline cache fallback after registry timeout)",
    })
  })

  it("keeps release preflight visible but non-blocking when the audit endpoint and offline fallback are unavailable", () => {
    const result = runRootDependencyAudit("/tmp/ouro", (command: string) => {
      const error = new Error(`${command} failed`) as Error & { signal?: string }
      if (!command.includes("--offline")) error.signal = "SIGTERM"
      throw error
    })

    expect(result).toEqual({
      ok: true,
      message: "root npm audit: unavailable (registry audit endpoint timed out and offline fallback failed)",
    })
  })

  it("fails when release preflight package assets are missing", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-preflight-assets-"))
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("missing required package assets")
  })

  it("fails when the npm trusted-publisher local contract is invalid", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
        }),
        readFileSyncImpl: (filePath: string) => {
          if (filePath.endsWith("/.github/workflows/coverage.yml")) {
            return "publish:\n  permissions:\n    contents: read\n"
          }
          return makeReadFileSyncImpl()(filePath)
        },
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("coverage publish workflow must include id-token: write")
    expect(result.errors.join("\n")).toContain("coverage publish workflow must document the npm trusted publishing runtime floor")
  })

  function preflight(exec: ExecResponse, read: ReadResponse = {}) {
    const packageRoot = makePackageRootWithRequiredAssets()
    try {
      return runReleasePreflight({}, {
        execSyncImpl: makeExecSyncImpl(exec),
        readFileSyncImpl: makeReadFileSyncImpl(read),
        packageRoot,
      })
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true })
    }
  }

  it("passes releasable changes that carry a change note and leave the version alone, without asking npm", () => {
    const result = preflight(
      { changedFiles: ["src/heart/daemon/daemon-cli.ts", "changes/daemon-fix.md"] },
      { notes: { "changes/daemon-fix.md": "The daemon stops doing the wrong thing.\n" } },
    )

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.releasableChanged).toBe(true)
    expect(result.messages).toContain("releasable changes: the release job on main publishes the next version when this lands")
    expect(result.messages).toContain("release version: left to the release job on main (0.1.0-alpha.407)")
    expect(result.messages).toContain("change note: changes/daemon-fix.md")
  })

  it("fails a branch that bumps the version, with the one command that drops the bump", () => {
    const result = preflight(
      { changedFiles: ["src/heart/daemon/daemon-cli.ts", "changes/daemon-fix.md"], baseCliVersion: "0.1.0-alpha.406" },
      { notes: { "changes/daemon-fix.md": "Fix.\n" } },
    )

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain("package.json's version moved from 0.1.0-alpha.406 to 0.1.0-alpha.407")
    expect(result.errors[0]).toContain("npm run release:drop-bump")
    expect(result.errors[0]).toContain("git push --force-with-lease")
  })

  it("fails a branch with a commit that changes the version even when a later commit puts it back, since a rebase merge keeps both", () => {
    const result = preflight(
      {
        changedFiles: ["src/heart/daemon/daemon-cli.ts", "changes/daemon-fix.md"],
        versionCommits: [
          { sha: "b".repeat(40), subject: "drop the bump", from: "0.1.0-alpha.408", to: "0.1.0-alpha.407" },
          { sha: "a".repeat(40), subject: "Release 0.1.0-alpha.408", from: "0.1.0-alpha.407", to: "0.1.0-alpha.408" },
        ],
      },
      { notes: { "changes/daemon-fix.md": "Fix.\n" } },
    )

    expect(result.ok).toBe(false)
    const said = result.errors.join("\n")
    expect(said).toContain("aaaaaaaaaaaa (Release 0.1.0-alpha.408) changes package.json's version from 0.1.0-alpha.407 to 0.1.0-alpha.408")
    expect(said).toContain("bbbbbbbbbbbb (drop the bump)")
    // drop-bump itself rebuilds the branch as one commit, so the hint is the same two steps as everywhere else.
    expect(said).toContain("npm run release:drop-bump")
    expect(said).toContain("git push --force-with-lease")
  })

  it("fails a branch that removes changes/README.md, which every release needs", () => {
    const result = preflight(
      { changedFiles: ["changes/README.md", "changes/daemon-fix.md", "src/heart/daemon/daemon-cli.ts"], existingNotes: ["changes/README.md"] },
      { notes: { "changes/daemon-fix.md": "Fix.\n" } },
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("changes/README.md")
    expect(result.errors.join("\n")).toContain("restore it")
  })

  it("does not take a renamed note for a new one", () => {
    const renamed = { changedFiles: ["changes/old-fix.md", "changes/new-name.md", "src/heart/daemon/daemon-cli.ts"], existingNotes: ["changes/old-fix.md"], baseNotes: { "changes/old-fix.md": "Old fix.\n" } }

    const withCode = preflight(renamed, { notes: { "changes/new-name.md": "Old fix.\n" } })
    expect(withCode.ok).toBe(false)
    expect(withCode.errors.join("\n")).toContain("changes/new-name.md is changes/old-fix.md renamed")
    expect(withCode.errors.join("\n")).toContain("add a change note for src/heart/daemon/daemon-cli.ts")

    const tidy = preflight({ ...renamed, changedFiles: ["changes/old-fix.md", "changes/new-name.md"] }, { notes: { "changes/new-name.md": "Old fix.\n" } })
    expect(tidy.errors).toEqual([])

    const edited = preflight(renamed, { notes: { "changes/new-name.md": "A new fix.\n" } })
    expect(edited.errors).toEqual([])
  })

  it("lets one commit start the new release line the branch ends on, and nothing else move the version", () => {
    const start = { sha: "a".repeat(40), subject: "start 0.2", from: "0.1.0-alpha.407", to: "0.2.0-alpha.0" }
    expect(assessCommitVersions({ versionCommits: [], newLineVersion: undefined })).toMatchObject({ ok: true })
    expect(assessCommitVersions({ versionCommits: [start], newLineVersion: "0.2.0-alpha.0" })).toMatchObject({ ok: true })
    expect(assessCommitVersions({ versionCommits: [start], newLineVersion: undefined })).toMatchObject({ ok: false })
    expect(assessCommitVersions({ versionCommits: [{ ...start, to: "0.2.0-alpha.3" }], newLineVersion: "0.2.0-alpha.0" })).toMatchObject({ ok: false })
  })

  it("fails a branch that adds a changelog.json entry instead of a change note", () => {
    const result = preflight(
      { changedFiles: ["src/heart/daemon/daemon-cli.ts", "changelog.json"], baseChangelogVersions: ["0.1.0-alpha.406"] },
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("changelog.json gains an entry for 0.1.0-alpha.407 on this branch")
    expect(result.errors.join("\n")).toContain("npm run release:drop-bump")
  })

  it("passes a branch that starts a new release line with its own changelog entry", () => {
    const result = preflight(
      {
        changedFiles: ["package.json", "package-lock.json", "npm-shrinkwrap.json", "packages/ouro.bot/package.json", "changelog.json", "src/heart/daemon/daemon-cli.ts"],
        baseCliVersion: "0.1.0-alpha.407",
        baseChangelogVersions: ["0.1.0-alpha.407"],
      },
      { cliVersion: "0.2.0-alpha.0", changelogChanges: ["The 0.2 line starts here."] },
    )

    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.messages).toContain("release version: this branch starts a new release line at 0.2.0-alpha.0")
    expect(result.messages).toContain("change note: changelog.json's entry for the new release line 0.2.0-alpha.0")
  })

  it("fails a new release line that also adds changelog entries for other versions", () => {
    const result = assessChangeNote({
      changedFiles: ["changelog.json", "package.json"],
      existingNotes: new Set(),
      tipNotes: new Set(),
      baseChangelogVersions: ["0.1.0-alpha.407"],
      newLineVersion: "0.2.0-alpha.0",
      changelog: { versions: [{ version: "0.2.0-alpha.0", changes: ["x"] }, { version: "0.1.0-alpha.408", changes: ["y"] }] },
      readNote: () => "",
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("changelog.json gains an entry for 0.1.0-alpha.408")
  })

  it("fails a new release line that carries a change note, whose lines belong in the line's own entry", () => {
    const line = {
      existingNotes: new Set<string>(),
      tipNotes: new Set<string>(),
      baseChangelogVersions: ["0.1.0-alpha.407"],
      newLineVersion: "0.2.0-alpha.0",
      readNote: () => "Fix.\n",
    }
    const withNote = assessChangeNote({
      ...line,
      changedFiles: ["changelog.json", "package.json", "src/heart/x.ts", "changes/new-line.md"],
      changelog: { versions: [{ version: "0.2.0-alpha.0", changes: ["x"] }] },
    })
    expect(withNote.ok).toBe(false)
    expect(withNote.message).toContain("changes/new-line.md")
    expect(withNote.message).toContain("changelog.json's entry for 0.2.0-alpha.0")
    const withoutEntry = assessChangeNote({ ...line, changedFiles: ["package.json", "src/heart/x.ts"], changelog: { versions: [] } })
    expect(withoutEntry.ok).toBe(false)
    expect(withoutEntry.message).toContain("add changelog.json's entry for 0.2.0-alpha.0")
  })

  it("fails a note whose name another change already took on main", () => {
    const result = preflight(
      { changedFiles: ["src/mailroom/core.ts", "changes/mailroom.md"], tipNotes: ["changes/mailroom.md"] },
      { notes: { "changes/mailroom.md": "Mailroom fix.\n" } },
    )

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("changes/mailroom.md already exists on origin/main")
    expect(result.errors.join("\n")).toContain("named after this branch")
  })

  it("fails an edit to a note that already landed, but allows removing one", () => {
    const edited = preflight(
      { changedFiles: ["src/mailroom/core.ts", "changes/old.md", "changes/new.md"], existingNotes: ["changes/old.md"] },
      { notes: { "changes/old.md": "Reworded.\n", "changes/new.md": "New.\n" } },
    )
    expect(edited.ok).toBe(false)
    expect(edited.errors.join("\n")).toContain("changes/old.md already landed")

    const removed = preflight(
      { changedFiles: ["src/mailroom/core.ts", "changes/gone.md", "changes/new.md"], existingNotes: ["changes/gone.md"] },
      { notes: { "changes/new.md": "New.\n" } },
    )
    expect(removed.errors).toEqual([])
  })

  it("fails releasable implementation changes without a change note", () => {
    const result = preflight({ changedFiles: ["src/mailroom/core.ts"], workingTreeChangedFiles: ["scripts/package-assets.cjs"] })

    expect(result.ok).toBe(false)
    expect(result.errors.join("\n")).toContain("add a change note for scripts/package-assets.cjs, src/mailroom/core.ts: a new file changes/<branch-name>.md")
  })

  it("counts an untracked note in a local run", () => {
    const result = preflight(
      { changedFiles: ["src/mailroom/core.ts"], untrackedFiles: ["changes/mailroom.md"] },
      { notes: { "changes/mailroom.md": "- Mailroom fix.\n" } },
    )

    expect(result.ok).toBe(true)
  })

  it("does not ask for a note when only docs or tests changed", () => {
    const result = preflight({ changedFiles: ["docs/auth-and-providers.md", "src/__tests__/x.test.ts"] })

    expect(result.ok).toBe(true)
    expect(result.messages).toContain("no releasable changes: landing this publishes no new version")
    expect(result.messages).toContain("change note: not needed (no releasable implementation paths)")
  })

  it("reads the base from the merge base", () => {
    expect(readBaseState("origin/main", makeExecSyncImpl({ existingNotes: ["changes/old.md"], baseCliVersion: "0.1.0-alpha.9" }))).toEqual({
      mergeBase: "base-sha",
      version: "0.1.0-alpha.9",
      changelogVersions: ["0.1.0-alpha.407"],
      notes: new Set(["changes/old.md"]),
      tipNotes: new Set(["changes/old.md"]),
      versionCommits: [],
    })
    const bump = { sha: "a".repeat(40), subject: "Release 0.1.0-alpha.408", from: "0.1.0-alpha.407", to: "0.1.0-alpha.408" }
    expect(readBaseState("origin/main", makeExecSyncImpl({ versionCommits: [bump] })).versionCommits).toEqual([bump])
    expect(readBaseState("origin/main", makeExecSyncImpl({ baseChangelogVersions: null })).changelogVersions).toBeUndefined()
  })

  it("lets a branch start a new release line, but never move within one or go back", () => {
    expect(assessReleaseVersionUnchanged({ baseVersion: "0.1.0-alpha.12", headVersion: "0.1.0-alpha.12" }).ok).toBe(true)
    expect(assessReleaseVersionUnchanged({ baseVersion: undefined, headVersion: "0.1.0-alpha.12" }).ok).toBe(true)
    expect(assessReleaseVersionUnchanged({ baseVersion: "0.1.0-alpha.12", headVersion: "0.2.0-alpha.0" })).toEqual({
      ok: true,
      newLine: true,
      message: "release version: this branch starts a new release line at 0.2.0-alpha.0",
    })
    expect(assessReleaseVersionUnchanged({ baseVersion: "0.1.0-alpha.12", headVersion: "1.0.0" }).ok).toBe(true)
    expect(assessReleaseVersionUnchanged({ baseVersion: "1.0.0", headVersion: "1.1.0" }).ok).toBe(true)
    expect(assessReleaseVersionUnchanged({ baseVersion: "0.1.0-alpha.12", headVersion: "0.1.0-alpha.13" }).ok).toBe(false)
    expect(assessReleaseVersionUnchanged({ baseVersion: "1.0.0", headVersion: "1.0.4" }).ok).toBe(false)
    expect(assessReleaseVersionUnchanged({ baseVersion: "0.2.0-alpha.3", headVersion: "0.1.0-beta.0" }).ok).toBe(false)
    expect(assessReleaseVersionUnchanged({ baseVersion: "0.1.0-alpha.12", headVersion: "not-semver" }).ok).toBe(false)
  })

  it("counts only notes the branch adds, and rejects an empty one", () => {
    const base = {
      changedFiles: ["src/a.ts", "changes/old.md", "changes/gone.md"],
      existingNotes: new Set(["changes/old.md"]),
      baseChangelogVersions: ["0.1.0-alpha.1"],
      changelog: { versions: [{ version: "0.1.0-alpha.1", changes: ["x"] }] },
    }
    const missing = () => { throw new Error("ENOENT") }
    expect(assessChangeNote({ ...base, readNote: missing }).ok).toBe(false)
    expect(assessChangeNote({ ...base, changedFiles: [...base.changedFiles, "changes/new.md"], readNote: (file: string) => (file === "changes/new.md" ? "# Only a heading\n" : missing()) })).toEqual({
      ok: false,
      message: "change note changes/new.md says nothing; write what changed for the people who use it",
    })
    expect(assessChangeNote({ ...base, changelog: undefined, baseChangelogVersions: undefined, changedFiles: ["src/a.ts", "changes/new.md"], readNote: () => "Fix." })).toEqual({
      ok: true,
      message: "change note: changes/new.md",
    })
    expect(assessChangeNote({ ...base, changedFiles: [...base.changedFiles, "changes/README.md"], readNote: (file: string) => (file === "changes/README.md" ? "Fix." : missing()) }).ok).toBe(false)
  })

  it("truncates long path lists in the change-note guidance", () => {
    const changedFiles = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((name) => `src/path/${name}.ts`)
    const result = assessChangeNote({ changedFiles, existingNotes: new Set(), baseChangelogVersions: undefined, changelog: undefined, readNote: () => "" })
    expect(result.message).toContain("src/path/a.ts, src/path/b.ts, src/path/c.ts, src/path/d.ts, src/path/e.ts, src/path/f.ts, src/path/g.ts, src/path/h.ts, and 1 more")
  })

  it("fails when the current version is missing from the changelog", () => {
    const result = preflight(
      { changedFiles: ["docs/auth-and-providers.md"] },
      { changelogVersion: "0.1.0-alpha.406" },
    )

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain("0.1.0-alpha.407")
  })

  it("fails when the wrapper version drifts behind the cli version", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["src/heart/daemon/daemon-cli.ts"],
      localVersion: "0.1.0-alpha.406",
      cliVersion: "0.1.0-alpha.407",
    })).toEqual({
      ok: false,
      message: "ouro.bot wrapper version 0.1.0-alpha.406 must match @ouro.bot/cli version 0.1.0-alpha.407",
    })
  })

  it("lets a wrapper change through: the release job publishes the wrapper with the next version", () => {
    const result = preflight(
      { changedFiles: ["packages/ouro.bot/index.js", "changes/wrapper.md"] },
      { notes: { "changes/wrapper.md": "Wrapper fix.\n" } },
    )

    expect(result.ok).toBe(true)
    expect(result.messages).toContain("wrapper package changed; the release job publishes it with the next version")
  })

  it("runs the command-line wrapper success, failure, and argument-error paths", () => {
    const out: string[] = []
    const err: string[] = []
    const exits: number[] = []
    const deps = {
      consoleLog: (line: string) => out.push(line),
      consoleError: (line: string) => err.push(line),
      exit: (code: number) => {
        exits.push(code)
        return code
      },
    }

    expect(runReleasePreflightCli(["--base-ref", "origin/main"], {
      ...deps,
      runReleasePreflightImpl: (options: { baseRef: string }) => ({
        ok: true,
        baseRef: options.baseRef,
        changedFiles: [],
        releasableChanged: false,
        messages: ["preflight ok"],
        errors: [],
      }),
    })).toBe(0)
    expect(out).toContain("preflight ok")
    expect(out).toContain("release preflight: pass")

    expect(runReleasePreflightCli([], {
      ...deps,
      runReleasePreflightImpl: () => ({
        ok: false,
        baseRef: "origin/main",
        changedFiles: [],
        releasableChanged: false,
        messages: ["preflight checked"],
        errors: ["broken contract"],
      }),
    })).toBe(1)
    expect(err).toContain("release preflight: FAIL")
    expect(err).toContain("broken contract")

    expect(runReleasePreflightCli(["--unknown"], deps)).toBe(1)
    expect(err).toContain("unknown argument: --unknown")

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect(runReleasePreflightCli(["--still-unknown"], {
        exit: (code: number) => code,
      })).toBe(1)
      expect(consoleError).toHaveBeenCalledWith("release preflight: FAIL")
      expect(consoleError).toHaveBeenCalledWith("unknown argument: --still-unknown")
    } finally {
      consoleError.mockRestore()
    }
  })

  it("only runs the command-line wrapper when invoked as main", () => {
    const moduleRef = { filename: "release-preflight.cjs" }
    expect(runReleasePreflightCliIfMain(moduleRef, { main: null })).toBeUndefined()
    expect(runReleasePreflightCliIfMain(moduleRef, { main: moduleRef }, () => 0)).toBe(0)
  })

  it("uses default command-line loggers on successful CLI runs", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      expect(runReleasePreflightCli(["--base-ref", "origin/main"], {
        runReleasePreflightImpl: () => ({
          ok: true,
          baseRef: "origin/main",
          changedFiles: [],
          releasableChanged: false,
          messages: ["default logger path"],
          errors: [],
        }),
      })).toBe(0)
      expect(consoleLog).toHaveBeenCalledWith("default logger path")
      expect(consoleLog).toHaveBeenCalledWith("release preflight: pass")
    } finally {
      consoleLog.mockRestore()
    }
  })
})
