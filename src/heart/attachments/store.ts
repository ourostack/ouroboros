import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import type { AttachmentKind, AttachmentRecord } from "./types"

export const MAX_RECENT_ATTACHMENTS = 100

export function getRecentAttachmentsPath(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(agentRoot, "state", "attachments", "recent.json")
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

function writeRecentAttachments(agentName: string, agentRoot: string, attachments: AttachmentRecord[]): void {
  const targetPath = getRecentAttachmentsPath(agentName, agentRoot)
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, JSON.stringify(attachments, null, 2), "utf-8")
}

export function cacheRecentAttachment<TAttachment extends AttachmentRecord>(
  agentName: string,
  attachment: TAttachment,
  agentRoot = getAgentRoot(agentName),
): TAttachment {
  const deduped = readRecentAttachments(agentName, agentRoot).filter((entry) => entry.id !== attachment.id)
  const updated = [attachment, ...deduped]
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, MAX_RECENT_ATTACHMENTS)

  writeRecentAttachments(agentName, agentRoot, updated)

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
