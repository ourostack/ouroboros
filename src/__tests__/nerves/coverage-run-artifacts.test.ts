import { mkdirSync, rmSync, writeFileSync } from "fs"

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

function createInfo(repoSlug: string) {
  const runId = "2026-03-02T18-00-00-000Z"
  return {
    repo_slug: repoSlug,
    run_id: runId,
    run_dir: getRunDir(runId, repoSlug),
    created_at: "2026-03-02T18:00:00.000Z",
  }
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
    const info = createInfo(repoSlug)
    slugsToCleanup.add(repoSlug)

    expect(readLatestRun(repoSlug)).toBeNull()
    expect(getTestRunsRoot(repoSlug)).toContain(`/ouroboros-test-runs/${repoSlug}`)
    expect(info.run_dir).toContain(`/ouroboros-test-runs/${repoSlug}/${info.run_id}`)
    expect(createRunId(new Date("2026-03-02T18:00:00.000Z"))).toBe("2026-03-02T18-00-00-000Z")
  })

  it("writes, reads, and clears active/latest run metadata", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-state`
    const info = createInfo(repoSlug)
    slugsToCleanup.add(repoSlug)

    writeActiveRun(info)
    writeLatestRun(info)

    expect(readActiveRun(repoSlug)).toEqual(info)
    expect(readLatestRun(repoSlug)).toEqual(info)

    clearActiveRun(repoSlug)
    expect(readActiveRun(repoSlug)).toBeNull()
    expect(readLatestRun(repoSlug)).toEqual(info)
  })

  it("returns null when persisted metadata is malformed", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-malformed`
    slugsToCleanup.add(repoSlug)

    const root = getTestRunsRoot(repoSlug)
    mkdirSync(root, { recursive: true })
    writeFileSync(`${root}/.active-run.json`, "{oops", "utf8")
    writeFileSync(`${root}/latest-run.json`, "{oops", "utf8")

    expect(readActiveRun(repoSlug)).toBeNull()
    expect(readLatestRun(repoSlug)).toBeNull()
  })

  it("returns null for structurally invalid metadata and tolerates clearing when absent", () => {
    const repoSlug = `ouro-run-artifacts-${Date.now()}-invalid-shape`
    slugsToCleanup.add(repoSlug)

    const root = getTestRunsRoot(repoSlug)
    mkdirSync(root, { recursive: true })
    writeFileSync(`${root}/.active-run.json`, JSON.stringify({ run_id: "", run_dir: "" }), "utf8")
    writeFileSync(`${root}/latest-run.json`, JSON.stringify({ run_id: "", run_dir: "" }), "utf8")

    expect(readActiveRun(repoSlug)).toBeNull()
    expect(readLatestRun(repoSlug)).toBeNull()

    clearActiveRun(`${repoSlug}-missing`)
  })
})
