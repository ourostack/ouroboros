import { execFile, execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { SyncConfig } from "./config"
import type { SyncClassification } from "./sync-classification"
import { parseBundleSyncFailure, type BundleSyncFailure } from "./sync-health"

export interface SyncResult {
  ok: boolean
  error?: string
}

/**
 * On-disk schema for `state/pending-sync.json`. Written whenever a
 * post-turn sync fails (status, commit or push) and removed only when a
 * later sync succeeds, so the agent, `ouro status` and the daemon health
 * check keep seeing the failure until it is fixed.
 *
 * Backward compat: readers should tolerate entries without `classification`
 * or `conflictFiles` (pre-alpha.289 schema) — they fall back to "unknown".
 *
 * Layer 2 extension: `classification` now widens to the full
 * `SyncClassification` union from `sync-classification.ts`. The legacy
 * three-variant set (`push_rejected | pull_rebase_conflict | unknown`)
 * is still emitted by `postTurnPush`'s existing call sites — adding
 * the new variants is additive, so existing readers keep working as
 * long as a producer doesn't hand them a Layer-2-only variant.
 */
export interface PendingSyncRecord {
  error: string
  failedAt: string
  classification: SyncClassification
  conflictFiles: string[]
  /**
   * When the current run of failures began. The record stays on disk until a
   * sync succeeds, so a failure that repeats for weeks keeps its first date.
   * Records written before alpha.901 omit it; readers fall back to `failedAt`.
   */
  firstFailedAt?: string
  /** Failed sync attempts in a row, counting this one. Missing means 1. */
  consecutiveFailures?: number
}

/** A changed file that sync left out of its commit because of its size. */
export interface SkippedSyncFile {
  path: string
  bytes: number
}

/** On-disk schema for `state/sync-skipped-files.json`. */
export interface SkippedSyncFilesRecord {
  updatedAt: string
  limitBytes: number
  files: SkippedSyncFile[]
}

/**
 * Sync never commits a file larger than this. GitHub rejects any push that
 * contains a file over 100 MiB and warns above 50 MiB; one such file in an
 * unpushed commit blocks every later push from the bundle. The guard leaves
 * the file in the working tree, uncommitted, and records it.
 */
export const SYNC_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024

/**
 * Output buffer for git commands whose output grows with the number of
 * changed files. Node's 1 MiB default made `git status` fail with ENOBUFS
 * once a bundle held about 30,000 changed files, which stopped sync.
 */
export const SYNC_GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024

/**
 * Timeout for sync's add, commit, push and pull. `git add -A` took 17 s on a
 * bundle with 30,000 changed files, past the old 10 s limit.
 */
export const SYNC_GIT_TIMEOUT_MS = 120_000

export function pendingSyncPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "pending-sync.json")
}

export function skippedSyncFilesPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "sync-skipped-files.json")
}

function readPreviousFailure(agentRoot: string): BundleSyncFailure | null {
  try {
    return parseBundleSyncFailure(JSON.parse(fs.readFileSync(pendingSyncPath(agentRoot), "utf-8")) as unknown)
  } catch {
    return null
  }
}

function writePendingSync(
  agentRoot: string,
  error: string,
  classification: PendingSyncRecord["classification"],
  conflictFiles: string[],
): void {
  const previous = readPreviousFailure(agentRoot)
  const failedAt = new Date().toISOString()
  const previousFirst = previous && previous.firstFailedAt !== "unknown" ? previous.firstFailedAt : null
  fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
  const record: PendingSyncRecord = {
    error,
    failedAt,
    classification,
    conflictFiles,
    firstFailedAt: previousFirst ?? failedAt,
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
  }
  fs.writeFileSync(pendingSyncPath(agentRoot), JSON.stringify(record, null, 2), "utf-8")
}

function recordPendingSync(
  agentRoot: string,
  error: string,
  classification: PendingSyncRecord["classification"],
  conflictFiles: string[],
): void {
  try {
    writePendingSync(agentRoot, error, classification, conflictFiles)
  } catch {
    // Best effort: the caller's nerves event still records the failure.
  }
}

/**
 * Remove `state/pending-sync.json` after a sync that reached the remote (or
 * committed, for a local-only bundle). The record otherwise stays, so the
 * start-of-turn packet, `ouro status` and the daemon health check keep
 * reporting the failure until it is fixed.
 */
export function clearPendingSync(agentRoot: string): void {
  try {
    fs.rmSync(pendingSyncPath(agentRoot), { force: true })
  } catch {
    // Best effort: a stale record is reported again and cleared next time.
  }
}

function writeSkippedSyncFiles(agentRoot: string, files: SkippedSyncFile[]): void {
  try {
    if (files.length === 0) {
      fs.rmSync(skippedSyncFilesPath(agentRoot), { force: true })
      return
    }
    fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
    const record: SkippedSyncFilesRecord = {
      updatedAt: new Date().toISOString(),
      limitBytes: SYNC_FILE_SIZE_LIMIT_BYTES,
      files,
    }
    fs.writeFileSync(skippedSyncFilesPath(agentRoot), JSON.stringify(record, null, 2), "utf-8")
  } catch {
    // Best effort: the nerves event emitted by the caller names the files.
  }
}

interface StagedChange {
  status: string
  path: string
  /** For a rename or copy: the path it came from. */
  fromPath?: string
}

/** Parse `git diff --cached --name-status -z` output. */
function parseStagedChanges(output: string): StagedChange[] {
  const tokens = output.split("\0").filter((entry) => entry.length > 0)
  const changes: StagedChange[] = []
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index]
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({ status, fromPath: tokens[index + 1], path: tokens[index + 2] })
      index += 3
    } else {
      changes.push({ status, path: tokens[index + 1] })
      index += 2
    }
  }
  return changes
}

/**
 * Unstage every staged file larger than `SYNC_FILE_SIZE_LIMIT_BYTES`. The
 * file stays in the working tree and the previous committed version, if any,
 * stays in the index, so nothing is deleted on other machines. For a rename,
 * the deletion of the old path is unstaged too; otherwise the remote would
 * lose the old path while never receiving the new one.
 */
function unstageOversizedFiles(agentRoot: string): SkippedSyncFile[] {
  const changes = parseStagedChanges(execFileSync("git", ["diff", "--cached", "--name-status", "-M", "-z"], {
    cwd: agentRoot,
    stdio: "pipe",
    timeout: SYNC_GIT_TIMEOUT_MS,
    maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
  }).toString())

  const oversized: SkippedSyncFile[] = []
  const unstage: string[] = []
  for (const change of changes) {
    if (change.status.startsWith("D")) continue
    let bytes: number
    try {
      bytes = fs.lstatSync(path.join(agentRoot, change.path)).size
    } catch {
      continue
    }
    if (bytes <= SYNC_FILE_SIZE_LIMIT_BYTES) continue
    oversized.push({ path: change.path, bytes })
    unstage.push(change.path)
    if (change.status.startsWith("R") && change.fromPath) unstage.push(change.fromPath)
  }
  if (oversized.length === 0) return oversized

  execFileSync("git", ["--literal-pathspecs", "reset", "-q", "--", ...unstage], {
    cwd: agentRoot,
    stdio: "pipe",
    timeout: SYNC_GIT_TIMEOUT_MS,
  })
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_oversized_files_skipped",
    message: "post-turn push: left files over the sync size limit uncommitted",
    meta: { agentRoot, limitBytes: SYNC_FILE_SIZE_LIMIT_BYTES, files: oversized },
  })
  return oversized
}

function hasStagedChanges(agentRoot: string): boolean {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: SYNC_GIT_TIMEOUT_MS,
    })
    return false
  } catch {
    return true
  }
}

function collectRebaseConflictFiles(agentRoot: string): string[] {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
      maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
    }).toString()
    const files: string[] = []
    for (const line of output.split("\n")) {
      // Unmerged paths in porcelain v1 are prefixed with UU/AA/DD/AU/UA/DU/UD
      if (/^(UU|AA|DD|AU|UA|DU|UD) /.test(line)) {
        files.push(line.slice(3).trim())
      }
    }
    return files
  } catch {
    /* v8 ignore next -- git status --porcelain failure inside a repo would require a corrupt repo @preserve */
    return []
  }
}

/**
 * Check whether the bundle is initialized as a git repo.
 * Used by both pre-turn pull and post-turn push to surface a clear,
 * actionable error when sync is enabled but the user never ran `git init`
 * inside their bundle. This error is propagated all the way into the
 * agent's start-of-turn packet as a Sync warning, so the agent can
 * either ask the user or run `git init` itself.
 */
function ensureGitRepo(agentRoot: string): SyncResult {
  if (fs.existsSync(path.join(agentRoot, ".git"))) {
    return { ok: true }
  }
  const error = `bundle is not a git repo; run \`git init\` inside ${agentRoot} to enable sync (or disable sync in agent.json)`
  return { ok: false, error }
}

/**
 * Git holds `.git/index.lock` for milliseconds to seconds, and every git call
 * in this module has a timeout of 30s or less. A lock older than this was left
 * behind by a git process that died mid-write; while it exists every `git add`
 * fails, which silently stopped one bundle's sync for three months.
 */
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000

// Only an empty lock is removed: git writes the new index into the lock right
// after creating it, while a live `git commit` waiting in an editor holds a
// full, unchanging lock that can be older than the threshold. When `.git` is a
// gitdir file (worktree), statSync fails and the lock is left alone.
function clearStaleIndexLock(agentRoot: string): void {
  const lockPath = path.join(agentRoot, ".git", "index.lock")
  let ageMs: number
  try {
    const stat = fs.statSync(lockPath)
    if (stat.size !== 0) return
    ageMs = Date.now() - stat.mtimeMs
  } catch {
    return
  }
  if (ageMs < STALE_INDEX_LOCK_MS) return
  try {
    fs.rmSync(lockPath, { force: true })
  } catch (err) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_stale_lock_clear_failed",
      message: "post-turn push: could not remove stale git index.lock",
      meta: { agentRoot, lockPath, error: err instanceof Error ? err.message : /* v8 ignore next -- defensive non-Error catch @preserve */ String(err) },
    })
    return
  }
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_stale_lock_cleared",
    message: "post-turn push: removed stale git index.lock",
    meta: { agentRoot, lockPath, ageMs },
  })
}

/**
 * Pre-turn pull: sync the agent bundle from remote before assembling the start-of-turn packet.
 *
 * If the bundle has no git remote configured, the pull is skipped and the function
 * returns ok — matching the no-remote behavior of postTurnPush. This supports the
 * "local-only sync" mode where the bundle accumulates a commit log without ever
 * pushing or pulling from a remote.
 */
export function preTurnPull(agentRoot: string, config: SyncConfig): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_pull_start",
    message: "pre-turn pull starting",
    meta: { agentRoot, remote: config.remote },
  })

  // Check that the bundle is actually a git repo before touching git at all.
  // Surfaces a clear, actionable error via syncFailure → start-of-turn packet
  // so the agent can propose running `git init` (or just do it).
  const repoCheck = ensureGitRepo(agentRoot)
  if (!repoCheck.ok) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_not_a_repo",
      message: "pre-turn pull failed: bundle is not a git repo",
      meta: { agentRoot },
    })
    return repoCheck
  }

  // Check if any remote is configured. If not, skip the pull (local-only mode).
  try {
    const remoteOutput = execFileSync("git", ["remote"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()

    if (remoteOutput.length === 0) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_pull_end",
        message: "pre-turn pull skipped: no remote configured",
        meta: { agentRoot },
      })
      return { ok: true }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_error",
      message: "pre-turn pull failed: git remote check failed",
      meta: { agentRoot, error },
    })

    return { ok: false, error }
  }

  try {
    execFileSync("git", ["pull", config.remote], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 30000,
    })

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_end",
      message: "pre-turn pull complete",
      meta: { agentRoot },
    })

    return { ok: true }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_error",
      message: "pre-turn pull failed",
      meta: { agentRoot, error },
    })

    return { ok: false, error }
  }
}

/**
 * Post-turn push: discover dirty files via `git status`, commit, and push.
 * Uses git-status-based discovery instead of explicit path tracking, ensuring
 * all file writers are captured regardless of whether they call a tracking API.
 */
export function postTurnPush(agentRoot: string, config: SyncConfig): SyncResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_start",
    message: "post-turn push starting",
    meta: { agentRoot, remote: config.remote },
  })

  // Same git-repo check as preTurnPull. This is the more common failure path
  // since postTurnPush runs after every turn while preTurnPull only runs on
  // user-initiated turns. Prior to this guard, an un-init'd bundle would fail
  // the git-status invocation below with a generic "not a git repository"
  // error; now we catch it explicitly with an actionable message.
  const repoCheck = ensureGitRepo(agentRoot)
  if (!repoCheck.ok) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_not_a_repo",
      message: "post-turn push failed: bundle is not a git repo",
      meta: { agentRoot },
    })
    return repoCheck
  }

  let statusOutput: string
  try {
    statusOutput = execFileSync("git", ["status", "--porcelain"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: SYNC_GIT_TIMEOUT_MS,
      maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
    }).toString().trim()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    recordPendingSync(agentRoot, error, "unknown", [])
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_error",
      message: "post-turn push: git status failed",
      meta: { agentRoot, error },
    })
    return { ok: false, error }
  }

  if (statusOutput.length === 0) {
    // Nothing to commit, so nothing is skipped for size any more.
    writeSkippedSyncFiles(agentRoot, [])
    return syncCleanTree(agentRoot, config)
  }

  const changedCount = statusOutput.split("\n").length

  clearStaleIndexLock(agentRoot)

  try {
    execFileSync("git", ["add", "-A"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: SYNC_GIT_TIMEOUT_MS,
      maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
    })

    const skippedFiles = unstageOversizedFiles(agentRoot)
    writeSkippedSyncFiles(agentRoot, skippedFiles)
    if (skippedFiles.length > 0 && !hasStagedChanges(agentRoot)) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: only oversized files changed, nothing committed",
        meta: { agentRoot, changedCount, skippedCount: skippedFiles.length },
      })
      return syncCleanTree(agentRoot, config)
    }

    // -q: without it git prints a create/delete line per file, which overran
    // the output buffer on a 30,000-file commit after the commit had landed.
    execFileSync("git", ["commit", "-q", "-m", "sync: post-turn update"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: SYNC_GIT_TIMEOUT_MS,
      maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
    })

    if (!hasRemote(agentRoot)) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: committed locally, no remote configured",
        meta: { agentRoot, changedCount },
      })
      clearPendingSync(agentRoot)
      return { ok: true }
    }

    return pushWithRebaseRetry(agentRoot, config, changedCount)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    // Record it so the start-of-turn packet surfaces the failure; otherwise a
    // failing local commit is visible only in nerves logs.
    recordPendingSync(agentRoot, error, "unknown", [])

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_error",
      message: "post-turn push failed",
      meta: { agentRoot, error },
    })

    return { ok: false, error }
  }
}

function hasRemote(agentRoot: string): boolean {
  return execFileSync("git", ["remote"], {
    cwd: agentRoot,
    stdio: "pipe",
    timeout: 5000,
  }).toString().trim().length > 0
}

/**
 * Nothing new to commit. A failure record must not outlive the problem, and
 * commits left behind by an earlier failed push still need to reach the
 * remote: with no remote, or nothing ahead of the upstream, the record is
 * cleared; with unpushed commits, the push is retried.
 */
function syncCleanTree(agentRoot: string, config: SyncConfig): SyncResult {
  try {
    if (!hasRemote(agentRoot)) {
      clearPendingSync(agentRoot)
    } else {
      const ahead = Number.parseInt(execFileSync("git", ["rev-list", "--count", "@{upstream}..HEAD"], {
        cwd: agentRoot,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim(), 10)
      if (ahead > 0) return pushWithRebaseRetry(agentRoot, config, 0)
      if (ahead === 0) clearPendingSync(agentRoot)
    }
  } catch (err) {
    // No upstream tracked (or git failed): nothing to compare against, so
    // leave any failure record as it is rather than guess.
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_upstream_unknown",
      message: "post-turn push: could not compare with upstream",
      meta: { agentRoot, error: err instanceof Error ? err.message : /* v8 ignore next -- defensive non-Error catch @preserve */ String(err) },
    })
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_end",
    message: "post-turn push: no changes to sync",
    meta: { agentRoot },
  })
  return { ok: true }
}

function pushWithRebaseRetry(agentRoot: string, config: SyncConfig, changedCount: number): SyncResult {
  try {
    execFileSync("git", ["push", config.remote], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: SYNC_GIT_TIMEOUT_MS,
      maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
    })
  } catch {
    // Push rejected -- try pull-rebase-push. --autostash: an oversized file
    // the size guard left uncommitted is an unstaged change, and a plain
    // rebase refuses to start while one exists.
    let rebaseError: string | null = null
    try {
      execFileSync("git", ["pull", "--rebase", "--autostash", config.remote], {
        cwd: agentRoot,
        stdio: "pipe",
        timeout: SYNC_GIT_TIMEOUT_MS,
        maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
      })
    } catch (err) {
      rebaseError = err instanceof Error ? err.message : String(err)
    }

    if (rebaseError === null) {
      try {
        execFileSync("git", ["push", config.remote], {
          cwd: agentRoot,
          stdio: "pipe",
          timeout: SYNC_GIT_TIMEOUT_MS,
          maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
        })
        // rebase + retry push both succeeded — fall through to success
        emitNervesEvent({
          component: "heart",
          event: "heart.sync_push_end",
          message: "post-turn push complete after rebase retry",
          meta: { agentRoot, changedCount },
        })
        clearPendingSync(agentRoot)
        return { ok: true }
      } catch (retryErr) {
        // Second push rejected — remote advanced again during rebase
        const retryError = retryErr instanceof Error ? retryErr.message : /* v8 ignore next -- defensive non-Error catch @preserve */ String(retryErr)
        recordPendingSync(agentRoot, retryError, "push_rejected", [])
        emitNervesEvent({
          component: "heart",
          event: "heart.sync_push_error",
          message: "post-turn push failed after retry: push_rejected",
          meta: { agentRoot, error: retryError, classification: "push_rejected" },
        })
        return { ok: false, error: retryError }
      }
    }

    // Rebase failed — detect conflict files via git status. Preserve
    // the original rebase error message so callers see the real cause.
    const conflictFiles = collectRebaseConflictFiles(agentRoot)
    const classification: PendingSyncRecord["classification"] =
      conflictFiles.length > 0 ? "pull_rebase_conflict" : "unknown"
    recordPendingSync(agentRoot, rebaseError, classification, conflictFiles)

    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_error",
      message: `post-turn push failed: ${classification}`,
      meta: { agentRoot, error: rebaseError, classification, conflictFiles },
    })

    return { ok: false, error: rebaseError }
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_end",
    message: "post-turn push complete",
    meta: { agentRoot, changedCount },
  })
  clearPendingSync(agentRoot)

  return { ok: true }
}

/**
 * Layer 2 — async, signal-aware sibling of `preTurnPull`.
 *
 * Used by `runBootSyncProbe` (the `ouro up` boot orchestrator) to perform
 * the pre-flight pull with end-to-end `AbortSignal` propagation. The
 * underlying `child_process.execFile` accepts the signal and kills the git
 * child process when it aborts, so a hung remote (DNS hole, slow server)
 * can be cut by the boot timeout wrapper rather than hanging the whole
 * boot.
 *
 * The legacy sync `preTurnPull` is preserved unchanged for the per-turn
 * pipeline at `src/senses/pipeline.ts:522`. The two functions share the
 * same `.git` and remote-availability gates — the only difference is the
 * pull itself: `execFileSync` (no signal) vs `execFile` + `{ signal }`.
 *
 * Honour-the-signal contract:
 *   - If `options.signal` is already aborted at call time, the pull is
 *     skipped and the result is `{ ok: false, error: "aborted" }`.
 *   - If `options.signal` aborts mid-fetch, the child receives `SIGTERM`
 *     via Node's built-in AbortSignal handling, and the result is
 *     `{ ok: false, error: <abort message> }`.
 *   - With no signal supplied, behaviour matches the sync version (subject
 *     to the small differences listed above — same git-repo / no-remote
 *     gates and same nerves events).
 */
export function preTurnPullAsync(
  agentRoot: string,
  config: SyncConfig,
  options: { signal?: AbortSignal } = {},
): Promise<SyncResult> {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_pull_start",
    message: "pre-turn pull starting (async)",
    meta: { agentRoot, remote: config.remote },
  })

  // Bail early when the caller has already aborted — saves a git invocation
  // and signals failure consistently.
  if (options.signal?.aborted) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_pull_aborted",
      message: "pre-turn pull skipped: signal already aborted",
      meta: { agentRoot },
    })
    return Promise.resolve({ ok: false, error: "aborted before pull started" })
  }

  // Same .git presence check as the sync version.
  const repoCheck = ensureGitRepo(agentRoot)
  if (!repoCheck.ok) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_not_a_repo",
      message: "pre-turn pull failed: bundle is not a git repo (async)",
      meta: { agentRoot },
    })
    return Promise.resolve(repoCheck)
  }

  // Remote-presence check stays sync — it's a fast local op and doesn't
  // need cancellation. The hangable op is the actual pull.
  try {
    const remoteOutput = execFileSync("git", ["remote"], {
      cwd: agentRoot,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()

    if (remoteOutput.length === 0) {
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_pull_end",
        message: "pre-turn pull skipped: no remote configured (async)",
        meta: { agentRoot },
      })
      return Promise.resolve({ ok: true })
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_error",
      message: "pre-turn pull failed: git remote check failed (async)",
      meta: { agentRoot, error },
    })
    return Promise.resolve({ ok: false, error })
  }

  // The hangable op. `execFile` accepts `{ signal }` and kills the child
  // when the signal aborts — that's the whole point of the async path.
  const execOptions: Parameters<typeof execFile>[2] = {
    cwd: agentRoot,
    timeout: 30000,
  }
  if (options.signal) {
    execOptions.signal = options.signal
  }

  return new Promise<SyncResult>((resolve) => {
    execFile("git", ["pull", config.remote], execOptions, (err) => {
      if (err) {
        const error = err instanceof Error ? err.message : String(err)
        emitNervesEvent({
          component: "heart",
          event: "heart.sync_pull_error",
          message: "pre-turn pull failed (async)",
          meta: { agentRoot, error },
        })
        resolve({ ok: false, error })
        return
      }
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_pull_end",
        message: "pre-turn pull complete (async)",
        meta: { agentRoot },
      })
      resolve({ ok: true })
    })
  })
}
