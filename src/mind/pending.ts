import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export interface PendingMessage {
  from: string
  friendId?: string
  channel?: string
  key?: string
  content: string
  timestamp: number
}

export function getPendingDir(agentName: string, friendId: string, channel: string, key: string): string {
  return path.join(getAgentRoot(agentName), "state", "pending", friendId, channel, key)
}

/** Canonical inner-dialog pending path segments. */
export const INNER_DIALOG_PENDING = { friendId: "self", channel: "inner", key: "dialog" } as const

/** Returns the pending dir for this agent's inner dialog. */
export function getInnerDialogPendingDir(agentName: string): string {
  return getPendingDir(agentName, INNER_DIALOG_PENDING.friendId, INNER_DIALOG_PENDING.channel, INNER_DIALOG_PENDING.key)
}

export function drainPending(pendingDir: string): PendingMessage[] {
  if (!fs.existsSync(pendingDir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(pendingDir)
  } catch {
    return []
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
    const srcPath = path.join(pendingDir, file)
    const processingPath = needsRename
      ? path.join(pendingDir, file + ".processing")
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

  emitNervesEvent({
    event: "mind.pending_drained",
    component: "mind",
    message: "pending queue drained",
    meta: { pendingDir, count: messages.length, recovered: processingFiles.length },
  })

  return messages
}
