import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { tmpdir } from "os"
import { isAbsolute, join, relative, resolve, sep } from "path"

export const REPO_SLUG = "ouroboros-agent-harness"

export interface TestRunInfo {
  repo_slug: string
  run_owner: string
  run_id: string
  run_dir: string
  created_at: string
}

export function getTestRunsRoot(repoSlug: string = REPO_SLUG): string {
  return join(tmpdir(), "ouroboros-test-runs", repoSlug)
}

export function coverageRunOwner(cwd: string = process.cwd()): string {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12)
  return `cwd-${hash}`
}

export function getOwnedTestRunsRoot(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): string {
  return join(getTestRunsRoot(repoSlug), coverageRunOwner(cwd))
}

export function createRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-")
}

export function getRunDir(runId: string, repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): string {
  return join(getOwnedTestRunsRoot(repoSlug, cwd), runId)
}

function getActiveRunPath(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): string {
  return join(getOwnedTestRunsRoot(repoSlug, cwd), ".active-run.json")
}

function getLatestRunPath(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): string {
  return join(getOwnedTestRunsRoot(repoSlug, cwd), "latest-run.json")
}

function ensureRoot(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): string {
  const root = getOwnedTestRunsRoot(repoSlug, cwd)
  mkdirSync(root, { recursive: true })
  return root
}

function isValidRunInfo(value: unknown, repoSlug: string, cwd: string): value is TestRunInfo {
  if (typeof value !== "object" || value === null) return false

  const parsed = value as Partial<TestRunInfo>
  const owner = coverageRunOwner(cwd)
  if (
    parsed.repo_slug !== repoSlug ||
    parsed.run_owner !== owner ||
    typeof parsed.run_id !== "string" ||
    parsed.run_id.length === 0 ||
    typeof parsed.run_dir !== "string" ||
    parsed.run_dir.length === 0 ||
    typeof parsed.created_at !== "string" ||
    parsed.created_at.length === 0
  ) {
    return false
  }

  const ownerRoot = resolve(getOwnedTestRunsRoot(repoSlug, cwd))
  const runDir = resolve(parsed.run_dir)
  const relativeRunDir = relative(ownerRoot, runDir)
  const isContained = relativeRunDir !== "" && relativeRunDir !== ".." && !relativeRunDir.startsWith(`..${sep}`) && !isAbsolute(relativeRunDir)
  return isContained && runDir === resolve(ownerRoot, parsed.run_id)
}

function readRunInfo(filePath: string, repoSlug: string, cwd: string): TestRunInfo | null {
  if (!existsSync(filePath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"))
    return isValidRunInfo(parsed, repoSlug, cwd) ? parsed : null
  } catch {
    return null
  }
}

export function writeActiveRun(info: TestRunInfo, cwd: string = process.cwd()): void {
  ensureRoot(info.repo_slug, cwd)
  writeFileSync(getActiveRunPath(info.repo_slug, cwd), JSON.stringify(info, null, 2), "utf8")
}

export function readActiveRun(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): TestRunInfo | null {
  return readRunInfo(getActiveRunPath(repoSlug, cwd), repoSlug, cwd)
}

export function clearActiveRun(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): void {
  const filePath = getActiveRunPath(repoSlug, cwd)
  if (existsSync(filePath)) {
    unlinkSync(filePath)
  }
}

export function writeLatestRun(info: TestRunInfo, cwd: string = process.cwd()): void {
  ensureRoot(info.repo_slug, cwd)
  writeFileSync(getLatestRunPath(info.repo_slug, cwd), JSON.stringify(info, null, 2), "utf8")
}

export function readLatestRun(repoSlug: string = REPO_SLUG, cwd: string = process.cwd()): TestRunInfo | null {
  return readRunInfo(getLatestRunPath(repoSlug, cwd), repoSlug, cwd)
}
