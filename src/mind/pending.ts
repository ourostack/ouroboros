import * as fs from "fs"
import * as path from "path"
import { createHash } from "node:crypto"
import { getAgentRoot } from "../heart/identity"
import { writeJsonAtomicSync } from "../heart/atomic-file"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import { markTerminationGuard, signalHandlersBesidesGuards } from "../heart/termination-guard"

export interface DelegatedFrom {
  friendId: string
  channel: string
  key: string
  bridgeId?: string
}

export interface PendingMessage {
  from: string
  friendId?: string
  channel?: string
  key?: string
  content: string
  timestamp: number
  expiresAt?: number
  packetId?: string
  delegatedFrom?: DelegatedFrom
  obligationStatus?: "pending" | "fulfilled"
  mode?: "reflect" | "plan" | "relay"
  obligationId?: string
  requestId?: string
}

export function getPendingDir(agentName: string, friendId: string, channel: string, key: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(agentRoot, "state", "pending", friendId, channel, key)
}

export function getDeferredReturnDir(agentName: string, friendId: string): string {
  return path.join(getAgentRoot(agentName), "state", "pending-returns", friendId)
}

/** Canonical private-runtime pending path segments. The path is historical durable state. */
export const PRIVATE_RUNTIME_PENDING = { friendId: "self", channel: "inner", key: "dialog" } as const

/** Returns the pending dir for this agent's private runtime. */
export function getPrivateRuntimePendingDir(agentName: string, agentRoot?: string): string {
  return getPendingDir(agentName, PRIVATE_RUNTIME_PENDING.friendId, PRIVATE_RUNTIME_PENDING.channel, PRIVATE_RUNTIME_PENDING.key, agentRoot)
}

/** A message a turn has claimed: still on disk, under a name no other reader takes. */
const CLAIMED_SUFFIX = ".json.claimed"
/** What drainPending renames a message to while it reads it; a crash can leave one behind. */
const DRAIN_PROCESSING_SUFFIX = ".json.processing"

interface HeldClaim {
  unclaimedPath: string
  message: PendingMessage
  failedTries: number
}

/** Messages a turn in this process has claimed and not yet settled or released, by claimed path. */
const heldClaims = new Map<string, HeldClaim>()

/** Claimed paths a turn in this process settled but could not delete: never read again, deleted when possible. */
const settledClaims = new Set<string>()

/** Put a claim back for the next turn; `counted` writes the try against it first, so a crash between counts it once. */
function putBack(claimedPath: string, held: HeldClaim, counted: boolean): void {
  if (counted) {
    writeJsonAtomicSync(held.unclaimedPath, { ...held.message, failedTries: held.failedTries + 1 })
    fs.unlinkSync(claimedPath)
  } else {
    fs.renameSync(claimedPath, held.unclaimedPath)
  }
}

/**
 * Puts back every claim this process still holds at exit. A clean exit (a shutdown, process.exit(0)) is not the
 * messages' fault, so it counts no try; a failing exit (an uncaught exception exits 1) may be, so it counts one.
 * A crash that skips exit handlers leaves its claims behind, and the next claim counts them.
 */
export function releaseHeldPendingClaimsOnExit(code: number = 0): void {
  for (const [claimedPath, held] of heldClaims) {
    heldClaims.delete(claimedPath)
    try { putBack(claimedPath, held, code !== 0) } catch { /* the next claim reads it as left by a crash */ }
  }
}

const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const
type StopSignal = (typeof STOP_SIGNALS)[number]
const stopListeners: Record<StopSignal, () => void> = {
  SIGTERM: markTerminationGuard(() => onStopSignal("SIGTERM")),
  SIGINT: markTerminationGuard(() => onStopSignal("SIGINT")),
}

/**
 * A signal's default action ends the process without running exit handlers, which would leave every held claim to
 * be counted as a crash. When nothing else handles the signal, put the claims back uncounted and re-raise it. When
 * the process has its own shutdown, leave the claims to it: its turns may still settle them, and its exit puts back
 * the rest.
 */
function onStopSignal(signal: StopSignal): void {
  if (signalHandlersBesidesGuards(signal).length > 0) return
  releaseHeldPendingClaimsOnExit(0)
  for (const each of STOP_SIGNALS) process.removeListener(each, stopListeners[each])
  process.kill(process.pid, signal)
}

function installExitHandlers(): void {
  if (process.listeners("exit").includes(releaseHeldPendingClaimsOnExit)) return
  process.on("exit", releaseHeldPendingClaimsOnExit)
  for (const signal of STOP_SIGNALS) process.prependListener(signal, stopListeners[signal])
}

/** Delete a settled message's files; true once nothing of it is left. */
function deleteSettled(pendingDir: string, claimedPath: string, stem: string): boolean {
  try {
    fs.rmSync(claimedPath, { force: true })
    // A copy queued again while the turn held it is the same message.
    fs.rmSync(path.join(pendingDir, `${stem}.json`), { force: true })
    fs.rmSync(path.join(pendingDir, `${stem}${DRAIN_PROCESSING_SUFFIX}`), { force: true })
    settledClaims.delete(claimedPath)
    return true
  } catch (error) {
    settledClaims.add(claimedPath)
    emitNervesEvent({ level: "warn", event: "mind.pending_settle_error", component: "mind", message: "could not delete a settled pending message; this process will not read it again, and deletes it later", meta: { pendingDir, error: errorMessage(error) } })
    return false
  }
}

/** How long a writer may still be writing a file that does not parse yet (queuePendingMessage writes in place). */
const UNREADABLE_GRACE_MS = 60_000

function isUnheldClaim(pendingDir: string, name: string): boolean {
  const claimedPath = path.join(pendingDir, name)
  return name.endsWith(CLAIMED_SUFFIX) && !heldClaims.has(claimedPath) && !settledClaims.has(claimedPath)
}

export function hasPendingMessages(pendingDir: string): boolean {
  if (!fs.existsSync(pendingDir)) return false

  try {
    return fs.readdirSync(pendingDir).some((entry) =>
      entry.endsWith(".json") || entry.endsWith(DRAIN_PROCESSING_SUFFIX) || isUnheldClaim(pendingDir, entry),
    )
  } catch {
    return false
  }
}

function writeQueueFile(queueDir: string, message: PendingMessage): string {
  fs.mkdirSync(queueDir, { recursive: true })
  const fileName = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
  const filePath = path.join(queueDir, fileName)
  fs.writeFileSync(filePath, JSON.stringify({ ...message, content: capStructuredRecordString(message.content) }, null, 2))
  return filePath
}

export function queuePendingMessage(pendingDir: string, message: PendingMessage): void {
  writeQueueFile(pendingDir, message)
}

export function queuePendingMessageOnce(pendingDir: string, message: PendingMessage & { packetId: string }): string {
  fs.mkdirSync(pendingDir, { recursive: true })
  const identity = createHash("sha256").update(message.packetId).digest("hex")
  const filePath = path.join(pendingDir, `${message.timestamp}-${identity}.json`)
  const temporary = `${filePath}.tmp-${process.pid}`
  const content = JSON.stringify({ ...message, content: capStructuredRecordString(message.content) }, null, 2)
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" })
    try { fs.renameSync(temporary, filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      fs.unlinkSync(temporary)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  return filePath
}

function drainQueue(queueDir: string): { messages: PendingMessage[]; recovered: number } {
  if (!fs.existsSync(queueDir)) return { messages: [], recovered: 0 }

  let entries: string[]
  try {
    entries = fs.readdirSync(queueDir)
  } catch {
    return { messages: [], recovered: 0 }
  }

  // Collect both .json (new) and .processing (crash recovery)
  const jsonFiles = entries.filter(f => f.endsWith(".json") && !f.endsWith(".processing"))
  const processingFiles = entries.filter(f => f.endsWith(".json.processing"))

  // Sort by filename (timestamp prefix gives chronological order)
  const allFiles = [
    ...processingFiles.map(f => ({ file: f, needsRename: false })),
    ...jsonFiles.map(f => ({ file: f, needsRename: true })),
  ].sort((a, b) => a.file.localeCompare(b.file))

  const messages: PendingMessage[] = []

  for (const { file, needsRename } of allFiles) {
    const srcPath = path.join(queueDir, file)
    const processingPath = needsRename
      ? path.join(queueDir, file + ".processing")
      : srcPath

    try {
      if (needsRename) {
        fs.renameSync(srcPath, processingPath)
      }

      const raw = fs.readFileSync(processingPath, "utf-8")
      const parsed = JSON.parse(raw) as PendingMessage
      messages.push(parsed)

      fs.unlinkSync(processingPath)
    } catch {
      // Skip unparseable files — still try to clean up
      try { fs.unlinkSync(processingPath) } catch { /* ignore */ }
    }
  }

  return {
    messages,
    recovered: processingFiles.length,
  }
}

/** How many tries that threw or died may read a pending message before it is set aside as failed. */
export const MAX_PENDING_FAILED_TRIES = 3

export interface PendingClaim {
  messages: PendingMessage[]
  /** The turn handled these messages (all of them, or only the ones given): delete them. */
  settle(only?: PendingMessage[]): void
  /**
   * The turn did not handle the messages: put them back for the next turn. `failed` counts the try against them,
   * for a turn that threw; a provider outage or a shutdown does not use them up.
   */
  release(options?: { failed?: boolean }): void
}

interface HeldMessage {
  claimedPath: string
  stem: string
  message: PendingMessage
  failedTries: number
}

function pendingStem(name: string): string {
  return name.slice(0, name.lastIndexOf(".json"))
}

/**
 * Take a queue's messages for one turn without deleting them. Each is renamed to `.json.claimed` and deleted only
 * by `settle()`, once the turn has handled it; `release()` renames it back. A claimed file that no turn in this
 * process holds was left by a process that died mid-turn: it is read again and counted as a failed try. After
 * MAX_PENDING_FAILED_TRIES failed tries the message is set aside as `.json.failed`, so it cannot fail every later turn.
 */
export function claimPending(pendingDir: string): PendingClaim {
  installExitHandlers()
  let held: HeldMessage[] = []
  const releaseHeld = (failed: boolean): void => {
    for (const entry of held) {
      const claim = heldClaims.get(entry.claimedPath)
      // Already put back by the exit hook.
      if (!claim) continue
      heldClaims.delete(entry.claimedPath)
      try {
        putBack(entry.claimedPath, claim, failed)
      } catch (error) {
        emitNervesEvent({ level: "warn", event: "mind.pending_release_error", component: "mind", message: "could not put a claimed pending message back; the next turn reads it as left by a crash", meta: { pendingDir, error: errorMessage(error) } })
      }
    }
    held = []
  }
  try {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(pendingDir)
    } catch {
      entries = []
    }
    const names = entries
      .filter((name) => name.endsWith(".json") || name.endsWith(CLAIMED_SUFFIX) || name.endsWith(DRAIN_PROCESSING_SUFFIX))
      .sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      const stem = pendingStem(name)
      const claimedPath = path.join(pendingDir, `${stem}${CLAIMED_SUFFIX}`)
      // Held by a turn in this process, or a fresh copy of a message that is.
      if (heldClaims.has(claimedPath)) continue
      // Settled here already: what its turn did must not happen again. Finish deleting it.
      if (settledClaims.has(claimedPath)) {
        deleteSettled(pendingDir, claimedPath, stem)
        continue
      }
      const leftByCrash = !name.endsWith(".json")
      if (name !== `${stem}${CLAIMED_SUFFIX}`) {
        // A copy of a crash leftover is taken under the leftover's own name.
        if (fs.existsSync(claimedPath)) continue
        try {
          fs.renameSync(path.join(pendingDir, name), claimedPath)
        } catch {
          // Another reader took it first.
          continue
        }
      }
      const setAside = (): boolean => {
        try {
          fs.renameSync(claimedPath, path.join(pendingDir, `${stem}.json.failed`))
          return true
        } catch (error) {
          emitNervesEvent({ level: "warn", event: "mind.pending_set_aside_error", component: "mind", message: "could not set aside a pending message; a later turn tries again", meta: { pendingDir, file: name, error: errorMessage(error) } })
          return false
        }
      }
      let stored: PendingMessage & { failedTries?: number }
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(claimedPath, "utf-8"))
        // Valid JSON that is not a message (null, a number, a list) is as unreadable as a torn file.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a pending message")
        stored = parsed as typeof stored
      } catch (error) {
        // A fresh file may still be being written: leave it for a later turn. One that stays unreadable, or that a
        // crash left mid-read, is kept as .json.failed for a person to look at, never deleted.
        // A file that is gone (a link to nothing, say) has no age; it is set aside like an old one.
        const stat = fs.statSync(claimedPath, { throwIfNoEntry: false })
        const recent = !leftByCrash && stat !== undefined && Date.now() - stat.mtimeMs < UNREADABLE_GRACE_MS
        if (recent) {
          try { fs.renameSync(claimedPath, path.join(pendingDir, name)) } catch { /* left claimed; the next claim reads it as a leftover */ }
        } else if (setAside()) {
          emitNervesEvent({ level: "error", event: "mind.pending_message_unreadable", component: "mind", message: "set aside a pending message nobody can read; it is kept as .json.failed", meta: { pendingDir, file: name, error: errorMessage(error) } })
        }
        continue
      }
      const { failedTries: earlierFailedTries, ...message } = stored
      const failedTries = (earlierFailedTries ?? 0) + (leftByCrash ? 1 : 0)
      if (failedTries >= MAX_PENDING_FAILED_TRIES) {
        if (setAside()) emitNervesEvent({ level: "error", event: "mind.pending_message_failed", component: "mind", message: "set aside a pending message that no turn finished; it is kept as .json.failed", meta: { pendingDir, file: name, failedTries } })
        continue
      }
      if (leftByCrash) {
        try {
          writeJsonAtomicSync(claimedPath, { ...message, failedTries })
        } catch {
          // The count did not land, so the next claim counts this try again; better than not reading it now.
        }
      }
      heldClaims.set(claimedPath, { unclaimedPath: path.join(pendingDir, `${stem}.json`), message, failedTries })
      held.push({ claimedPath, stem, message, failedTries })
    }
    emitNervesEvent({ event: "mind.pending_claimed", component: "mind", message: "pending messages claimed for a turn", meta: { pendingDir, count: held.length } })
  } catch (error) {
    releaseHeld(false)
    throw error
  }
  const messages = held.map((entry) => entry.message)
  return {
    messages,
    settle(only) {
      const done = only ? held.filter((entry) => only.includes(entry.message)) : held
      held = held.filter((entry) => !done.includes(entry))
      for (const entry of done) {
        if (!heldClaims.delete(entry.claimedPath)) continue
        deleteSettled(pendingDir, entry.claimedPath, entry.stem)
      }
    },
    release(options) {
      releaseHeld(options?.failed === true)
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error)
}

export function enqueueDeferredReturn(agentName: string, friendId: string, message: PendingMessage): string {
  const queueDir = getDeferredReturnDir(agentName, friendId)
  const filePath = writeQueueFile(queueDir, message)
  emitNervesEvent({
    event: "mind.deferred_return_enqueued",
    component: "mind",
    message: "deferred return queued for later friend delivery",
    meta: { friendId, queueDir },
  })
  return filePath
}

export function drainDeferredReturns(agentName: string, friendId: string): PendingMessage[] {
  const queueDir = getDeferredReturnDir(agentName, friendId)
  const { messages } = drainQueue(queueDir)
  emitNervesEvent({
    event: "mind.deferred_returns_drained",
    component: "mind",
    message: "deferred friend returns drained",
    meta: { friendId, queueDir, count: messages.length },
  })
  return messages
}

/**
 * Removes the saved copies of one message from a friend's deferred returns, for when the same turn
 * reached them another way after it was saved. Returns how many it removed.
 */
export function withdrawDeferredReturn(agentName: string, friendId: string, content: string): number {
  const queueDir = getDeferredReturnDir(agentName, friendId)
  if (!fs.existsSync(queueDir)) return 0
  const saved = capStructuredRecordString(content)
  let removed = 0
  for (const file of fs.readdirSync(queueDir).filter((name) => name.endsWith(".json"))) {
    const filePath = path.join(queueDir, file)
    try {
      if ((JSON.parse(fs.readFileSync(filePath, "utf-8")) as PendingMessage).content !== saved) continue
      fs.unlinkSync(filePath)
      removed += 1
    } catch { /* unreadable or already drained: leave it */ }
  }
  emitNervesEvent({
    event: "mind.deferred_return_withdrawn",
    component: "mind",
    message: "saved friend return withdrawn because the turn reached them another way",
    meta: { friendId, queueDir, removed },
  })
  return removed
}

export function drainPending(pendingDir: string): PendingMessage[] {
  if (!fs.existsSync(pendingDir)) return []
  const { messages, recovered } = drainQueue(pendingDir)

  emitNervesEvent({
    event: "mind.pending_drained",
    component: "mind",
    message: "pending queue drained",
    meta: { pendingDir, count: messages.length, recovered },
  })

  return messages
}
