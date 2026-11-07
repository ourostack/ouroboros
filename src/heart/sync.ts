import { spawn, spawnSync } from "child_process"
import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { SyncConfig } from "./config"
import type { SyncClassification } from "./sync-classification"
import { parseBundleSyncFailure, type BundleSyncFailure } from "./sync-health"
import { acquireSyncLock, tryAcquireSyncLockSync, type SyncLockBusy, type SyncLockHandle } from "./sync-lock"

export interface SyncResult {
  ok: boolean
  error?: string
  /** `state/sync-paused` is in force; no git ran. */
  paused?: boolean
  /** The pause marker's `expiresAt`, when `paused`. */
  pausedUntil?: string
  /** Another sync held the bundle lock, so this one did nothing. */
  busy?: boolean
  /** When `busy`: the pid holding the lock, or null when unknown. */
  holderPid?: number | null
}

/** `postTurnPush` returns after the commit; the push runs on, holding the lock. */
export interface PostTurnPushResult extends SyncResult {
  /** The push started under the same lock as the commit. Absent when nothing was started. */
  push?: Promise<SyncResult>
}

/**
 * On-disk schema for `state/pending-sync.json`. Written whenever a sync fails
 * (commit, merge or push) and removed only when a later sync succeeds, so the
 * agent, `ouro status` and the daemon health check keep seeing the failure
 * until it is fixed.
 *
 * Backward compat: readers should tolerate entries without `classification`
 * or `conflictFiles` (pre-alpha.289 schema) — they fall back to "unknown".
 *
 * `classification` is the `SyncClassification` union from
 * `sync-classification.ts`. Sync itself writes `push_rejected`,
 * `pull_rebase_conflict` (a merge conflict outside `psyche/`) and `unknown`.
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
  /** A `refs/ouro-sync/repair/*` ref holding work this record is about. Never pruned while named here. */
  repairRef?: string
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

/** On-disk schema for `state/sync-paused`. While unexpired, no sync runs git. */
export interface SyncPauseMarker {
  startedAt: string
  expiresAt: string
}

/** A message to the bundle's owner. One `noticeId` is delivered once. */
export interface SyncOwnerNotice {
  noticeId: string
  text: string
}

export type SyncOwnerNotifier = (agentName: string, notice: SyncOwnerNotice) => void | Promise<void>

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
 * Timeout for sync's local git steps (status, add, commit, merge). `git add -A`
 * took 17 s on a bundle with 30,000 changed files, past the old 10 s limit.
 */
export const SYNC_GIT_TIMEOUT_MS = 120_000

/** Network steps run as detached children, killed by process group at these limits. */
export const SYNC_FETCH_TIMEOUT_MS = 10_000
export const SYNC_PUSH_TIMEOUT_MS = 60_000

/** Message of the merge commit in which the owner's psyche edits win. */
export const OWNER_WINS_MESSAGE = "sync: owner's psyche edit wins"

/**
 * How long `preTurnPull` waits for the bundle lock before skipping. A turn
 * skips rather than queues: the next turn integrates anyway.
 */
export const PRE_TURN_LOCK_WAIT_MS = 5_000

/**
 * Test seams.
 * @internal Not part of the public API; production code must not set these.
 */
export const __testHooks: {
  fetchTimeoutMs?: number
  pushTimeoutMs?: number
  preTurnLockWaitMs?: number
  /** Appended after sync's own `-c` flags, so a test can re-enable hooks. */
  extraGitConfig?: string[]
  /** Replaces `merge --abort` in repair; no real git refuses it and then accepts `reset --merge`. */
  mergeAbortArgs?: string[]
} = {}

/** A pause marker longer than this is garbage: a crashed pauser must not stop sync for good. */
export const SYNC_PAUSE_MAX_MS = 24 * 60 * 60 * 1000

export function pendingSyncPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "pending-sync.json")
}

export function skippedSyncFilesPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "sync-skipped-files.json")
}

export function syncPausedPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "sync-paused")
}

function syncConflictStatePath(agentRoot: string): string {
  return path.join(agentRoot, "state", "sync-conflict.json")
}

export function agentNameFromRoot(agentRoot: string): string {
  return path.basename(agentRoot).replace(/\.ouro$/, "")
}

function branchOf(config: SyncConfig): string {
  return config.branch ?? "main"
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------- git ----------

interface GitRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Flags on every call. The identity: a container or an empty HOME has no
 * gitconfig. The rest: the owner's global gitconfig on the Mac must not
 * stash, replay recorded resolutions, run hooks or demand signatures.
 */
function identityArgs(agentName: string): string[] {
  return [
    "-c", `user.name=${agentName}`,
    "-c", `user.email=${agentName}@ouro.local`,
    "-c", "commit.gpgsign=false",
    "-c", "merge.autoStash=false",
    "-c", "rerere.enabled=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "merge.verifySignatures=false",
    ...(__testHooks.extraGitConfig ?? []),
  ]
}

/** git's messages are matched in English, so the locale is pinned. */
function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C", ...extra }
}

function runGit(agentRoot: string, agentName: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): GitRun {
  const run = spawnSync("git", [...identityArgs(agentName), ...args], {
    cwd: agentRoot,
    env: gitEnv(env),
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: SYNC_GIT_TIMEOUT_MS,
    maxBuffer: SYNC_GIT_MAX_BUFFER_BYTES,
  })
  /* v8 ignore next -- spawn failures (ENOENT, timeout, ENOBUFS) need a broken host @preserve */
  if (run.error) return { status: null, stdout: "", stderr: run.error.message }
  return { status: run.status, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

function gitFailure(args: string[], run: GitRun): Error {
  return new Error(`git ${args[0]} failed: ${(run.stderr || run.stdout).trim()}`)
}

/** Run git and return stdout; throw with git's message on a non-zero exit. */
function git(agentRoot: string, agentName: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): string {
  const run = runGit(agentRoot, agentName, args, env, input)
  if (run.status !== 0) throw gitFailure(args, run)
  return run.stdout
}

/**
 * Run a git command over a list of paths, passed NUL-separated on stdin and
 * matched literally. A list in argv dies with E2BIG past about 1 MB.
 */
function gitOnPaths(agentRoot: string, agentName: string, args: string[], paths: string[]): string {
  return git(
    agentRoot,
    agentName,
    ["--literal-pathspecs", ...args, "--pathspec-from-file=-", "--pathspec-file-nul"],
    undefined,
    paths.join("\0"),
  )
}

interface AsyncGitRun {
  status: number | null
  stderr: string
  timedOut: boolean
  aborted: boolean
}

/**
 * A network git call. It runs detached, in its own process group, so a timeout
 * or an abort kills git and everything it started (ssh, a credential helper):
 * a lone `kill` of git leaves ssh holding the pipes open.
 */
function runGitAsync(
  agentRoot: string,
  agentName: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<AsyncGitRun> {
  return new Promise((resolve) => {
    const child = spawn("git", [...identityArgs(agentName), ...args], {
      cwd: agentRoot,
      env: gitEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    })
    let stderr = ""
    let timedOut = false
    let aborted = false
    let settled = false
    const pid = child.pid as number
    inFlightChildren.add(pid)
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const killGroup = (): void => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // The group is already gone.
      }
    }
    const onAbort = (): void => {
      aborted = true
      killGroup()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    const finish = (status: number | null, extra = ""): void => {
      /* v8 ignore next -- only a spawn error followed by close settles twice @preserve */
      if (settled) return
      settled = true
      inFlightChildren.delete(pid)
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({ status, stderr: extra + stderr, timedOut, aborted })
    }
    /* v8 ignore next -- spawning git itself failing needs a host without git @preserve */
    child.on("error", (err) => finish(null, `${err.message}\n`))
    child.on("close", (code) => finish(code))
    if (signal?.aborted) onAbort()
  })
}

// ---------- termination ----------

/** Process groups of the network git children now running. */
const inFlightChildren = new Set<number>()
/** Sync locks this module holds, wrapped by `trackLock`. */
const heldLocks = new Set<SyncLockHandle>()

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT"] as const
type TerminationSignal = (typeof TERMINATION_SIGNALS)[number]
const terminationListeners: Record<TerminationSignal, () => void> = {
  SIGTERM: () => onTerminationSignal("SIGTERM"),
  SIGINT: () => onTerminationSignal("SIGINT"),
}
let guardInstalled = false

/**
 * Kill every network git child's process group and release every sync lock
 * this process holds. The daemon's SIGTERM handler calls it; so do the guard
 * listeners below, for processes (the agent worker) with no handler of their own.
 */
export function abortInFlightSync(): void {
  const children = inFlightChildren.size
  const locks = heldLocks.size
  if (children === 0 && locks === 0) return
  for (const pid of inFlightChildren) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // The group is already gone.
    }
  }
  inFlightChildren.clear()
  for (const handle of [...heldLocks]) handle.release()
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_aborted",
    message: "sync: killed in-flight git and released the bundle lock",
    meta: { children, locks },
  })
}

/**
 * The guard is prepended, so it runs before every other listener for the
 * signal, `once` wrappers included, and sees them all still registered. It
 * kills sync's git children and releases the locks synchronously, then steps
 * aside: another component's own shutdown runs to completion. Only when no
 * other listener exists does it re-raise, restoring the default exit.
 */
function onTerminationSignal(signal: TerminationSignal): void {
  const others = process.rawListeners(signal).filter((listener) => listener !== terminationListeners[signal])
  abortInFlightSync()
  removeTerminationGuard()
  /* v8 ignore next -- re-raising ends the process; the SIGTERM child-process test covers it @preserve */
  if (others.length === 0) process.kill(process.pid, signal)
}

function installTerminationGuard(): void {
  if (guardInstalled) return
  guardInstalled = true
  for (const signal of TERMINATION_SIGNALS) process.prependListener(signal, terminationListeners[signal])
  process.on("exit", abortInFlightSync)
}

function removeTerminationGuard(): void {
  if (!guardInstalled) return
  guardInstalled = false
  for (const signal of TERMINATION_SIGNALS) process.removeListener(signal, terminationListeners[signal])
  process.removeListener("exit", abortInFlightSync)
}

/** While any lock is held, a signal or an exit kills sync's children and releases the lock. */
function trackLock(handle: SyncLockHandle): SyncLockHandle {
  let released = false
  const tracked: SyncLockHandle = {
    release() {
      if (released) return
      released = true
      heldLocks.delete(tracked)
      try {
        handle.release()
      } finally {
        if (heldLocks.size === 0) removeTerminationGuard()
      }
    },
  }
  heldLocks.add(tracked)
  installTerminationGuard()
  return tracked
}

function describeAsyncFailure(step: string, run: AsyncGitRun, timeoutMs: number): string {
  if (run.timedOut) return `git ${step} timed out after ${timeoutMs} ms`
  if (run.aborted) return `git ${step} aborted`
  return `git ${step} failed: ${run.stderr.trim()}`
}

function hasRemote(agentRoot: string, agentName: string, config: SyncConfig): boolean {
  return git(agentRoot, agentName, ["remote"]).split("\n").map((line) => line.trim()).includes(config.remote)
}

function remoteTrackingRef(config: SyncConfig): string {
  return `refs/remotes/${config.remote}/${branchOf(config)}`
}

function refExists(agentRoot: string, agentName: string, ref: string): boolean {
  return runGit(agentRoot, agentName, ["rev-parse", "--verify", "--quiet", ref]).status === 0
}

/** Commits on HEAD that the last fetched remote branch lacks. An unborn HEAD has none. */
function commitsAhead(agentRoot: string, agentName: string, config: SyncConfig): number {
  if (!refExists(agentRoot, agentName, "HEAD")) return 0
  const ref = remoteTrackingRef(config)
  const range = refExists(agentRoot, agentName, ref) ? `${ref}..HEAD` : "HEAD"
  return Number.parseInt(git(agentRoot, agentName, ["rev-list", "--count", range]).trim(), 10)
}

function unmergedPaths(agentRoot: string, agentName: string): string[] {
  return git(agentRoot, agentName, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter((p) => p.length > 0)
}

function gitDirEntry(agentRoot: string, name: string): string {
  return path.join(agentRoot, ".git", name)
}

// ---------- persistent records ----------

function readPreviousFailure(agentRoot: string): BundleSyncFailure | null {
  try {
    return parseBundleSyncFailure(JSON.parse(fs.readFileSync(pendingSyncPath(agentRoot), "utf-8")) as unknown)
  } catch {
    return null
  }
}

/** The repair ref the pending record names, if any. */
function pendingRepairRef(agentRoot: string): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(pendingSyncPath(agentRoot), "utf-8")) as Partial<PendingSyncRecord> | null
    return typeof record?.repairRef === "string" ? record.repairRef : null
  } catch {
    return null
  }
}

function writePendingSync(
  agentRoot: string,
  error: string,
  classification: PendingSyncRecord["classification"],
  conflictFiles: string[],
  repairRef?: string,
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
    ...(repairRef === undefined ? {} : { repairRef }),
  }
  fs.writeFileSync(pendingSyncPath(agentRoot), JSON.stringify(record, null, 2), "utf-8")
}

function recordPendingSync(
  agentRoot: string,
  error: string,
  classification: PendingSyncRecord["classification"],
  conflictFiles: string[],
  repairRef?: string,
): void {
  // An incomplete restore outranks later failures: it names the ref holding the agent's work.
  if (classification !== "repair_restore_incomplete" && readPreviousFailure(agentRoot)?.classification === "repair_restore_incomplete") return
  try {
    writePendingSync(agentRoot, error, classification, conflictFiles, repairRef)
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

/**
 * Clear the pending record after a sync step succeeded, unless it reports an
 * incomplete restore: that one stays until a person clears it
 * (`clearPendingSync`), since the agent's work is only in the named ref.
 */
function settlePendingSync(agentRoot: string): void {
  if (readPreviousFailure(agentRoot)?.classification === "repair_restore_incomplete") return
  clearPendingSync(agentRoot)
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

/** A non-psyche conflict the owner has been told about. */
interface SyncConflictState {
  hash: string
  paths: string[]
  /** The owner has been told that the agent's side is on `sync-conflict/<agent>`. */
  branchNoticeSent?: boolean
  /** HEAD at the last successful push of `sync-conflict/<agent>`. */
  branchPushedHead?: string
}

function readConflictState(agentRoot: string): SyncConflictState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncConflictStatePath(agentRoot), "utf-8")) as Partial<SyncConflictState>
    return typeof parsed.hash === "string" ? (parsed as SyncConflictState) : null
  } catch {
    return null
  }
}

function writeConflictState(agentRoot: string, state: SyncConflictState): void {
  try {
    fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
    fs.writeFileSync(syncConflictStatePath(agentRoot), JSON.stringify(state, null, 2), "utf-8")
  } catch {
    // Best effort: without the record the owner may be told twice.
  }
}

function clearConflictState(agentRoot: string): void {
  try {
    fs.rmSync(syncConflictStatePath(agentRoot), { force: true })
  } catch {
    // Best effort: a stale record only suppresses a repeat notice.
  }
}

// ---------- owner notices ----------

let ownerNotifier: SyncOwnerNotifier | null = null

/**
 * Replace how sync tells the owner. Null restores the default: Telegram when
 * the agent has it; otherwise the notice goes to the agent's private-runtime
 * pending queue, and the agent tells the owner through whatever sense it has.
 */
export function setSyncOwnerNotifier(notifier: SyncOwnerNotifier | null): void {
  ownerNotifier = notifier
}

async function defaultOwnerNotifier(agentRoot: string, agentName: string, notice: SyncOwnerNotice): Promise<void> {
  try {
    const { sendTelegramOwnerNotice } = await import("../senses/telegram")
    await sendTelegramOwnerNotice(agentName, { ...notice, signal: AbortSignal.timeout(30_000) })
    return
  } catch (err) {
    // Not every agent has Telegram: queue it once, for the agent to relay.
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_owner_notice_telegram_skipped",
      message: "sync: Telegram did not send the owner notice; queued it instead",
      meta: { agentRoot, noticeId: notice.noticeId, error: errorText(err) },
    })
  }
  const { getPrivateRuntimePendingDir, queuePendingMessageOnce } = await import("../mind/pending")
  queuePendingMessageOnce(getPrivateRuntimePendingDir(agentName, agentRoot), {
    from: agentName,
    friendId: "self",
    channel: "inner",
    key: "dialog",
    content: `${notice.text}\n\ni should tell my owner.`,
    timestamp: Date.now(),
    packetId: notice.noticeId,
  })
}

/** Fire and forget: a turn never waits on a notice. */
export function tellOwner(agentRoot: string, agentName: string, notice: SyncOwnerNotice): void {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_owner_notice",
    message: "sync: telling the owner",
    meta: { agentRoot, noticeId: notice.noticeId },
  })
  const send: SyncOwnerNotifier = ownerNotifier ?? ((name, body) => defaultOwnerNotifier(agentRoot, name, body))
  void Promise.resolve()
    .then(() => send(agentName, notice))
    .catch((err: unknown) => {
      emitNervesEvent({
        level: "warn",
        component: "heart",
        event: "heart.sync_owner_notice_error",
        message: "sync: could not tell the owner",
        meta: { agentRoot, noticeId: notice.noticeId, error: errorText(err) },
      })
    })
}

// ---------- pause marker ----------

/**
 * The pause marker's `expiresAt` while it is in force, else null. An expired or
 * unparseable marker is deleted, so a crashed pauser cannot stop sync for good.
 */
type PauseMarkerState =
  | { kind: "none" }
  | { kind: "active"; expiresAt: string }
  | { kind: "garbage"; expiresAt: unknown }

/** Read the pause marker without changing anything. */
function readPauseMarker(agentRoot: string): PauseMarkerState {
  let raw: string
  try {
    raw = fs.readFileSync(syncPausedPath(agentRoot), "utf-8")
  } catch {
    return { kind: "none" }
  }
  let marker: Partial<SyncPauseMarker> | null
  try {
    marker = JSON.parse(raw) as Partial<SyncPauseMarker> | null
  } catch {
    marker = null
  }
  const expiresAt: unknown = marker?.expiresAt
  const expiresMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN
  const startedMs = typeof marker?.startedAt === "string" ? Date.parse(marker.startedAt) : Number.NaN
  const now = Date.now()
  const longestEnd = (Number.isFinite(startedMs) ? startedMs : now) + SYNC_PAUSE_MAX_MS
  if (Number.isFinite(expiresMs) && expiresMs > now && expiresMs <= longestEnd) return { kind: "active", expiresAt: expiresAt as string }
  return { kind: "garbage", expiresAt }
}

function activePause(agentRoot: string): string | null {
  const markerPath = syncPausedPath(agentRoot)
  const state = readPauseMarker(agentRoot)
  if (state.kind === "none") return null
  if (state.kind === "active") return state.expiresAt
  const expiresAt = state.expiresAt
  try {
    fs.rmSync(markerPath, { force: true })
  } catch (err) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_pause_clear_failed",
      message: "sync: could not remove an expired or unreadable pause marker",
      meta: { agentRoot, error: errorText(err) },
    })
    return null
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_pause_expired",
    message: "sync: removed an expired or unreadable pause marker",
    meta: { agentRoot, expiresAt: typeof expiresAt === "string" ? expiresAt : null },
  })
  return null
}

function pausedResult(agentRoot: string, step: string): SyncResult | null {
  const until = activePause(agentRoot)
  if (until === null) return null
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_paused",
    message: `${step} skipped: sync is paused`,
    meta: { agentRoot, expiresAt: until },
  })
  return { ok: true, paused: true, pausedUntil: until }
}

// ---------- commit ----------

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
function unstageOversizedFiles(agentRoot: string, agentName: string): SkippedSyncFile[] {
  const changes = parseStagedChanges(git(agentRoot, agentName, ["diff", "--cached", "--name-status", "-M", "-z"]))

  const oversized: SkippedSyncFile[] = []
  const unstage: string[] = []
  for (const change of changes) {
    if (change.status.startsWith("D")) continue
    let bytes: number
    try {
      bytes = fs.lstatSync(path.join(agentRoot, change.path)).size
    } catch {
      /* v8 ignore next -- the file was removed between `git add` and this stat @preserve */
      continue
    }
    if (bytes <= SYNC_FILE_SIZE_LIMIT_BYTES) continue
    oversized.push({ path: change.path, bytes })
    unstage.push(change.path)
    if (change.status.startsWith("R") && change.fromPath) unstage.push(change.fromPath)
  }
  if (oversized.length === 0) return oversized

  // An unborn HEAD has nothing to reset to; `rm --cached` drops the new entry instead.
  if (refExists(agentRoot, agentName, "HEAD")) gitOnPaths(agentRoot, agentName, ["reset", "-q"], unstage)
  else gitOnPaths(agentRoot, agentName, ["rm", "-q", "--cached"], unstage)
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_oversized_files_skipped",
    message: "sync: left files over the sync size limit uncommitted",
    meta: { agentRoot, limitBytes: SYNC_FILE_SIZE_LIMIT_BYTES, files: oversized },
  })
  return oversized
}

function hasStagedChanges(agentRoot: string, agentName: string): boolean {
  return runGit(agentRoot, agentName, ["diff", "--cached", "--quiet"]).status !== 0
}

/**
 * Git holds `.git/index.lock` for milliseconds to seconds, and every local git
 * call in this module has a timeout well under this. A lock older than this was
 * left behind by a git process that died mid-write; while it exists every
 * `git add` fails, which silently stopped one bundle's sync for three months.
 */
export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000

// Only an empty lock is removed: git writes the new index into the lock right
// after creating it, while a live `git commit` waiting in an editor holds a
// full, unchanging lock that can be older than the threshold. When `.git` is a
// gitdir file (worktree), statSync fails and the lock is left alone.
function clearStaleIndexLock(agentRoot: string): void {
  const lockPath = gitDirEntry(agentRoot, "index.lock")
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
      message: "sync: could not remove stale git index.lock",
      meta: { agentRoot, lockPath, error: errorText(err) },
    })
    return
  }
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_stale_lock_cleared",
    message: "sync: removed stale git index.lock",
    meta: { agentRoot, lockPath, ageMs },
  })
}

/**
 * Commit every change in the bundle except files over the size limit, as the
 * agent. Synchronous, so no turn's file writes interleave with it. Throws with
 * git's message when git fails; never commits unmerged paths (conflict markers).
 */
export function commitLocalChanges(
  agentRoot: string,
  agentName: string,
  message: string,
): { committed: boolean; skipped: SkippedSyncFile[] } {
  const status = git(agentRoot, agentName, ["status", "--porcelain"]).trim()
  if (status.length === 0) {
    // Nothing to commit, so nothing is skipped for size any more.
    writeSkippedSyncFiles(agentRoot, [])
    return { committed: false, skipped: [] }
  }
  const unmerged = unmergedPaths(agentRoot, agentName)
  if (unmerged.length > 0) throw new Error(`unmerged paths in the index: ${unmerged.join(", ")}`)

  clearStaleIndexLock(agentRoot)
  git(agentRoot, agentName, ["add", "-A"])
  const skipped = unstageOversizedFiles(agentRoot, agentName)
  writeSkippedSyncFiles(agentRoot, skipped)
  if (!hasStagedChanges(agentRoot, agentName)) return { committed: false, skipped }

  // -q: without it git prints a create/delete line per file, which overran
  // the output buffer on a 30,000-file commit after the commit had landed.
  git(agentRoot, agentName, ["commit", "-q", "-m", message])
  return { committed: true, skipped }
}

// ---------- integrate ----------

/**
 * Check whether the bundle is initialized as a git repo. The error reaches the
 * agent's start-of-turn packet as a sync warning.
 */
export const NOT_A_REPO_ERROR = "my bundle is not a git repository"

function ensureGitRepo(agentRoot: string, step: string): SyncResult {
  if (fs.existsSync(path.join(agentRoot, ".git"))) return { ok: true }
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_not_a_repo",
    message: `${step} failed: bundle is not a git repo`,
    meta: { agentRoot },
  })
  return { ok: false, error: NOT_A_REPO_ERROR }
}

const REPAIR_REF_PREFIX = "refs/ouro-sync/repair/"
/** Repair refs kept regardless of age. */
const REPAIR_REFS_KEPT = 10
/** Repair refs younger than this are kept regardless of count. */
const REPAIR_REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface RepairRef {
  name: string
  tree: string
  committedMs: number
}

/** Repair refs, newest first (names are ISO timestamps, so they sort by time). */
function listRepairRefs(agentRoot: string, agentName: string): RepairRef[] {
  return git(agentRoot, agentName, ["for-each-ref", "--sort=-refname", "--format=%(refname) %(tree) %(committerdate:unix)", REPAIR_REF_PREFIX])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name, tree, seconds] = line.split(" ")
      return { name, tree, committedMs: Number(seconds) * 1000 }
    })
}

/** Drop repair refs past the newest ten that are 30 days old, except one the pending record names. */
function pruneRepairRefs(agentRoot: string, agentName: string, refs: RepairRef[]): void {
  const protectedRef = pendingRepairRef(agentRoot)
  const now = Date.now()
  const doomed = refs.filter(
    (ref, i) => i >= REPAIR_REFS_KEPT && now - ref.committedMs >= REPAIR_REF_MAX_AGE_MS && ref.name !== protectedRef,
  )
  if (doomed.length === 0) return
  git(agentRoot, agentName, ["update-ref", "--stdin"], undefined, doomed.map((ref) => `delete ${ref.name}\n`).join(""))
}

/**
 * Commit the whole working tree, as it is now, to `refs/ouro-sync/repair/<ts>`
 * without touching the real index. Its parent is the current HEAD, which for a
 * stranded rebase is the detached HEAD, so commits made there stay reachable.
 * When the newest repair ref already holds this tree, that ref is reused.
 */
function snapshotWorkingTree(agentRoot: string, agentName: string): string {
  const indexFile = gitDirEntry(agentRoot, `ouro-sync-repair-${process.pid}.index`)
  const env = { GIT_INDEX_FILE: indexFile }
  let tree: string
  try {
    // Seed from HEAD so tracked files that match an ignore rule are kept.
    git(agentRoot, agentName, ["read-tree", "HEAD"], env)
    git(agentRoot, agentName, ["add", "-A"], env)
    tree = git(agentRoot, agentName, ["write-tree"], env).trim()
  } finally {
    fs.rmSync(indexFile, { force: true })
  }
  const existing = listRepairRefs(agentRoot, agentName)
  if (existing[0]?.tree === tree) return existing[0].name
  const commit = git(agentRoot, agentName, ["commit-tree", tree, "-p", "HEAD", "-m", "sync: repair snapshot"]).trim()
  // A refname may not contain ":".
  const ref = `${REPAIR_REF_PREFIX}${new Date().toISOString().replace(/:/g, "-")}`
  git(agentRoot, agentName, ["update-ref", ref, commit])
  pruneRepairRefs(agentRoot, agentName, [{ name: ref, tree, committedMs: Date.now() }, ...existing])
  return ref
}

/** `merge --abort`, else `reset --merge`, else `reset --hard HEAD` (the snapshot restores the rest). */
function abortMergeThoroughly(agentRoot: string, agentName: string): string {
  if (runGit(agentRoot, agentName, __testHooks.mergeAbortArgs ?? ["merge", "--abort"]).status === 0) return "merge --abort"
  if (runGit(agentRoot, agentName, ["reset", "-q", "--merge"]).status === 0) return "reset --merge"
  git(agentRoot, agentName, ["reset", "-q", "--hard", "HEAD"])
  return "reset --hard"
}

/** Paths whose content in the snapshot differs from HEAD. */
function pathsChangedInSnapshot(agentRoot: string, agentName: string, ref: string): string[] {
  return git(agentRoot, agentName, ["diff", "--name-only", "--no-renames", "-z", "HEAD", ref])
    .split("\0")
    .filter((p) => p.length > 0)
}

const refTimestamp = (ref: string): string => ref.slice(REPAIR_REF_PREFIX.length)

/**
 * Abort a rebase or merge left in progress, keeping the work done since. The
 * working tree is snapshotted first; after the abort, every path the operation
 * did not conflict on is restored from it. Conflicted paths keep HEAD's
 * version; edits to them stay in the snapshot ref, which the owner is told about.
 *
 * Returns null when there was nothing to repair or the repair completed, else
 * the failure to report. A failed snapshot touches nothing, so the stranded
 * state stays exactly as found for a later attempt.
 */
function repairInterrupted(agentRoot: string, agentName: string): SyncResult | null {
  const rebase = fs.existsSync(gitDirEntry(agentRoot, "rebase-merge")) || fs.existsSync(gitDirEntry(agentRoot, "rebase-apply"))
  const merge = fs.existsSync(gitDirEntry(agentRoot, "MERGE_HEAD"))
  if (!rebase && !merge) return null
  const operation = rebase ? "rebase" : "merge"
  const conflicted = unmergedPaths(agentRoot, agentName)
  let ref: string
  try {
    ref = snapshotWorkingTree(agentRoot, agentName)
  } catch (err) {
    return reportSnapshotFailure(agentRoot, agentName, operation, errorText(err))
  }
  let abortedWith = "rebase --abort"
  if (rebase) git(agentRoot, agentName, ["rebase", "--abort"])
  else abortedWith = abortMergeThoroughly(agentRoot, agentName)

  const changed = pathsChangedInSnapshot(agentRoot, agentName, ref)
  const skip = new Set(conflicted)
  const restore = changed.filter((p) => !skip.has(p))
  const kept = changed.filter((p) => skip.has(p))
  try {
    if (restore.length > 0) gitOnPaths(agentRoot, agentName, ["restore", `--source=${ref}`, "--worktree"], restore)
  } catch (err) {
    return reportRestoreIncomplete(agentRoot, agentName, operation, ref, errorText(err))
  }
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_repaired",
    message: "sync: aborted a rebase or merge left in progress",
    meta: { agentRoot, rebase, merge, ref, conflicted, kept, abortedWith },
  })
  if (kept.length === 0) return null
  recordPendingSync(agentRoot, `an interrupted ${operation} was aborted; edits to ${kept.join(", ")} are kept in ${ref}`, "unknown", kept, ref)
  tellOwner(agentRoot, agentName, {
    noticeId: `sync-repair:${agentName}:${refTimestamp(ref)}`,
    text: `Sync found an interrupted ${operation} in ${agentName}'s bundle and aborted it. Edits to ${kept.join(", ")} made since are kept in ${ref}.`,
  })
  return null
}

function reportSnapshotFailure(agentRoot: string, agentName: string, operation: string, gitError: string): SyncResult {
  const error = `an interrupted ${operation} was left in place: the working tree could not be saved first (${gitError})`
  const previous = readPreviousFailure(agentRoot)
  const repeat = previous?.classification === "repair_snapshot_failed" && previous.error === error
  recordPendingSync(agentRoot, error, "repair_snapshot_failed", [])
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_repair_snapshot_failed",
    message: "sync: could not snapshot before repair; nothing was changed",
    meta: { agentRoot, operation, error: gitError },
  })
  if (!repeat) {
    tellOwner(agentRoot, agentName, {
      noticeId: `sync-repair-snapshot:${agentName}:${createHash("sha256").update(error).digest("hex").slice(0, 16)}`,
      text: `Sync found an interrupted ${operation} in ${agentName}'s bundle but could not save the working tree first, so it left everything as it is and stopped syncing. git said: ${gitError}`,
    })
  }
  return { ok: false, error }
}

function reportRestoreIncomplete(agentRoot: string, agentName: string, operation: string, ref: string, gitError: string): SyncResult {
  const error = `an interrupted ${operation} was aborted but not every file was put back; the full working tree is in ${ref} (${gitError})`
  recordPendingSync(agentRoot, error, "repair_restore_incomplete", [], ref)
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_repair_restore_incomplete",
    message: "sync: repair could not restore every file from its snapshot",
    meta: { agentRoot, operation, ref, error: gitError },
  })
  tellOwner(agentRoot, agentName, {
    noticeId: `sync-repair-restore:${agentName}:${refTimestamp(ref)}`,
    text: `Sync aborted an interrupted ${operation} in ${agentName}'s bundle but could not put every file back. The working tree as it was is in ${ref}; git said: ${gitError}`,
  })
  return { ok: false, error }
}

function abortMergeIfAny(agentRoot: string, agentName: string): void {
  if (fs.existsSync(gitDirEntry(agentRoot, "MERGE_HEAD"))) runGit(agentRoot, agentName, ["merge", "--abort"])
}

/**
 * Redo a merge whose conflicts are all in `psyche/` so the owner's conflicting
 * hunks win and the agent's other hunks stay. Delete/modify conflicts take the
 * owner's side too: removed where the owner deleted, the owner's file where the
 * owner modified.
 */
function mergeOwnerWins(agentRoot: string, agentName: string, ref: string, paths: string[]): void {
  git(agentRoot, agentName, ["merge", "--abort"])
  const merge = runGit(agentRoot, agentName, ["merge", "--no-edit", "--ff", "-X", "theirs", "-m", OWNER_WINS_MESSAGE, ref])
  if (merge.status !== 0) {
    const remaining = unmergedPaths(agentRoot, agentName)
    if (remaining.length === 0) throw gitFailure(["merge"], merge)
    for (const file of remaining) {
      const stages = git(agentRoot, agentName, ["--literal-pathspecs", "ls-files", "-u", "--", file])
      const theirsHasIt = stages.split("\n").some((line) => /^\d+ [0-9a-f]+ 3\t/.test(line))
      if (theirsHasIt) {
        git(agentRoot, agentName, ["--literal-pathspecs", "checkout", "--theirs", "--", file])
        git(agentRoot, agentName, ["--literal-pathspecs", "add", "--", file])
      } else {
        git(agentRoot, agentName, ["--literal-pathspecs", "rm", "-q", "--", file])
      }
    }
    git(agentRoot, agentName, ["commit", "-q", "-m", OWNER_WINS_MESSAGE])
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_owner_wins",
    message: "sync: merged with the owner's psyche edits winning conflicts",
    meta: { agentRoot, paths },
  })
}

function conflictHash(paths: string[]): string {
  return createHash("sha256").update(paths.join("\0")).digest("hex").slice(0, 16)
}

interface IntegrateOutcome {
  result: SyncResult
  /** The same non-psyche conflict recurred: push HEAD to `sync-conflict/<agent>`. */
  conflictBranch?: SyncConflictState
}

function handleNonPsycheConflict(
  agentRoot: string,
  config: SyncConfig,
  agentName: string,
  paths: string[],
): IntegrateOutcome {
  git(agentRoot, agentName, ["merge", "--abort"])
  const sorted = [...paths].sort()
  const hash = conflictHash(sorted)
  const error = `merge with ${config.remote}/${branchOf(config)} conflicts in ${sorted.join(", ")}; the merge was aborted and local commits are kept`
  recordPendingSync(agentRoot, error, "pull_rebase_conflict", sorted)
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_conflict",
    message: "sync: merge conflict outside psyche/, merge aborted",
    meta: { agentRoot, conflictFiles: sorted, hash },
  })
  const previous = readConflictState(agentRoot)
  if (previous?.hash === hash) return { result: { ok: false, error }, conflictBranch: previous }
  writeConflictState(agentRoot, { hash, paths: sorted })
  tellOwner(agentRoot, agentName, {
    noticeId: `sync-conflict:${agentName}:${hash}`,
    text: `Bundle sync for ${agentName} stopped: ${sorted.join(", ")} changed on both sides. My changes stay committed locally until the conflict is merged.`,
  })
  return { result: { ok: false, error } }
}

/** Record a successful integrate: a resolved conflict is over, and a synced bundle has nothing pending. */
function settleIntegrated(agentRoot: string, config: SyncConfig, agentName: string): void {
  clearConflictState(agentRoot)
  const pending = readPreviousFailure(agentRoot)
  if (!pending) return
  if (pending.classification === "pull_rebase_conflict" || commitsAhead(agentRoot, agentName, config) === 0) settlePendingSync(agentRoot)
}

function integrateCore(agentRoot: string, config: SyncConfig, agentName: string, commitMessage = "sync: pre-turn update"): IntegrateOutcome {
  // Outside the try: its catch aborts a merge, which must never run before a snapshot.
  const repairFailure = repairInterrupted(agentRoot, agentName)
  if (repairFailure) return { result: repairFailure }
  try {
    commitLocalChanges(agentRoot, agentName, commitMessage)
    const ref = remoteTrackingRef(config)
    if (!refExists(agentRoot, agentName, ref)) {
      settleIntegrated(agentRoot, config, agentName)
      return { result: { ok: true } }
    }
    const shortRef = `${config.remote}/${branchOf(config)}`
    const merge = runGit(agentRoot, agentName, ["merge", "--no-edit", "--ff", shortRef])
    if (merge.status !== 0) {
      const paths = unmergedPaths(agentRoot, agentName)
      if (paths.length === 0) {
        // Refused before touching anything ("would be overwritten"): no conflict state.
        abortMergeIfAny(agentRoot, agentName)
        const error = gitFailure(["merge"], merge).message
        recordPendingSync(agentRoot, error, "unknown", [])
        emitNervesEvent({
          level: "warn",
          component: "heart",
          event: "heart.sync_merge_failed",
          message: "sync: merge refused",
          meta: { agentRoot, error },
        })
        return { result: { ok: false, error } }
      }
      if (paths.some((p) => !p.startsWith("psyche/"))) return handleNonPsycheConflict(agentRoot, config, agentName, paths)
      mergeOwnerWins(agentRoot, agentName, shortRef, paths)
    }
    settleIntegrated(agentRoot, config, agentName)
    return { result: { ok: true } }
  } catch (err) {
    abortMergeIfAny(agentRoot, agentName)
    const error = errorText(err)
    recordPendingSync(agentRoot, error, "unknown", [])
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_merge_failed",
      message: "sync: integrate failed",
      meta: { agentRoot, error },
    })
    return { result: { ok: false, error } }
  }
}

/**
 * Merge the fetched remote branch into the bundle. Synchronous. The caller
 * holds the bundle lock. Steps: repair an interrupted rebase or merge, commit
 * local changes, then merge `<remote>/<branch>` (fast-forward when possible).
 * Conflicts only in `psyche/` go to the owner; any other conflict aborts the
 * merge and is recorded in `state/pending-sync.json`.
 */
export function integrateFetched(agentRoot: string, config: SyncConfig, agentName: string): SyncResult {
  return integrateCore(agentRoot, config, agentName).result
}

// ---------- network steps ----------

async function fetchUnlocked(agentRoot: string, config: SyncConfig, agentName: string, signal?: AbortSignal): Promise<SyncResult> {
  const branch = branchOf(config)
  const timeoutMs = __testHooks.fetchTimeoutMs ?? SYNC_FETCH_TIMEOUT_MS
  const run = await runGitAsync(agentRoot, agentName, ["fetch", "--no-tags", config.remote, `+refs/heads/${branch}:${remoteTrackingRef(config)}`], timeoutMs, signal)
  // An empty remote has no branch yet; integrate then only commits.
  if (run.status === 0 || /couldn't find remote ref/i.test(run.stderr)) return { ok: true }
  const error = describeAsyncFailure("fetch", run, timeoutMs)
  emitNervesEvent({
    level: "warn",
    component: "heart",
    event: "heart.sync_fetch_error",
    message: "sync: fetch failed",
    meta: { agentRoot, remote: config.remote, branch, error },
  })
  return { ok: false, error }
}

/** `git fetch <remote> <branch>` as a detached child, killed by process group at 10 s or on abort. The caller holds the lock. */
export function fetchRemote(agentRoot: string, config: SyncConfig, signal?: AbortSignal): Promise<SyncResult> {
  return fetchUnlocked(agentRoot, config, agentNameFromRoot(agentRoot), signal)
}

async function pushUnlocked(agentRoot: string, config: SyncConfig, agentName: string, signal?: AbortSignal): Promise<SyncResult> {
  try {
    if (!hasRemote(agentRoot, agentName, config)) {
      settlePendingSync(agentRoot)
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "sync: committed locally, no remote configured",
        meta: { agentRoot },
      })
      return { ok: true }
    }
    const branch = branchOf(config)
    const timeoutMs = __testHooks.pushTimeoutMs ?? SYNC_PUSH_TIMEOUT_MS
    const run = await runGitAsync(agentRoot, agentName, ["push", config.remote, `HEAD:refs/heads/${branch}`], timeoutMs, signal)
    if (run.status === 0) {
      settlePendingSync(agentRoot)
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "sync: push complete",
        meta: { agentRoot, remote: config.remote, branch },
      })
      return { ok: true }
    }
    const rejected = !run.timedOut && !run.aborted && /\[rejected\]|non-fast-forward|fetch first/.test(run.stderr)
    const error = describeAsyncFailure("push", run, timeoutMs)
    const classification = rejected ? "push_rejected" : "unknown"
    recordPendingSync(agentRoot, error, classification, [])
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_push_error",
      message: `sync: push failed: ${classification}`,
      meta: { agentRoot, error, classification },
    })
    return { ok: false, error }
  } catch (err) {
    const error = errorText(err)
    recordPendingSync(agentRoot, error, "unknown", [])
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_push_error",
      message: "sync: push failed",
      meta: { agentRoot, error },
    })
    return { ok: false, error }
  }
}

/**
 * `git push <remote> HEAD:<branch>` as a detached child, killed by process
 * group at 60 s. It takes the lock the caller acquired before committing and
 * releases it when the push ends, so nothing runs between commit and push. A
 * rejection is recorded as `push_rejected`; the next integrate merges and the
 * push after it succeeds. Never throws.
 */
export async function pushAsync(agentRoot: string, config: SyncConfig, handle: SyncLockHandle, signal?: AbortSignal): Promise<SyncResult> {
  try {
    return await pushUnlocked(agentRoot, config, agentNameFromRoot(agentRoot), signal)
  } finally {
    handle.release()
  }
}

// ---------- building blocks for other bundle writers (ouro move, the home check) ----------

/** The active pause's `expiresAt`, or null. Reads the marker and changes nothing. */
export function syncPausedUntil(agentRoot: string): string | null {
  const state = readPauseMarker(agentRoot)
  return state.kind === "active" ? state.expiresAt : null
}

/** `refs/remotes/<remote>/<branch>`, the ref `fetchRemote` updates. */
export function syncTrackingRef(config: SyncConfig): string {
  return remoteTrackingRef(config)
}

/**
 * Take the bundle sync lock, waiting up to `waitMs`. While it is held, a
 * SIGTERM or SIGINT kills sync's git children and releases it, as for sync itself.
 */
export async function holdSyncLock(agentRoot: string, waitMs: number): Promise<SyncLockHandle | SyncLockBusy> {
  const acquired = waitMs > 0 ? await acquireSyncLock(agentRoot, waitMs) : tryAcquireSyncLockSync(agentRoot)
  return "busy" in acquired ? acquired : trackLock(acquired)
}

export interface BranchPushResult {
  ok: boolean
  /** The remote moved on: a fast-forward push was refused. */
  rejected?: boolean
  error?: string
}

/**
 * `git push <remote> HEAD:refs/heads/<branch>` as a detached child, killed by
 * process group at 60 s. It records nothing in `state/pending-sync.json`: the
 * caller, which holds the lock, decides what a refusal means.
 */
export async function pushHeadToBranch(agentRoot: string, config: SyncConfig, signal?: AbortSignal): Promise<BranchPushResult> {
  const timeoutMs = __testHooks.pushTimeoutMs ?? SYNC_PUSH_TIMEOUT_MS
  const run = await runGitAsync(agentRoot, agentNameFromRoot(agentRoot), ["push", config.remote, `HEAD:refs/heads/${branchOf(config)}`], timeoutMs, signal)
  if (run.status === 0) return { ok: true }
  const rejected = !run.timedOut && !run.aborted && /\[rejected\]|non-fast-forward|fetch first/.test(run.stderr)
  return { ok: false, rejected, error: describeAsyncFailure("push", run, timeoutMs) }
}

/** The same conflict recurred: put the agent's side where the owner can merge it from the Mac. */
async function pushConflictBranch(agentRoot: string, config: SyncConfig, agentName: string, state: SyncConflictState, signal?: AbortSignal): Promise<void> {
  const branch = `sync-conflict/${agentName}`
  const head = git(agentRoot, agentName, ["rev-parse", "HEAD"]).trim()
  // Pushed already, and nothing new since: skip the network.
  if (state.branchPushedHead === head) return
  const timeoutMs = __testHooks.pushTimeoutMs ?? SYNC_PUSH_TIMEOUT_MS
  const run = await runGitAsync(agentRoot, agentName, ["push", config.remote, `HEAD:refs/heads/${branch}`], timeoutMs, signal)
  if (run.status !== 0) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_conflict_branch_push_error",
      message: "sync: could not push the conflict branch",
      meta: { agentRoot, branch, error: describeAsyncFailure("push", run, timeoutMs) },
    })
    return
  }
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_conflict_branch_pushed",
    message: "sync: pushed the agent's side of a conflict",
    meta: { agentRoot, branch },
  })
  writeConflictState(agentRoot, { ...state, branchNoticeSent: true, branchPushedHead: head })
  if (state.branchNoticeSent) return
  tellOwner(agentRoot, agentName, {
    noticeId: `sync-conflict-branch:${agentName}:${state.hash}`,
    text: `My side of the sync conflict in ${state.paths.join(", ")} is on branch ${branch} in ${config.remote}. Merging it into ${branchOf(config)} from the Mac resumes sync.`,
  })
}

/** An unborn HEAD (nothing ever committed) has nothing to push. */
function pushIfBorn(agentRoot: string, config: SyncConfig, agentName: string): Promise<SyncResult> {
  if (refExists(agentRoot, agentName, "HEAD")) return pushUnlocked(agentRoot, config, agentName)
  settlePendingSync(agentRoot)
  return Promise.resolve({ ok: true })
}

/** Fetch then integrate. The caller holds the lock. */
async function pullUnlocked(agentRoot: string, config: SyncConfig, agentName: string, signal?: AbortSignal, commitMessage?: string): Promise<SyncResult> {
  let remote: boolean
  try {
    remote = hasRemote(agentRoot, agentName, config)
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
  if (remote) {
    const fetched = await fetchUnlocked(agentRoot, config, agentName, signal)
    if (!fetched.ok) return fetched
  }
  const outcome = integrateCore(agentRoot, config, agentName, commitMessage)
  if (outcome.conflictBranch) await pushConflictBranch(agentRoot, config, agentName, outcome.conflictBranch, signal)
  return outcome.result
}

/** Commits on each side of HEAD and the last fetched remote branch. */
function aheadBehind(agentRoot: string, agentName: string, config: SyncConfig): { ahead: number; behind: number } {
  const ahead = commitsAhead(agentRoot, agentName, config)
  const ref = remoteTrackingRef(config)
  if (!refExists(agentRoot, agentName, ref)) return { ahead, behind: 0 }
  const range = refExists(agentRoot, agentName, "HEAD") ? `HEAD..${ref}` : ref
  return { ahead, behind: Number.parseInt(git(agentRoot, agentName, ["rev-list", "--count", range]).trim(), 10) }
}

// ---------- public entry points ----------

export interface SyncProbeResult extends SyncResult {
  /** Commits HEAD has that the remote branch lacks. Absent without a remote. */
  ahead?: number
  /** Commits the remote branch has that HEAD lacks. Absent without a remote. */
  behind?: number
}

/**
 * The boot probe: fetch the remote branch and count commits ahead and behind.
 * It takes the lock without waiting, never merges, commits or pushes, and
 * writes nothing under `state/` (an expired pause marker is left for the next
 * sync to remove).
 */
export async function probeSync(agentRoot: string, config: SyncConfig, signal?: AbortSignal): Promise<SyncProbeResult> {
  const agentName = agentNameFromRoot(agentRoot)
  const pause = readPauseMarker(agentRoot)
  if (pause.kind === "active") return { ok: true, paused: true, pausedUntil: pause.expiresAt }
  const repoCheck = ensureGitRepo(agentRoot, "boot probe")
  if (!repoCheck.ok) return repoCheck
  try {
    const acquired = tryAcquireSyncLockSync(agentRoot)
    if ("busy" in acquired) return { ok: true, busy: true, holderPid: acquired.holderPid }
    const lock = trackLock(acquired)
    try {
      if (!hasRemote(agentRoot, agentName, config)) return { ok: true }
      const fetched = await fetchUnlocked(agentRoot, config, agentName, signal)
      if (!fetched.ok) return fetched
      return { ok: true, ...aheadBehind(agentRoot, agentName, config) }
    } finally {
      lock.release()
    }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

export interface PreTurnPullOptions {
  /** Defaults to the bundle directory's name without `.ouro`. */
  agentName?: string
  signal?: AbortSignal
}

/**
 * Pre-turn pull: under the bundle lock (waiting up to 5 s, then skipping),
 * fetch the remote branch and merge it, so the turn reads the owner's latest
 * edits. With no remote, local changes are committed and the result is ok.
 */
export async function preTurnPull(agentRoot: string, config: SyncConfig, options: PreTurnPullOptions = {}): Promise<SyncResult> {
  const agentName = options.agentName ?? agentNameFromRoot(agentRoot)
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_pull_start",
    message: "pre-turn pull starting",
    meta: { agentRoot, remote: config.remote, branch: branchOf(config) },
  })
  const paused = pausedResult(agentRoot, "pre-turn pull")
  if (paused) return paused
  const repoCheck = ensureGitRepo(agentRoot, "pre-turn pull")
  if (!repoCheck.ok) return repoCheck
  if (options.signal?.aborted) {
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_pull_aborted",
      message: "pre-turn pull skipped: signal already aborted",
      meta: { agentRoot },
    })
    return { ok: false, error: "aborted before pull started" }
  }

  let acquired: Awaited<ReturnType<typeof acquireSyncLock>>
  try {
    acquired = await acquireSyncLock(agentRoot, __testHooks.preTurnLockWaitMs ?? PRE_TURN_LOCK_WAIT_MS, options.signal)
  } catch (err) {
    return { ok: false, error: `aborted while waiting for the sync lock: ${errorText(err)}` }
  }
  if ("busy" in acquired) {
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_pull_end",
      message: "pre-turn pull skipped: sync lock busy",
      meta: { agentRoot, holderPid: acquired.holderPid },
    })
    return { ok: true, busy: true, holderPid: acquired.holderPid }
  }
  const lock = trackLock(acquired)
  try {
    // A pause written while this waited for the lock still wins.
    const pausedNow = pausedResult(agentRoot, "pre-turn pull")
    if (pausedNow) return pausedNow
    const result = await pullUnlocked(agentRoot, config, agentName, options.signal)
    if (result.ok) {
      emitNervesEvent({ component: "heart", event: "heart.sync_pull_end", message: "pre-turn pull complete", meta: { agentRoot } })
    } else {
      emitNervesEvent({ level: "warn", component: "heart", event: "heart.sync_pull_error", message: "pre-turn pull failed", meta: { agentRoot, error: result.error } })
    }
    return result
  } finally {
    lock.release()
  }
}

/** Same as `preTurnPull`, kept for older callers. */
export function preTurnPullAsync(agentRoot: string, config: SyncConfig, options: PreTurnPullOptions = {}): Promise<SyncResult> {
  return preTurnPull(agentRoot, config, options)
}

/**
 * Post-turn push. Synchronous up to the push: take the lock without waiting
 * (busy means skip; the next turn commits), commit, then hand the held lock to
 * `pushAsync`, which is not awaited. `push` in the result is that promise.
 */
export function postTurnPush(agentRoot: string, config: SyncConfig, agentName: string = agentNameFromRoot(agentRoot)): PostTurnPushResult {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_push_start",
    message: "post-turn push starting",
    meta: { agentRoot, remote: config.remote, branch: branchOf(config) },
  })
  const repoCheck = ensureGitRepo(agentRoot, "post-turn push")
  if (!repoCheck.ok) return repoCheck

  const acquired = tryAcquireSyncLockSync(agentRoot)
  if ("busy" in acquired) {
    emitNervesEvent({
      component: "heart",
      event: "heart.sync_push_end",
      message: "post-turn push skipped: sync lock busy",
      meta: { agentRoot, holderPid: acquired.holderPid },
    })
    return { ok: true, busy: true, holderPid: acquired.holderPid }
  }
  const lock = trackLock(acquired)

  let release = true
  try {
    // Checked under the lock, so a pauser that saw the lock free sees no git after it.
    const paused = pausedResult(agentRoot, "post-turn push")
    if (paused) return paused
    const repairFailure = repairInterrupted(agentRoot, agentName)
    if (repairFailure) return repairFailure
    commitLocalChanges(agentRoot, agentName, "sync: post-turn update")
    const remote = hasRemote(agentRoot, agentName, config)
    if (remote && readPreviousFailure(agentRoot)?.classification === "pull_rebase_conflict") {
      // The push would be rejected until the conflict is merged; the next integrate retries it.
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: committed, push waits for an unresolved conflict",
        meta: { agentRoot },
      })
      return { ok: true }
    }
    if (remote && commitsAhead(agentRoot, agentName, config) === 0) {
      settlePendingSync(agentRoot)
      emitNervesEvent({
        component: "heart",
        event: "heart.sync_push_end",
        message: "post-turn push: nothing to push",
        meta: { agentRoot },
      })
      return { ok: true }
    }
    release = false
    return { ok: true, push: pushAsync(agentRoot, config, lock) }
  } catch (err) {
    const error = errorText(err)
    recordPendingSync(agentRoot, error, "unknown", [])
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_push_error",
      message: "post-turn push failed",
      meta: { agentRoot, error },
    })
    return { ok: false, error }
  } finally {
    if (release) lock.release()
  }
}

/**
 * Manual sync (`ouro sync`, the bundle tools): under one lock, waiting up to
 * `waitMs`, fetch, integrate and push. Built on the unlocked internals, so it
 * never waits on its own lock.
 */
export async function syncNow(agentRoot: string, config: SyncConfig, agentName: string, waitMs: number): Promise<SyncResult> {
  emitNervesEvent({
    component: "heart",
    event: "heart.sync_now_start",
    message: "sync now starting",
    meta: { agentRoot, remote: config.remote, branch: branchOf(config) },
  })
  const paused = pausedResult(agentRoot, "sync now")
  if (paused) return paused
  const repoCheck = ensureGitRepo(agentRoot, "sync now")
  if (!repoCheck.ok) return repoCheck

  const acquired = await acquireSyncLock(agentRoot, waitMs)
  if ("busy" in acquired) {
    const error = `bundle sync lock is held${acquired.holderPid === null ? "" : ` by pid ${acquired.holderPid}`}`
    emitNervesEvent({
      level: "warn",
      component: "heart",
      event: "heart.sync_now_error",
      message: "sync now: lock busy",
      meta: { agentRoot, error },
    })
    return { ok: false, busy: true, holderPid: acquired.holderPid, error }
  }
  const lock = trackLock(acquired)
  try {
    const pausedNow = pausedResult(agentRoot, "sync now")
    if (pausedNow) return pausedNow
    const pulled = await pullUnlocked(agentRoot, config, agentName, undefined, "sync: update")
    const result = pulled.ok ? await pushIfBorn(agentRoot, config, agentName) : pulled
    if (result.ok) {
      emitNervesEvent({ component: "heart", event: "heart.sync_now_end", message: "sync now complete", meta: { agentRoot } })
    } else {
      emitNervesEvent({ level: "warn", component: "heart", event: "heart.sync_now_error", message: "sync now failed", meta: { agentRoot, error: result.error } })
    }
    return result
  } finally {
    lock.release()
  }
}
