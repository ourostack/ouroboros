import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import type { AttachmentKind, AttachmentRecord } from "./types"

export const MAX_RECENT_ATTACHMENTS = 100

export function getRecentAttachmentsPath(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(agentRoot, "state", "attachments", "recent.json")
}

/**
 * Durable per-attachment metadata keyed by attachment id.
 *
 * `recent.json` is only a bounded recency cache. Session-bound attachment ids
 * stay resolvable here after more than `MAX_RECENT_ATTACHMENTS` newer
 * attachments have evicted them from that cache.
 */
export function getAttachmentCatalogPath(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(agentRoot, "state", "attachments", "catalog")
}

function attachmentCatalogRecordPath(agentName: string, attachmentId: string, agentRoot: string): string {
  const digest = createHash("sha256").update(attachmentId).digest("hex")
  return path.join(getAttachmentCatalogPath(agentName, agentRoot), `${digest}.json`)
}

export function readRecentAttachments(agentName: string, agentRoot = getAgentRoot(agentName)): AttachmentRecord[] {
  const targetPath = getRecentAttachmentsPath(agentName, agentRoot)
  if (!fs.existsSync(targetPath)) {
    return []
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf-8")) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed as AttachmentRecord[]
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "engine",
      event: "engine.attachment_store_read_error",
      message: "failed to read recent attachments store",
      meta: {
        path: targetPath,
        reason: String(error),
      },
    })
    return []
  }
}

function writeJsonAtomically(targetPath: string, value: unknown): void {
  const directory = path.dirname(targetPath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 })
    const temporary = fs.openSync(temporaryPath, "r")
    try { fs.fsyncSync(temporary) } finally { fs.closeSync(temporary) }
    fs.renameSync(temporaryPath, targetPath)
    const directoryHandle = fs.openSync(directory, "r")
    try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
  } finally {
    try { fs.unlinkSync(temporaryPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}

export function getAttachment(
  agentName: string,
  attachmentId: string,
  agentRoot = getAgentRoot(agentName),
): AttachmentRecord | null {
  const targetPath = attachmentCatalogRecordPath(agentName, attachmentId, agentRoot)
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf-8")) as AttachmentRecord | null
    if (parsed?.id === attachmentId) return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      emitNervesEvent({
        level: "warn",
        component: "engine",
        event: "engine.attachment_catalog_read_error",
        message: "failed to read durable attachment catalog record",
        meta: {
          path: targetPath,
          reason: String(error),
        },
      })
    }
  }
  return getRecentAttachment(agentName, attachmentId, agentRoot)
}

export function cacheRecentAttachment<TAttachment extends AttachmentRecord>(
  agentName: string,
  attachment: TAttachment,
  agentRoot = getAgentRoot(agentName),
): TAttachment {
  writeJsonAtomically(attachmentCatalogRecordPath(agentName, attachment.id, agentRoot), attachment)
  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_catalog_written",
    message: "durable attachment catalog record written",
    meta: { attachmentId: attachment.id, source: attachment.source },
  })

  const deduped = readRecentAttachments(agentName, agentRoot).filter((entry) => entry.id !== attachment.id)
  const updated = [attachment, ...deduped]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_RECENT_ATTACHMENTS)

  writeJsonAtomically(getRecentAttachmentsPath(agentName, agentRoot), updated)

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_store_updated",
    message: "recent attachment stored",
    meta: { attachmentId: attachment.id, source: attachment.source, kind: attachment.kind },
  })

  return attachment
}

export function getRecentAttachment(
  agentName: string,
  attachmentId: string,
  agentRoot = getAgentRoot(agentName),
): AttachmentRecord | null {
  return readRecentAttachments(agentName, agentRoot).find((entry) => entry.id === attachmentId) ?? null
}

/** Remove only transaction-owned metadata; callers own the corresponding byte lifetime. */
export function removeAttachment(agentName: string, attachmentId: string, agentRoot = getAgentRoot(agentName)): void {
  fs.rmSync(attachmentCatalogRecordPath(agentName, attachmentId, agentRoot), { force: true })
  const recent = readRecentAttachments(agentName, agentRoot)
  if (recent.some((entry) => entry.id === attachmentId)) {
    writeJsonAtomically(getRecentAttachmentsPath(agentName, agentRoot), recent.filter((entry) => entry.id !== attachmentId))
  }
  emitNervesEvent({
    component: "engine", event: "engine.attachment_store_removed",
    message: "transaction-owned attachment metadata removed", meta: { attachmentId },
  })
}

export function listRecentAttachments(
  agentName: string,
  options: { kind?: AttachmentKind; limit?: number } = {},
  agentRoot = getAgentRoot(agentName),
): AttachmentRecord[] {
  const limit = Math.max(1, options.limit ?? MAX_RECENT_ATTACHMENTS)
  return readRecentAttachments(agentName, agentRoot)
    .filter((entry) => !options.kind || entry.kind === options.kind)
    .slice(0, limit)
}
