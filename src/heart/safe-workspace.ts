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
  workspaceBranch: string
  sourceBranch: string | null
  sourceCloneUrl: string
  cleanupAfterMerge: boolean
  created: boolean
  note: string
}

export interface SafeShellExecution {
  selection: SafeWorkspaceSelection | null
  command: string
  cwd?: string
}

export interface EnsureSafeWorkspaceOptions {
  repoRoot?: string
  agentName?: string
  canonicalRepoUrl?: string
  workspaceRoot?: string
  persistSelection?: boolean
  spawnSync?: typeof defaultSpawnSync
  existsSync?: typeof fs.existsSync
  mkdirSync?: typeof fs.mkdirSync
  rmSync?: typeof fs.rmSync
  readFileSync?: typeof fs.readFileSync
  writeFileSync?: typeof fs.writeFileSync
  unlinkSync?: typeof fs.unlinkSync
  now?: () => number
}

export interface ResolveSafePathOptions extends EnsureSafeWorkspaceOptions {
  requestedPath: string
}

let activeSelection: SafeWorkspaceSelection | null = null
let cleanupHookRegistered = false

function workspaceSelectionStateFile(workspaceBase: string): string {
  return path.join(workspaceBase, ".active-safe-workspace.json")
}

function getOptionalFsFn<T>(name: string): T | undefined {
  try {
    return (fs as Record<string, unknown>)[name] as T | undefined
  } catch {
    return undefined
  }
}

function shouldPersistSelection(options: EnsureSafeWorkspaceOptions): boolean {
  return options.persistSelection ?? options.workspaceRoot === undefined
}

function isPersistedSelectionShape(value: unknown): value is SafeWorkspaceSelection {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<SafeWorkspaceSelection>
  return (
    typeof candidate.runtimeKind === "string"
    && typeof candidate.repoRoot === "string"
    && typeof candidate.workspaceRoot === "string"
    && typeof candidate.workspaceBranch === "string"
    && (candidate.sourceBranch === null || typeof candidate.sourceBranch === "string")
    && typeof candidate.sourceCloneUrl === "string"
    && typeof candidate.cleanupAfterMerge === "boolean"
    && typeof candidate.created === "boolean"
    && typeof candidate.note === "string"
  )
}

function loadPersistedSelection(
  workspaceBase: string,
  options: Pick<EnsureSafeWorkspaceOptions, "existsSync" | "readFileSync" | "unlinkSync">,
): SafeWorkspaceSelection | null {
  const existsSync = options.existsSync ?? fs.existsSync
  const readFileSync = options.readFileSync ?? getOptionalFsFn<typeof fs.readFileSync>("readFileSync")
  const unlinkSync = options.unlinkSync ?? getOptionalFsFn<typeof fs.unlinkSync>("unlinkSync")
  const stateFile = workspaceSelectionStateFile(workspaceBase)

  if (!existsSync(stateFile)) return null
  if (!readFileSync) return null

  try {
    const raw = readFileSync(stateFile, "utf-8")
    const parsed = JSON.parse(raw)
    if (!isPersistedSelectionShape(parsed) || !existsSync(parsed.workspaceRoot)) {
      try {
        unlinkSync?.(stateFile)
      } catch {
        // best effort
      }
      return null
    }
    return parsed
  } catch {
    try {
      unlinkSync?.(stateFile)
    } catch {
      // best effort
    }
    return null
  }
}

function persistSelectionState(
  workspaceBase: string,
  selection: SafeWorkspaceSelection,
  options: Pick<EnsureSafeWorkspaceOptions, "mkdirSync" | "writeFileSync">,
): void {
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync
  const writeFileSync = options.writeFileSync ?? getOptionalFsFn<typeof fs.writeFileSync>("writeFileSync")
  if (!writeFileSync) return
  mkdirSync(workspaceBase, { recursive: true })
  writeFileSync(workspaceSelectionStateFile(workspaceBase), JSON.stringify(selection, null, 2), "utf-8")
}

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
): { workspaceRoot: string; created: boolean; branchName: string } {
  mkdirSync(path.dirname(workspaceRoot), { recursive: true })
  const branchName = `slugger/${branchSuffix}`

  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }

  assertGitOk(
    runGit(repoRoot, ["worktree", "add", "-B", branchName, workspaceRoot, "origin/main"], spawnSync),
    "git worktree add",
  )

  return { workspaceRoot, created: true, branchName } as const
}

function createScratchClone(
  workspaceRoot: string,
  cloneUrl: string,
  existsSync: typeof fs.existsSync,
  mkdirSync: typeof fs.mkdirSync,
  rmSync: typeof fs.rmSync,
  spawnSync: typeof defaultSpawnSync,
): { workspaceRoot: string; created: boolean; branchName: string } {
  mkdirSync(path.dirname(workspaceRoot), { recursive: true })
  if (existsSync(workspaceRoot)) {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }

  const result = spawnSync("git", ["clone", "--depth", "1", "--branch", "main", cloneUrl, workspaceRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  assertGitOk(result, "git clone")
  return { workspaceRoot, created: true, branchName: "main" } as const
}

const REPO_LOCAL_SHELL_COMMAND = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(git|npm|npx|node|pnpm|yarn|bun|rg|sed|cat|ls|find|grep|vitest|tsc|eslint)\b/

function looksRepoLocalShellCommand(command: string): boolean {
  return REPO_LOCAL_SHELL_COMMAND.test(command.trim())
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

export function resetSafeWorkspaceSelection(options: { keepCleanupHookRegistered?: boolean } = {}): void {
  activeSelection = null
  if (!options.keepCleanupHookRegistered) {
    cleanupHookRegistered = false
  }
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
  const persistSelection = shouldPersistSelection(options)
  const spawnSync = options.spawnSync ?? defaultSpawnSync
  const existsSync = options.existsSync ?? fs.existsSync
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync
  const rmSync = options.rmSync ?? fs.rmSync
  const now = options.now ?? defaultNow
  const stamp = String(now())

  registerCleanupHook({ rmSync })

  if (persistSelection) {
    const restored = loadPersistedSelection(workspaceBase, options)
    if (restored) {
      activeSelection = restored
      emitNervesEvent({
        component: "workspace",
        event: "workspace.safe_repo_restored",
        message: "restored safe repo workspace after runtime restart",
        meta: {
          runtimeKind: restored.runtimeKind,
          repoRoot: restored.repoRoot,
          workspaceRoot: restored.workspaceRoot,
          workspaceBranch: restored.workspaceBranch,
          sourceBranch: restored.sourceBranch,
          cleanupAfterMerge: restored.cleanupAfterMerge,
        },
      })
      return restored
    }
  }

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
        workspaceBranch: created.branchName,
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
        workspaceBranch: created.branchName,
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
      workspaceBranch: created.branchName,
      sourceBranch: null,
      sourceCloneUrl: canonicalRepoUrl,
      cleanupAfterMerge: true,
      created: created.created,
      note: `running from installed runtime/wrapper; created scratch clone ${created.workspaceRoot} from ${canonicalRepoUrl}`,
    }
  }

  activeSelection = selection
  if (persistSelection) {
    persistSelectionState(workspaceBase, selection, options)
  }
  emitNervesEvent({
    component: "workspace",
    event: "workspace.safe_repo_acquired",
    message: "acquired safe repo workspace before local edits",
    meta: {
      runtimeKind: selection.runtimeKind,
      repoRoot: selection.repoRoot,
      workspaceRoot: selection.workspaceRoot,
      workspaceBranch: selection.workspaceBranch,
      sourceBranch: selection.sourceBranch,
      sourceCloneUrl: selection.sourceCloneUrl,
      cleanupAfterMerge: selection.cleanupAfterMerge,
    },
  })
  return selection
}

export function resolveSafeRepoPath(options: ResolveSafePathOptions): { selection: SafeWorkspaceSelection | null; resolvedPath: string } {
  const rawRequestedPath = options.requestedPath
  const repoRoot = path.resolve(options.repoRoot ?? getRepoRoot())

  if (!path.isAbsolute(rawRequestedPath) && !rawRequestedPath.startsWith("~")) {
    const selection = activeSelection ?? ensureSafeRepoWorkspace(options)
    return {
      selection,
      resolvedPath: path.resolve(selection.workspaceRoot, rawRequestedPath),
    }
  }

  const requestedPath = path.resolve(rawRequestedPath)

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

export function resolveSafeShellExecution(command: string, options: EnsureSafeWorkspaceOptions = {}): SafeShellExecution {
  const trimmed = command.trim()
  if (!trimmed) {
    return { selection: activeSelection, command }
  }

  if (activeSelection && command.includes(activeSelection.workspaceRoot)) {
    return { selection: activeSelection, command, cwd: activeSelection.workspaceRoot }
  }

  const repoRoot = path.resolve(options.repoRoot ?? getRepoRoot())
  const mentionsRepoRoot = command.includes(repoRoot)
  const shouldRoute = mentionsRepoRoot || looksRepoLocalShellCommand(trimmed)
  if (!shouldRoute) {
    return { selection: activeSelection, command }
  }

  const selection = ensureSafeRepoWorkspace(options)
  const rewrittenCommand = mentionsRepoRoot
    ? command.split(repoRoot).join(selection.workspaceRoot)
    : command

  return {
    selection,
    command: rewrittenCommand,
    cwd: selection.workspaceRoot,
  }
}
