import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

export const REPO_SLUG = "ouroboros-agent-harness"

export interface TestRunInfo {
  repo_slug: string
  run_id: string
  run_dir: string
  created_at: string
}

export function getTestRunsRoot(repoSlug: string = REPO_SLUG): string {
  return join(tmpdir(), "ouroboros-test-runs", repoSlug)
}

export function createRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-")
}

export function getRunDir(runId: string, repoSlug: string = REPO_SLUG): string {
  return join(getTestRunsRoot(repoSlug), runId)
}

function getActiveRunPath(repoSlug: string = REPO_SLUG): string {
  return join(getTestRunsRoot(repoSlug), ".active-run.json")
}

function getLatestRunPath(repoSlug: string = REPO_SLUG): string {
  return join(getTestRunsRoot(repoSlug), "latest-run.json")
}

function ensureRoot(repoSlug: string = REPO_SLUG): string {
  const root = getTestRunsRoot(repoSlug)
  mkdirSync(root, { recursive: true })
  return root
}

export function writeActiveRun(info: TestRunInfo): void {
  ensureRoot(info.repo_slug)
  writeFileSync(getActiveRunPath(info.repo_slug), JSON.stringify(info, null, 2), "utf8")
}

export function readActiveRun(repoSlug: string = REPO_SLUG): TestRunInfo | null {
  const filePath = getActiveRunPath(repoSlug)
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TestRunInfo
    if (!parsed.run_id || !parsed.run_dir) return null
    return parsed
  } catch {
    return null
  }
}

export function clearActiveRun(repoSlug: string = REPO_SLUG): void {
  const filePath = getActiveRunPath(repoSlug)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

export function writeLatestRun(info: TestRunInfo): void {
  ensureRoot(info.repo_slug)
  writeFileSync(getLatestRunPath(info.repo_slug), JSON.stringify(info, null, 2), "utf8")
}

export function readLatestRun(repoSlug: string = REPO_SLUG): TestRunInfo | null {
  const filePath = getLatestRunPath(repoSlug)
  if (!existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as TestRunInfo
    if (!parsed.run_id || !parsed.run_dir) return null
    return parsed
  } catch {
    return null
  }
}
