import * as fs from "fs"
import * as path from "path"
import { createHash } from "node:crypto"
import { getAgentRoot } from "../heart/identity"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"

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

export function hasPendingMessages(pendingDir: string): boolean {
  if (!fs.existsSync(pendingDir)) return false

  try {
    return fs.readdirSync(pendingDir).some((entry) =>
      entry.endsWith(".json") || entry.endsWith(".json.processing"),
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

/** How many turns may read a pending message without settling it before it is set aside as failed. */
export const MAX_PENDING_CLAIMS = 3

export interface PendingClaim {
  messages: PendingMessage[]
  /** The turn that read the messages has been recorded: delete them. */
  settle(): void
  /** The turn ended without being recorded: leave the messages for the next turn to read again. */
  release(): void
}

/** Messages a turn in this process has claimed and not yet settled or released, by `.processing` path. */
const heldClaims = new Set<string>()

/**
 * Take a queue's messages for one turn without deleting them. Each is renamed to `.processing` and deleted only by
 * `settle()`, once the turn that read it has been recorded. A turn that throws releases its claim, and a process that
 * dies holds it no longer, so the next claim reads the message again. After MAX_PENDING_CLAIMS reads that never
 * settled, the message is set aside as `.json.failed` so it cannot fail every later turn.
 */
export function claimPending(pendingDir: string): PendingClaim {
  const claimed: string[] = []
  const messages: PendingMessage[] = []
  let entries: string[] = []
  try {
    entries = fs.readdirSync(pendingDir)
  } catch {
    entries = []
  }
  const files = entries
    .filter((name) => name.endsWith(".json") || name.endsWith(".json.processing"))
    .sort((a, b) => a.localeCompare(b))
  for (const name of files) {
    const recovered = name.endsWith(".processing")
    const processingPath = path.join(pendingDir, recovered ? name : `${name}.processing`)
    if (heldClaims.has(processingPath)) continue
    try {
      if (!recovered) fs.renameSync(path.join(pendingDir, name), processingPath)
      const { claims: earlierClaims, ...parsed } = JSON.parse(fs.readFileSync(processingPath, "utf-8")) as PendingMessage & { claims?: number }
      const claims = (earlierClaims ?? 0) + 1
      if (claims > MAX_PENDING_CLAIMS) {
        fs.renameSync(processingPath, processingPath.replace(/\.processing$/, ".failed"))
        emitNervesEvent({ level: "error", event: "mind.pending_message_failed", component: "mind", message: "set aside a pending message that no turn finished; it is kept as .json.failed", meta: { pendingDir, file: name, claims: MAX_PENDING_CLAIMS } })
        continue
      }
      fs.writeFileSync(processingPath, JSON.stringify({ ...parsed, claims }))
      heldClaims.add(processingPath)
      claimed.push(processingPath)
      messages.push(parsed)
    } catch {
      // Unreadable: nothing can ever read it, so it goes, as drainPending does.
      try { fs.unlinkSync(processingPath) } catch { /* ignore */ }
    }
  }
  let open = true
  const end = (remove: boolean): void => {
    if (!open) return
    open = false
    for (const processingPath of claimed) {
      heldClaims.delete(processingPath)
      if (!remove) continue
      try {
        fs.unlinkSync(processingPath)
      } catch (error) {
        emitNervesEvent({ level: "warn", event: "mind.pending_settle_error", component: "mind", message: "could not delete a settled pending message; the next turn reads it again", meta: { pendingDir, error: error instanceof Error ? error.message : /* v8 ignore next -- defensive non-Error throw branch @preserve */ String(error) } })
      }
    }
  }
  emitNervesEvent({ event: "mind.pending_claimed", component: "mind", message: "pending messages claimed for a turn", meta: { pendingDir, count: messages.length } })
  return { messages, settle: () => end(true), release: () => end(false) }
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
