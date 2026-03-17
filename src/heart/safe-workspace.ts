import * as fs from "fs"
import * as path from "path"
import { spawnSync as defaultSpawnSync, type SpawnSyncReturns } from "child_process"
import {
  getAgentName,
  getAgentRepoWorkspacesRoot,
  getRepoRoot,
  HARNESS_CANONICAL_REPO_URL,
} from "./identity"
import { emitNervesEvent } from "../nerves/runtime"

export interface SafeWorkspaceSelection {
  runtimeKind: "clone-main" | "clone-non-main" | "installed-runtime"
  repoRoot: string
  workspaceRoot: string
  sourceBranch: string | null
  sourceCloneUrl: string
  cleanupAfterMerge: boolean
  created: boolean
  note: string
}

export interface EnsureSafeWorkspaceOptions {
  repoRoot?: string
  agentName?: string
  canonicalRepoUrl?: string
  workspaceRoot?: string
  spawnSync?: typeof defaultSpawnSync
  existsSync?: typeof fs.existsSync
  mkdirSync?: typeof fs.mkdirSync
  rmSync?: typeof fs.rmSync
  now?: () => number
}

export interface ResolveSafePathOptions extends EnsureSafeWorkspaceOptions {
  requestedPath: string
}

let activeSelection: SafeWorkspaceSelection | null = null
let cleanupHookRegistered = false

function defaultNow(): number {
  return Date.now()
}

function resolveAgentName(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim()
  try {
    return getAgentName()
  } catch {
    return "slugger"
  }
}

function runGit(
  cwd: string,
  args: string[],
  spawnSync: typeof defaultSpawnSync,
): SpawnSyncReturns<Buffer> {
  return spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
}

function readStdout(result: SpawnSyncReturns<Buffer>): string {
  return (result.stdout ?? Buffer.from("")).toString("utf-8").trim()
}

function readStderr(result: SpawnSyncReturns<Buffer>): string {
  return (result.stderr ?? Buffer.from("")).toString("utf-8").trim()
}

function assertGitOk(result: SpawnSyncReturns<Buffer>, action: string): string {
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const detail = readStderr(result) || readStdout(result) || `exit ${result.status ?? "unknown"}`
    throw new Error(`${action} failed: ${detail}`)
  }
  return readStdout(result)
}

function isGitClone(repoRoot: string, spawnSync: typeof defaultSpawnSync): boolean {
  const result = runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], spawnSync)
  return result.status === 0 && readStdout(result) === "true"
}

function readCurrentBranch(repoRoot: string, spawnSync: typeof defaultSpawnSync): string {
  return assertGitOk(runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], spawnSync), "git branch read")
}

function ensureFetchedOrigin(repoRoot: string, spawnSync: typeof defaultSpawnSync): void {
  assertGitOk(runGit(repoRoot, ["fetch", "origin"], spawnSync), "git fetch origin")
}

function ensureMainFastForward(repoRoot: string, spawnSync: typeof defaultSpawnSync): void {
  assertGitOk(runGit(repoRoot, ["pull", "--ff-only", "origin", "main"], spawnSync), "git pull --ff-only origin main")
}

function createDedicatedWorktree(
  repoRoot: string,
  workspaceRoot: string,
  branchSuffix: string,
  existsSync: typeof fs.existsSync,
  mkdirSync: typeof fs.mkdirSync,
  rmSync: typeof fs.rmSync,
  spawnSync: typeof defaultSpawnSync,
): { workspaceRoot: string; created: boolean } {
  mkdirSync(path.dirname(workspaceRoot), { recursive: true })
  const branchName = `slugger/${branchSuffix}`

  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }

  assertGitOk(
    runGit(repoRoot, ["worktree", "add", "-B", branchName, workspaceRoot, "origin/main"], spawnSync),
    "git worktree add",
  )

  return { workspaceRoot, created: true }
}

function createScratchClone(
  workspaceRoot: string,
  cloneUrl: string,
  existsSync: typeof fs.existsSync,
  mkdirSync: typeof fs.mkdirSync,
  rmSync: typeof fs.rmSync,
  spawnSync: typeof defaultSpawnSync,
): { workspaceRoot: string; created: boolean } {
  mkdirSync(path.dirname(workspaceRoot), { recursive: true })
  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }

  const result = spawnSync("git", ["clone", "--depth", "1", "--branch", "main", cloneUrl, workspaceRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  assertGitOk(result, "git clone")
  return { workspaceRoot, created: true }
}

function registerCleanupHook(options: {
  rmSync: typeof fs.rmSync
}): void {
  if (cleanupHookRegistered) return
  cleanupHookRegistered = true

  process.on("exit", () => {
    if (!activeSelection?.cleanupAfterMerge) return
    try {
      options.rmSync(activeSelection.workspaceRoot, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
}

export function resetSafeWorkspaceSelection(): void {
  activeSelection = null
}

export function getActiveSafeWorkspaceSelection(): SafeWorkspaceSelection | null {
  return activeSelection
}

export function ensureSafeRepoWorkspace(options: EnsureSafeWorkspaceOptions = {}): SafeWorkspaceSelection {
  if (activeSelection) {
    return activeSelection
  }

  const repoRoot = options.repoRoot ?? getRepoRoot()
  const agentName = resolveAgentName(options.agentName)
  const canonicalRepoUrl = options.canonicalRepoUrl ?? HARNESS_CANONICAL_REPO_URL
  const workspaceBase = options.workspaceRoot ?? getAgentRepoWorkspacesRoot(agentName)
  const spawnSync = options.spawnSync ?? defaultSpawnSync
  const existsSync = options.existsSync ?? fs.existsSync
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync
  const rmSync = options.rmSync ?? fs.rmSync
  const now = options.now ?? defaultNow
  const stamp = String(now())

  registerCleanupHook({ rmSync })

  let selection: SafeWorkspaceSelection

  if (isGitClone(repoRoot, spawnSync)) {
    const branch = readCurrentBranch(repoRoot, spawnSync)
    ensureFetchedOrigin(repoRoot, spawnSync)

    if (branch === "main") {
      ensureMainFastForward(repoRoot, spawnSync)
      const worktreeRoot = path.join(workspaceBase, `ouroboros-main-${stamp}`)
      const created = createDedicatedWorktree(
        repoRoot,
        worktreeRoot,
        `safe-workspace-${stamp}`,
        existsSync,
        mkdirSync,
        rmSync,
        spawnSync,
      )
      selection = {
        runtimeKind: "clone-main",
        repoRoot,
        workspaceRoot: created.workspaceRoot,
        sourceBranch: branch,
        sourceCloneUrl: canonicalRepoUrl,
        cleanupAfterMerge: false,
        created: created.created,
        note: `running from clone on main; fast-forwarded and created dedicated worktree ${created.workspaceRoot}`,
      }
    } else {
      const worktreeRoot = path.join(workspaceBase, `ouroboros-origin-main-${stamp}`)
      const created = createDedicatedWorktree(
        repoRoot,
        worktreeRoot,
        `safe-workspace-${stamp}`,
        existsSync,
        mkdirSync,
        rmSync,
        spawnSync,
      )
      selection = {
        runtimeKind: "clone-non-main",
        repoRoot,
        workspaceRoot: created.workspaceRoot,
        sourceBranch: branch,
        sourceCloneUrl: canonicalRepoUrl,
        cleanupAfterMerge: false,
        created: created.created,
        note: `running from branch ${branch}; defaulted new work from origin/main in dedicated worktree ${created.workspaceRoot}`,
      }
    }
  } else {
    const scratchRoot = path.join(workspaceBase, `ouroboros-scratch-${stamp}`)
    const created = createScratchClone(scratchRoot, canonicalRepoUrl, existsSync, mkdirSync, rmSync, spawnSync)
    selection = {
      runtimeKind: "installed-runtime",
      repoRoot,
      workspaceRoot: created.workspaceRoot,
      sourceBranch: null,
      sourceCloneUrl: canonicalRepoUrl,
      cleanupAfterMerge: true,
      created: created.created,
      note: `running from installed runtime/wrapper; created scratch clone ${created.workspaceRoot} from ${canonicalRepoUrl}`,
    }
  }

  activeSelection = selection
  emitNervesEvent({
    component: "workspace",
    event: "workspace.safe_repo_acquired",
    message: "acquired safe repo workspace before local edits",
    meta: {
      runtimeKind: selection.runtimeKind,
      repoRoot: selection.repoRoot,
      workspaceRoot: selection.workspaceRoot,
      sourceBranch: selection.sourceBranch,
      sourceCloneUrl: selection.sourceCloneUrl,
      cleanupAfterMerge: selection.cleanupAfterMerge,
    },
  })
  return selection
}

export function resolveSafeRepoPath(options: ResolveSafePathOptions): { selection: SafeWorkspaceSelection | null; resolvedPath: string } {
  const requestedPath = path.resolve(options.requestedPath)
  const repoRoot = path.resolve(options.repoRoot ?? getRepoRoot())

  if (activeSelection && requestedPath.startsWith(activeSelection.workspaceRoot + path.sep)) {
    return { selection: activeSelection, resolvedPath: requestedPath }
  }

  if (requestedPath !== repoRoot && !requestedPath.startsWith(repoRoot + path.sep)) {
    return { selection: activeSelection, resolvedPath: requestedPath }
  }

  const selection = ensureSafeRepoWorkspace(options)
  const relativePath = requestedPath === repoRoot ? "" : path.relative(repoRoot, requestedPath)
  const resolvedPath = relativePath ? path.join(selection.workspaceRoot, relativePath) : selection.workspaceRoot
  return { selection, resolvedPath }
}
