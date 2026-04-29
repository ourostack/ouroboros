import * as path from "path"
import * as fs from "fs"
import * as os from "os"

import { describe, expect, it } from "vitest"

const {
  assessWrapperPublishSync,
  collectChangedFiles,
  runReleasePreflight,
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
}

type ReadResponse = {
  cliVersion?: string
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
      return JSON.stringify({ version: wrapperVersion })
    }

    if (filePath.endsWith("/package.json")) {
      return JSON.stringify({ version: cliVersion })
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
    expect(versionBumpRequired(["src/__tests__/scripts/changelog-gate.test.ts"])).toBe(false)
  })

  it("detects wrapper package changes separately from general release bumps", () => {
    expect(wrapperPackageChanged(["packages/ouro.bot/index.js"])).toBe(true)
    expect(wrapperPackageChanged(["src/heart/daemon/daemon-cli.ts"])).toBe(false)
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
    expect(result.messages).toContain("package assets verified")
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

  it("fails when releasable changes reuse an already-published cli version", () => {
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["src/heart/daemon/daemon-cli.ts"],
          publishedCliVersion: "0.1.0-alpha.407",
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
      },
    )

    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain("@ouro.bot/cli@0.1.0-alpha.407 is already published on npm.")
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
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/agent-mail-setup.md"],
          workingTreeChangedFiles: ["src/mailroom/core.ts"],
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
      },
    )

    expect(result.ok).toBe(true)
    expect(result.changedFiles).toContain("src/mailroom/core.ts")
    expect(result.releasableChanged).toBe(true)
    expect(result.messages).toContain("@ouro.bot/cli@0.1.0-alpha.407 is not yet published — ready to merge and publish")
  })

  it("fails when the current version is missing from the changelog", () => {
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["docs/auth-and-providers.md"],
        }),
        readFileSyncImpl: makeReadFileSyncImpl({
          changelogVersion: "0.1.0-alpha.406",
        }),
      },
    )

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

  it("fails when the wrapper package changed but the wrapper version is already published", () => {
    const result = runReleasePreflight(
      {},
      {
        execSyncImpl: makeExecSyncImpl({
          changedFiles: ["packages/ouro.bot/index.js"],
          publishedWrapperVersion: "0.1.0-alpha.407",
        }),
        readFileSyncImpl: makeReadFileSyncImpl(),
      },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "ouro.bot wrapper changed but ouro.bot@0.1.0-alpha.407 is already published; bump packages/ouro.bot/package.json before merging",
    )
  })
})
