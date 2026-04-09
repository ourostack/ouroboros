import * as fs from "node:fs/promises"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import { getRecentAttachment } from "./store"
import type { AttachmentRecord, AttachmentVariant, MaterializedAttachment } from "./types"

export interface NormalizeImageInput {
  attachment: AttachmentRecord
  sourcePath: string
  agentName: string
  agentRoot: string
}

export interface NormalizeImageOutput {
  path: string
  mimeType?: string
  byteCount?: number
}

export interface MaterializeAttachmentOptions {
  agentRoot?: string
  variant?: AttachmentVariant
  normalizeImage?: (input: NormalizeImageInput) => Promise<NormalizeImageOutput>
}

function emitMaterializeEvent(event: string, attachmentId: string, meta: Record<string, unknown>): void {
  emitNervesEvent({
    component: "engine",
    event,
    message: "attachment materialization updated",
    meta: { attachmentId, ...meta },
  })
}

async function ensureReadableFile(filePath: string): Promise<void> {
  await fs.access(filePath)
}

async function materializeOriginalAttachment(
  agentName: string,
  attachment: AttachmentRecord,
  agentRoot: string,
): Promise<MaterializedAttachment> {
  void agentName
  void agentRoot
  switch (attachment.source) {
    case "cli-local-file": {
      await ensureReadableFile(attachment.sourceData.path)
      emitMaterializeEvent("engine.attachment_materialized", attachment.id, {
        variant: "original",
        source: attachment.source,
      })
      return {
        attachmentId: attachment.id,
        variant: "original",
        path: attachment.sourceData.path,
        displayName: attachment.displayName,
        mimeType: attachment.mimeType,
        byteCount: attachment.byteCount,
      }
    }
    case "bluebubbles":
      throw new Error(`BlueBubbles materialization not implemented yet for ${attachment.id}`)
  }
}

export async function materializeAttachment(
  agentName: string,
  attachmentId: string,
  options: MaterializeAttachmentOptions = {},
): Promise<MaterializedAttachment> {
  const agentRoot = options.agentRoot ?? getAgentRoot(agentName)
  const variant = options.variant ?? "original"
  const attachment = getRecentAttachment(agentName, attachmentId, agentRoot)
  if (!attachment) {
    throw new Error(`Attachment not found: ${attachmentId}`)
  }

  if (variant === "original") {
    return await materializeOriginalAttachment(agentName, attachment, agentRoot)
  }

  if (attachment.kind !== "image") {
    throw new Error(`Attachment ${attachmentId} is not an image and cannot produce a vision_safe variant`)
  }

  const original = await materializeOriginalAttachment(agentName, attachment, agentRoot)
  if (!options.normalizeImage) {
    throw new Error(`No image normalizer available for ${attachmentId}`)
  }

  const normalized = await options.normalizeImage({
    attachment,
    sourcePath: original.path,
    agentName,
    agentRoot,
  })

  emitMaterializeEvent("engine.attachment_materialized", attachment.id, {
    variant: "vision_safe",
    source: attachment.source,
  })

  return {
    attachmentId: attachment.id,
    variant: "vision_safe",
    path: path.resolve(normalized.path),
    displayName: attachment.displayName,
    mimeType: normalized.mimeType ?? attachment.mimeType,
    byteCount: normalized.byteCount,
  }
}
