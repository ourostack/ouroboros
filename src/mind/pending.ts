import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../heart/identity"
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
}

export function getPendingDir(agentName: string, friendId: string, channel: string, key: string): string {
  return path.join(getAgentRoot(agentName), "state", "pending", friendId, channel, key)
}

export function getDeferredReturnDir(agentName: string, friendId: string): string {
  return path.join(getAgentRoot(agentName), "state", "pending-returns", friendId)
}

/** Canonical inner-dialog pending path segments. */
export const INNER_DIALOG_PENDING = { friendId: "self", channel: "inner", key: "dialog" } as const

/** Returns the pending dir for this agent's inner dialog. */
export function getInnerDialogPendingDir(agentName: string): string {
  return getPendingDir(agentName, INNER_DIALOG_PENDING.friendId, INNER_DIALOG_PENDING.channel, INNER_DIALOG_PENDING.key)
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
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2))
  return filePath
}

export function queuePendingMessage(pendingDir: string, message: PendingMessage): void {
  writeQueueFile(pendingDir, message)
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
