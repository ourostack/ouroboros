import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { listBackgroundOperations, type BackgroundOperationRecord } from "./background-operations"
import * as identity from "./identity"

const DEFAULT_RECENT_IMPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_VISIBLE_BACKGROUND_OPERATION_LIMIT = 5
const DEFAULT_VISIBLE_IMPORT_CANDIDATE_LIMIT = 3
const DEFAULT_WORKTREE_POOL_SEARCH_DEPTH = 2
const DEFAULT_AGENT_WORKSPACE_SCAN_LIMIT = 20
const SKIPPED_HOME_SCAN_DIRS = new Set([
  ".Trash",
  "Applications",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "node_modules",
])

export interface DiscoveredMboxCandidate {
  path: string
  name: string
  mtimeMs: number
}

export interface MailImportDiscoverySearchInput {
  agentName?: string
  repoRoot?: string
  homeDir?: string
}

export interface AmbientMailImportOperationsInput extends MailImportDiscoverySearchInput {
  agentName: string
  agentRoot?: string
  existingOperations?: BackgroundOperationRecord[]
  nowMs?: number
  recentWindowMs?: number
  candidateLimit?: number
}

export interface VisibleBackgroundOperationsInput extends AmbientMailImportOperationsInput {
  limit?: number
}

function sortBackgroundOperationsNewestFirst(left: BackgroundOperationRecord, right: BackgroundOperationRecord): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

function recentImportFingerprint(candidates: DiscoveredMboxCandidate[]): string {
  return candidates
    .map((candidate) => `${candidate.path}:${candidate.mtimeMs}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|")
}

function specText(spec: Record<string, unknown> | undefined, key: string): string {
  const value = spec?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function latestComparableOperationTimestamp(record: BackgroundOperationRecord): number | null {
  const fileModifiedAt = specText(record.spec, "fileModifiedAt")
  if (fileModifiedAt) {
    const parsed = Date.parse(fileModifiedAt)
    if (Number.isFinite(parsed)) return parsed
  }
  const candidates = [record.finishedAt, record.updatedAt]
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const parsed = Date.parse(candidate)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function candidateAlreadyCoveredByOperation(
  candidate: DiscoveredMboxCandidate,
  operation: BackgroundOperationRecord,
): boolean {
  if (operation.kind !== "mail.import-mbox") return false
  if (specText(operation.spec, "filePath") !== candidate.path) return false
  if (operation.status !== "succeeded") return false
  const operationTimestamp = latestComparableOperationTimestamp(operation)
  return operationTimestamp !== null && candidate.mtimeMs <= operationTimestamp
}

function listChildDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

function findWorktreePools(rootDir: string, maxDepth: number): string[] {
  const seen = new Set<string>()
  const found: string[] = []

  function visit(currentDir: string, depth: number): void {
    if (depth > maxDepth || seen.has(currentDir)) return
    seen.add(currentDir)

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") && entry.name !== ".playwright-mcp") continue
      if (SKIPPED_HOME_SCAN_DIRS.has(entry.name)) continue

      const childDir = path.join(currentDir, entry.name)
      if (entry.name === "_worktrees") {
        found.push(childDir)
        continue
      }

      visit(childDir, depth + 1)
    }
  }

  visit(rootDir, 0)
  return found
}

function listAgentWorkspaceSandboxDirs(agentName: string | undefined): string[] {
  if (!agentName) return []
  const getAgentRepoWorkspacesRoot = Object.getOwnPropertyDescriptor(identity, "getAgentRepoWorkspacesRoot")?.value as
    | ((agentName?: string) => string)
    | undefined
  const workspacesRoot = typeof getAgentRepoWorkspacesRoot === "function"
    ? getAgentRepoWorkspacesRoot(agentName)
    : ""
  if (!workspacesRoot) return []
  return listChildDirs(workspacesRoot)
    .slice(0, DEFAULT_AGENT_WORKSPACE_SCAN_LIMIT)
    .map((workspaceDir) => path.join(workspaceDir, ".playwright-mcp"))
}

function listWorktreePoolSandboxDirs(homeDir: string): string[] {
  return findWorktreePools(homeDir, DEFAULT_WORKTREE_POOL_SEARCH_DEPTH)
    .flatMap((poolDir) => listChildDirs(poolDir))
    .map((worktreeDir) => path.join(worktreeDir, ".playwright-mcp"))
}

export function defaultMailImportDiscoveryDirs(input: MailImportDiscoverySearchInput = {}): string[] {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd())
  const homeDir = path.resolve(input.homeDir ?? os.homedir())
  return [...new Set([
    path.join(repoRoot, ".playwright-mcp"),
    ...listAgentWorkspaceSandboxDirs(input.agentName),
    ...listWorktreePoolSandboxDirs(homeDir),
    path.join(homeDir, ".playwright-mcp"),
    path.join(homeDir, "Downloads"),
  ].map((dir) => path.resolve(dir)))]
}

export function listDiscoveredMboxCandidates(dir: string): DiscoveredMboxCandidate[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mbox"))
      .map((entry) => {
        const candidatePath = path.join(dir, entry.name)
        const stat = fs.statSync(candidatePath)
        return { path: candidatePath, name: entry.name, mtimeMs: stat.mtimeMs }
      })
  } catch {
    return []
  }
}

function normalizeMboxDiscoveryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function tokenizeMboxDiscoveryHint(value?: string): string[] {
  if (!value) return []
  return normalizeMboxDiscoveryText(value)
    .split(" ")
    .filter((token) => token.length > 0)
}

function scoreDiscoveredMboxCandidate(
  fileName: string,
  mtimeMs: number,
  ownerEmail?: string,
  source?: string,
): number {
  const normalized = normalizeMboxDiscoveryText(fileName)
  const ownerTokens = tokenizeMboxDiscoveryHint(ownerEmail)
  const sourceTokens = tokenizeMboxDiscoveryHint(source)
  const ownerScore = ownerTokens.reduce((score, token) => score + (normalized.includes(token) ? 50 : 0), 0)
  const sourceScore = sourceTokens.reduce((score, token) => score + (normalized.includes(token) ? 20 : 0), 0)
  const recencyScore = Math.floor(mtimeMs / 1000)
  return ownerScore + sourceScore + recencyScore
}

export function rankDiscoveredMboxCandidates(
  candidates: DiscoveredMboxCandidate[],
  ownerEmail?: string,
  source?: string,
): Array<{ path: string; score: number }> {
  return candidates
    .map((candidate) => ({
      path: candidate.path,
      score: scoreDiscoveredMboxCandidate(candidate.name, candidate.mtimeMs, ownerEmail, source),
    }))
    .sort((left, right) => right.score - left.score)
}

export function discoverMailImportFilePath(input: {
  agentName?: string
  ownerEmail?: string
  source?: string
  repoRoot?: string
  homeDir?: string
}): string {
  const searchDirs = defaultMailImportDiscoveryDirs({
    agentName: input.agentName,
    repoRoot: input.repoRoot,
    homeDir: input.homeDir,
  })
  const candidates = searchDirs.flatMap((dir) => listDiscoveredMboxCandidates(dir))
  const ranked = rankDiscoveredMboxCandidates(candidates, input.ownerEmail, input.source)
  if (ranked.length === 0) {
    throw new Error(`could not discover an MBOX file in ${searchDirs.join(", ")}`)
  }
  const topScore = ranked[0]!.score
  const topCandidates = ranked.filter((candidate) => candidate.score === topScore)
  if (topCandidates.length > 1) {
    throw new Error(`multiple candidate MBOX files found: ${topCandidates.map((candidate) => candidate.path).join(", ")}`)
  }
  return topCandidates[0]!.path
}

function summarizeAmbientImportCandidates(
  candidates: DiscoveredMboxCandidate[],
  candidateLimit: number,
): { summary: string; detail: string; spec: Record<string, unknown> } {
  const visibleCandidates = candidates.slice(0, candidateLimit)
  const hiddenCount = Math.max(0, candidates.length - visibleCandidates.length)
  const summary = visibleCandidates.length === 1
    ? "recent MBOX archive ready for import"
    : `${visibleCandidates.length} recent MBOX archives ready for import`
  const detailLines = [
    "recent candidates:",
    ...visibleCandidates.map((candidate) => `- ${candidate.path}`),
    ...(hiddenCount > 0 ? [`- ...and ${hiddenCount} more recent archive${hiddenCount === 1 ? "" : "s"}`] : []),
    "next: if one matches an outstanding mail backfill, run `ouro mail import-mbox --discover` with owner/source hints so Ouro can select the right archive or report ambiguity.",
  ]
  return {
    summary,
    detail: detailLines.join("\n"),
    spec: {
      fingerprint: recentImportFingerprint(candidates),
      candidatePaths: visibleCandidates.map((candidate) => candidate.path),
      newestCandidatePath: visibleCandidates[0]?.path ?? null,
      newestCandidateMtime: visibleCandidates[0] ? new Date(visibleCandidates[0].mtimeMs).toISOString() : null,
    },
  }
}

export function listAmbientMailImportOperations(input: AmbientMailImportOperationsInput): BackgroundOperationRecord[] {
  const existingOperations = input.existingOperations ?? []
  const hasLiveImport = existingOperations.some((operation) =>
    operation.kind === "mail.import-mbox"
    && (operation.status === "queued" || operation.status === "running"),
  )
  if (hasLiveImport) return []

  const nowMs = input.nowMs ?? Date.now()
  const recentWindowMs = input.recentWindowMs ?? DEFAULT_RECENT_IMPORT_WINDOW_MS
  const candidateLimit = input.candidateLimit ?? DEFAULT_VISIBLE_IMPORT_CANDIDATE_LIMIT
  const recentCandidates = defaultMailImportDiscoveryDirs({
    agentName: input.agentName,
    repoRoot: input.repoRoot,
    homeDir: input.homeDir,
  })
    .flatMap((dir) => listDiscoveredMboxCandidates(dir))
    .filter((candidate) => (nowMs - candidate.mtimeMs) <= recentWindowMs)
    .filter((candidate) => !existingOperations.some((operation) => candidateAlreadyCoveredByOperation(candidate, operation)))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)

  if (recentCandidates.length === 0) return []

  const newestCandidate = recentCandidates[0]!
  const rendered = summarizeAmbientImportCandidates(recentCandidates, candidateLimit)
  return [{
    schemaVersion: 1,
    id: "ambient_mail_import_ready",
    agentName: input.agentName,
    kind: "mail.import-discovered",
    title: "mail import ready",
    status: "queued",
    summary: rendered.summary,
    detail: rendered.detail,
    createdAt: new Date(newestCandidate.mtimeMs).toISOString(),
    updatedAt: new Date(newestCandidate.mtimeMs).toISOString(),
    spec: rendered.spec,
  }]
}

export function listVisibleBackgroundOperations(input: VisibleBackgroundOperationsInput): BackgroundOperationRecord[] {
  const limit = input.limit ?? DEFAULT_VISIBLE_BACKGROUND_OPERATION_LIMIT
  const persisted = listBackgroundOperations({
    agentName: input.agentName,
    agentRoot: input.agentRoot,
    limit,
  })
  const ambient = listAmbientMailImportOperations({
    agentName: input.agentName,
    agentRoot: input.agentRoot,
    existingOperations: persisted,
    repoRoot: input.repoRoot,
    homeDir: input.homeDir,
    nowMs: input.nowMs,
    recentWindowMs: input.recentWindowMs,
    candidateLimit: input.candidateLimit,
  })
  return [...persisted, ...ambient]
    .sort(sortBackgroundOperationsNewestFirst)
    .slice(0, limit)
}
