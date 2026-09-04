import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, expect, it, vi } from "vitest"

const {
  assessChangelogFreshness,
  assessLockfileVersionSync,
  assessWrapperPublishSync,
  collectChangedFiles,
  classifyOperationalContractChange,
  parseArgs,
  pathRequiresChangelogFreshness,
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
  publishedCliVersion?: string
  publishedWrapperVersion?: string
  latestCommits?: Record<string, string>
  ancestorChecks?: Record<string, boolean>
  auditOutput?: string
  auditFailureOutput?: string
}

type ReadResponse = {
  cliVersion?: string
  packageLockVersion?: string
  shrinkwrapVersion?: string
  wrapperVersion?: string
  changelogVersion?: string
  changelogChanges?: string[]
}

function makeExecSyncImpl(response: ExecResponse = {}) {
  return (command: string): string => {
    if (command.startsWith('git diff --name-only "') && command.includes("...HEAD")) {
      return (response.changedFiles ?? []).join("\n")
    }

    if (command === "git diff --name-only HEAD") {
      return (response.workingTreeChangedFiles ?? []).join("\n")
    }

    if (command === "git ls-files --others --exclude-standard") {
      return (response.untrackedFiles ?? []).join("\n")
    }

    if (command.startsWith("git log --format=%H --max-count=1")) {
      const file = command.match(/ -- '([^']+)'$/)?.[1]
      return file ? `${response.latestCommits?.[file] ?? ""}\n` : ""
    }

    if (command.startsWith("git merge-base --is-ancestor")) {
      const commits = Array.from(command.matchAll(/'([^']+)'/g)).map((match) => match[1])
      const key = `${commits[0]}..${commits[1]}`
      const result = response.ancestorChecks?.[key]
      if (result === false) {
        throw new Error("not ancestor")
      }
      return ""
    }

    if (command.includes("@ouro.bot/cli@")) {
      if (response.publishedCliVersion) {
        return `${response.publishedCliVersion}\n`
      }
      throw new Error("not published")
    }

    if (command.includes("ouro.bot@")) {
      if (response.publishedWrapperVersion) {
        return `${response.publishedWrapperVersion}\n`
      }
      throw new Error("not published")
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
      run: npm publish --access public --tag "$TAG"
    - name: Publish ouro.bot
      run: npm publish --access public --tag "\${{ steps.wrapper-publish-tag.outputs.tag }}"
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
    expect(result.messages).toContain("No releasable src/ or packaged skills changes detected — version bump not required")
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

  it("fails when releasable changes reuse an already-published cli version", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["src/heart/daemon/daemon-cli.ts"],
          publishedCliVersion: "0.1.0-alpha.407",
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain("@ouro.bot/cli@0.1.0-alpha.407 is already published on npm.")
    expect(result.errors[0]).toContain("npm run release:bump -- --version <next-version> --change")
    expect(result.errors[0]).not.toContain("npm version prerelease")
  })

  it("fails when package-truth changes reuse an already-published cli version", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["scripts/package-assets.cjs"],
          publishedCliVersion: "0.1.0-alpha.407",
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain("@ouro.bot/cli@0.1.0-alpha.407 is already published on npm.")
  })

  it("requires a release bump when releasable changes are only in the working tree", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/agent-mail-setup.md"],
          workingTreeChangedFiles: ["src/mailroom/core.ts", "changelog.json"],
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(true)
    expect(result.changedFiles).toContain("src/mailroom/core.ts")
    expect(result.releasableChanged).toBe(true)
    expect(result.messages).toContain("@ouro.bot/cli@0.1.0-alpha.407 is not yet published — ready to merge and publish")
  })

  it("fails when releasable implementation changes do not touch the changelog", () => {
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles: ["src/senses/voice/twilio-phone.ts"],
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [{ version: "0.1.0-alpha.407", changes: ["old voice tuning"] }],
      },
      execSyncImpl: makeExecSyncImpl(),
    })

    expect(result).toEqual({
      ok: false,
      message:
        "changelog.json must be updated alongside releasable implementation changes: src/senses/voice/twilio-phone.ts",
    })
  })

  it("truncates long freshness path lists in changelog guidance", () => {
    const changedFiles = [
      "src/path/a.ts",
      "src/path/b.ts",
      "src/path/c.ts",
      "src/path/d.ts",
      "src/path/e.ts",
      "src/path/f.ts",
      "src/path/g.ts",
      "src/path/h.ts",
      "src/path/i.ts",
    ]
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles,
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [{ version: "0.1.0-alpha.407", changes: ["old entry"] }],
      },
      execSyncImpl: makeExecSyncImpl(),
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("src/path/a.ts, src/path/b.ts, src/path/c.ts, src/path/d.ts, src/path/e.ts, src/path/f.ts, src/path/g.ts, src/path/h.ts, and 1 more")
  })

  it("fails when uncommitted releasable changes are newer than a committed changelog", () => {
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles: ["src/mailroom/core.ts", "changelog.json"],
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [{ version: "0.1.0-alpha.407", changes: ["mailroom runtime update"] }],
      },
      execSyncImpl: makeExecSyncImpl({
        workingTreeChangedFiles: ["src/mailroom/core.ts"],
      }),
    })

    expect(result).toEqual({
      ok: false,
      message: "changelog.json must be updated in the working tree after uncommitted releasable changes: src/mailroom/core.ts",
    })
  })

  it("fails when the current version is not the top changelog entry for releasable changes", () => {
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles: ["scripts/release-preflight.cjs", "changelog.json"],
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [
          { version: "0.1.0-alpha.406", changes: ["older entry"] },
          { version: "0.1.0-alpha.407", changes: ["release metadata aligned"] },
        ],
      },
      execSyncImpl: makeExecSyncImpl(),
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("must be the top changelog entry")
  })

  it("passes when the changelog is updated in the working tree with releasable working-tree changes", () => {
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles: ["src/mailroom/core.ts", "changelog.json"],
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [{ version: "0.1.0-alpha.407", changes: ["mailroom runtime update"] }],
      },
      execSyncImpl: makeExecSyncImpl({
        workingTreeChangedFiles: ["src/mailroom/core.ts", "changelog.json"],
      }),
    })

    expect(result).toEqual({ ok: true, message: "changelog freshness: pass" })
  })

  it("passes changelog freshness when committed implementation changes are older than changelog", () => {
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles: ["src/senses/voice/twilio-phone.ts", "changelog.json"],
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [{ version: "0.1.0-alpha.407", changes: ["fresh voice tuning"] }],
      },
      execSyncImpl: makeExecSyncImpl({
        latestCommits: {
          "changelog.json": "newer",
          "src/senses/voice/twilio-phone.ts": "older",
        },
        ancestorChecks: {
          "older..newer": true,
        },
      }),
    })

    expect(result).toEqual({ ok: true, message: "changelog freshness: pass" })
  })

  it("fails when the changelog commit is older than a releasable implementation commit", () => {
    const result = assessChangelogFreshness({
      baseRef: "origin/main",
      changedFiles: ["src/senses/voice/twilio-phone.ts", "changelog.json"],
      currentVersion: "0.1.0-alpha.407",
      changelog: {
        versions: [{ version: "0.1.0-alpha.407", changes: ["old voice tuning"] }],
      },
      execSyncImpl: makeExecSyncImpl({
        latestCommits: {
          "changelog.json": "older",
          "src/senses/voice/twilio-phone.ts": "newer",
        },
        ancestorChecks: {
          "newer..older": false,
        },
      }),
    })

    expect(result).toEqual({
      ok: false,
      message:
        "changelog.json is older than releasable implementation changes; update it after touching: src/senses/voice/twilio-phone.ts",
    })
  })

  it("fails when the current version is missing from the changelog", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
        }),
        readFileSyncImpl: makeReadFileSyncImpl({
          changelogVersion: "0.1.0-alpha.406",
        }),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain("0.1.0-alpha.407")
  })

  it("fails when the wrapper version drifts behind the cli version", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["src/heart/daemon/daemon-cli.ts"],
      localVersion: "0.1.0-alpha.406",
      cliVersion: "0.1.0-alpha.407",
      publishedVersion: "0.1.0-alpha.406",
    })).toEqual({
      ok: false,
      message: "ouro.bot wrapper version 0.1.0-alpha.406 must match @ouro.bot/cli version 0.1.0-alpha.407",
    })
  })

  it("passes when the wrapper changed and its local version is unpublished", () => {
    expect(assessWrapperPublishSync({
      changedFiles: ["packages/ouro.bot/index.js"],
      localVersion: "0.1.0-alpha.407",
      cliVersion: "0.1.0-alpha.407",
      publishedVersion: "",
    })).toEqual({
      ok: true,
      message: "wrapper package changed and local wrapper version is unpublished",
    })
  })

  it("fails when the wrapper package changed but the wrapper version is already published", () => {
    const packageRoot = makePackageRootWithRequiredAssets()
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["packages/ouro.bot/index.js"],
          publishedWrapperVersion: "0.1.0-alpha.407",
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
        packageRoot,
      },
    )
    fs.rmSync(packageRoot, { recursive: true, force: true })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "ouro.bot wrapper changed but ouro.bot@0.1.0-alpha.407 is already published; bump packages/ouro.bot/package.json before merging",
    )
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
