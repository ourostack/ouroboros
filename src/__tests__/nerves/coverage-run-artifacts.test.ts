import { createHash } from "crypto"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join, resolve } from "path"

import { afterEach, describe, expect, it } from "vitest"

import {
  clearActiveRun,
  createRunId,
  getRunDir,
  getTestRunsRoot,
  readActiveRun,
  readLatestRun,
  writeActiveRun,
  writeLatestRun,
} from "../../nerves/coverage/run-artifacts"
import * as runArtifacts from "../../nerves/coverage/run-artifacts"

function expectedOwner(cwd: string): string {
  return `cwd-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12)}`
}

function ownedRoot(repoSlug: string, cwd: string): string {
  return join(getTestRunsRoot(repoSlug), expectedOwner(cwd))
}

function createInfo(repoSlug: string, cwd: string = process.cwd(), runId = "2026-03-02T18-00-00-000Z") {
  return {
    repo_slug: repoSlug,
    run_owner: expectedOwner(cwd),
    run_id: runId,
    run_dir: join(ownedRoot(repoSlug, cwd), runId),
    created_at: "2026-03-02T18:00:00.000Z",
  }
}

function writeOwnedMetadata(repoSlug: string, cwd: string, fileName: ".active-run.json" | "latest-run.json", value: unknown): void {
  const root = ownedRoot(repoSlug, cwd)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, fileName), JSON.stringify(value), "utf8")
}

const slugsToCleanup = new Set<string>()

afterEach(() => {
  for (const slug of slugsToCleanup) {
    rmSync(getTestRunsRoot(slug), { recursive: true, force: true })
  }
  slugsToCleanup.clear()
})

describe("observability/coverage run artifacts", () => {
  it("builds test-run paths and deterministic run IDs", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}`
    const cwd = "/tmp/ouro/worktree-a"
    const info = createInfo(repoSlug, cwd)
    slugsToCleanup.add(repoSlug)

    const exports = runArtifacts as typeof runArtifacts & {
      coverageRunOwner?: (input: string) => string
      getOwnedTestRunsRoot?: (inputRepoSlug?: string, inputCwd?: string) => string
    }
    expect(exports.coverageRunOwner).toBeTypeOf("function")
    expect(exports.coverageRunOwner?.(cwd)).toBe(expectedOwner(cwd))
    expect(exports.getOwnedTestRunsRoot).toBeTypeOf("function")
    expect(exports.getOwnedTestRunsRoot?.(repoSlug, cwd)).toBe(ownedRoot(repoSlug, cwd))
    expect(readLatestRun(repoSlug, cwd)).toBeNull()
    expect(getTestRunsRoot(repoSlug)).toContain(`/ouroboros-test-runs/${repoSlug}`)
    expect(getRunDir(info.run_id, repoSlug, cwd)).toBe(info.run_dir)
    expect(info.run_dir).toContain(`/ouroboros-test-runs/${repoSlug}/${info.run_owner}/${info.run_id}`)
    expect(createRunId(new Date("2026-03-02T18:00:00.000Z"))).toBe("2026-03-02T18-00-00-000Z")
  })

  it("writes, reads, and clears active/latest run metadata", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-state`
    const info = createInfo(repoSlug)
    slugsToCleanup.add(repoSlug)

    writeActiveRun(info, process.cwd())
    writeLatestRun(info, process.cwd())

    expect(readActiveRun(repoSlug, process.cwd())).toEqual(info)
    expect(readLatestRun(repoSlug, process.cwd())).toEqual(info)

    clearActiveRun(repoSlug, process.cwd())
    expect(readActiveRun(repoSlug, process.cwd())).toBeNull()
    expect(readLatestRun(repoSlug, process.cwd())).toEqual(info)
  })

  it("isolates latest runs for two worktrees under one repo slug", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-owners`
    const cwdA = "/tmp/ouro/worktree-a"
    const cwdB = "/tmp/ouro/worktree-b"
    const infoA = createInfo(repoSlug, cwdA, "run-a")
    const infoB = createInfo(repoSlug, cwdB, "run-b")
    slugsToCleanup.add(repoSlug)

    writeLatestRun(infoA, cwdA)
    writeLatestRun(infoB, cwdB)

    expect(readLatestRun(repoSlug, cwdA)).toEqual(infoA)
    expect(readLatestRun(repoSlug, cwdB)).toEqual(infoB)
  })

  it("never selects sibling-owner or legacy-unscoped metadata", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-no-fallback`
    const cwdA = "/tmp/ouro/worktree-a"
    const cwdB = "/tmp/ouro/worktree-b"
    const legacy = createInfo(repoSlug, cwdA, "legacy-newer")
    const sibling = createInfo(repoSlug, cwdB, "sibling-newer")
    const current = createInfo(repoSlug, cwdA, "current")
    slugsToCleanup.add(repoSlug)

    mkdirSync(getTestRunsRoot(repoSlug), { recursive: true })
    writeFileSync(join(getTestRunsRoot(repoSlug), "latest-run.json"), JSON.stringify(legacy), "utf8")
    writeOwnedMetadata(repoSlug, cwdB, "latest-run.json", sibling)

    expect(readLatestRun(repoSlug, cwdA)).toBeNull()

    writeOwnedMetadata(repoSlug, cwdA, "latest-run.json", current)
    expect(readLatestRun(repoSlug, cwdA)).toEqual(current)
  })

  it("returns null when persisted metadata is malformed", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-malformed`
    slugsToCleanup.add(repoSlug)

    const root = ownedRoot(repoSlug, process.cwd())
    mkdirSync(root, { recursive: true })
    writeFileSync(`${root}/.active-run.json`, "{oops", "utf8")
    writeFileSync(`${root}/latest-run.json`, "{oops", "utf8")

    expect(readActiveRun(repoSlug, process.cwd())).toBeNull()
    expect(readLatestRun(repoSlug, process.cwd())).toBeNull()

    writeOwnedMetadata(repoSlug, process.cwd(), ".active-run.json", null)
    writeOwnedMetadata(repoSlug, process.cwd(), "latest-run.json", "not-an-object")

    expect(readActiveRun(repoSlug, process.cwd())).toBeNull()
    expect(readLatestRun(repoSlug, process.cwd())).toBeNull()
  })

  it("rejects mismatched and owner-root-escaping metadata", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-invalid-shape`
    const cwd = "/tmp/ouro/worktree-a"
    const valid = createInfo(repoSlug, cwd)
    slugsToCleanup.add(repoSlug)

    writeOwnedMetadata(repoSlug, cwd, "latest-run.json", { ...valid, repo_slug: `${repoSlug}-other` })
    expect(readLatestRun(repoSlug, cwd)).toBeNull()

    writeOwnedMetadata(repoSlug, cwd, "latest-run.json", { ...valid, run_owner: expectedOwner("/tmp/ouro/worktree-b") })
    expect(readLatestRun(repoSlug, cwd)).toBeNull()

    writeOwnedMetadata(repoSlug, cwd, "latest-run.json", {
      ...valid,
      run_dir: resolve(ownedRoot(repoSlug, cwd), "..", "escaped", valid.run_id),
    })
    expect(readLatestRun(repoSlug, cwd)).toBeNull()

    writeOwnedMetadata(repoSlug, cwd, "latest-run.json", { ...valid, run_id: "", run_dir: "" })
    expect(readLatestRun(repoSlug, cwd)).toBeNull()

    clearActiveRun(`${repoSlug}-missing`, cwd)
  })
})
