import * as fs from "node:fs/promises"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig } from "../config"
import { normalizeImageForVision } from "./image-normalize"
import { getRecentAttachment, rememberRecentAttachment } from "./store"
import { buildBlueBubblesAttachmentRecord, type AttachmentRecord, type AttachmentVariant, type BlueBubblesAttachmentRecord, type MaterializedAttachment } from "./types"
import { downloadBlueBubblesAttachment } from "../../senses/bluebubbles/attachment-download"

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

type PersistedBlueBubblesAttachmentRecord = BlueBubblesAttachmentRecord & {
  sourceData: BlueBubblesAttachmentRecord["sourceData"] & { localPath: string }
}

export interface MaterializeAttachmentOptions {
  agentRoot?: string
  variant?: AttachmentVariant
  normalizeImage?: (input: NormalizeImageInput) => Promise<NormalizeImageOutput>
}

async function ensureReadableFile(filePath: string): Promise<void> {
  await fs.access(filePath)
}

function extensionForAttachment(displayName: string, mimeType?: string): string {
  const explicit = path.extname(displayName).trim()
  if (explicit) return explicit

  switch (mimeType?.trim().toLowerCase()) {
    case "image/jpeg":
      return ".jpg"
    case "image/png":
      return ".png"
    case "image/webp":
      return ".webp"
    case "image/gif":
      return ".gif"
    case "image/tiff":
      return ".tiff"
    case "image/bmp":
      return ".bmp"
    case "image/heic":
      return ".heic"
    case "application/pdf":
      return ".pdf"
    case "audio/mp3":
    case "audio/mpeg":
      return ".mp3"
    case "audio/mp4":
      return ".m4a"
    default:
      return ""
  }
}

function originalStoragePath(agentRoot: string, attachment: AttachmentRecord, mimeType?: string): string {
  const extension = extensionForAttachment(attachment.displayName, mimeType ?? attachment.mimeType)
  return path.join(
    agentRoot,
    "state",
    "attachments",
    "materialized",
    attachment.source,
    attachment.sourceId,
    `original${extension}`,
  )
}

function buildOriginalMaterializedAttachment(
  attachment: AttachmentRecord,
  filePath: string,
  mimeType?: string,
  byteCount?: number,
): MaterializedAttachment {
  return {
    attachmentId: attachment.id,
    variant: "original",
    path: filePath,
    displayName: attachment.displayName,
    mimeType: mimeType ?? attachment.mimeType,
    byteCount: byteCount ?? attachment.byteCount,
  }
}

export async function persistBlueBubblesAttachmentSource(
  agentName: string,
  attachment: BlueBubblesAttachmentRecord,
  input: {
    buffer: Buffer
    mimeType?: string
    byteCount?: number
  },
  agentRoot = getAgentRoot(agentName),
): Promise<PersistedBlueBubblesAttachmentRecord> {
  const targetPath = originalStoragePath(agentRoot, attachment, input.mimeType)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, input.buffer)

  const updated = buildBlueBubblesAttachmentRecord(
    {
      ...attachment.sourceData,
      mimeType: input.mimeType ?? attachment.sourceData.mimeType,
      totalBytes: input.byteCount ?? attachment.byteCount,
    },
    attachment.createdAt,
    {
      localPath: targetPath,
      mimeType: input.mimeType ?? attachment.mimeType,
      byteCount: input.byteCount ?? attachment.byteCount,
    },
  )
  updated.lastSeenAt = Date.now()
  rememberRecentAttachment(agentName, updated, agentRoot)

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_source_persisted",
    message: "attachment materialization updated",
    meta: {
      attachmentId: attachment.id,
      source: attachment.source,
      mimeType: updated.mimeType,
    },
  })

  return updated as PersistedBlueBubblesAttachmentRecord
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
      emitNervesEvent({
        component: "engine",
        event: "engine.attachment_materialized",
        message: "attachment materialization updated",
        meta: {
          attachmentId: attachment.id,
          variant: "original",
          source: attachment.source,
        },
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
    case "bluebubbles": {
      const localPath = attachment.sourceData.localPath?.trim()
      if (localPath) {
        await ensureReadableFile(localPath)
        emitNervesEvent({
          component: "engine",
          event: "engine.attachment_materialized",
          message: "attachment materialization updated",
          meta: {
            attachmentId: attachment.id,
            variant: "original",
            source: attachment.source,
          },
        })
        return buildOriginalMaterializedAttachment(attachment, localPath)
      }

      const fallbackPath = originalStoragePath(agentRoot, attachment)
      try {
        await ensureReadableFile(fallbackPath)
        return buildOriginalMaterializedAttachment(attachment, fallbackPath)
      } catch {
        const config = getBlueBubblesConfig()
        const channelConfig = getBlueBubblesChannelConfig()
        const downloaded = await downloadBlueBubblesAttachment(attachment.sourceData, config, channelConfig)
        const updated = await persistBlueBubblesAttachmentSource(
          agentName,
          attachment,
          {
            buffer: downloaded.buffer,
            mimeType: downloaded.contentType,
            byteCount: downloaded.buffer.length,
          },
          agentRoot,
        )
        emitNervesEvent({
          component: "engine",
          event: "engine.attachment_materialized",
          message: "attachment materialization updated",
          meta: {
            attachmentId: attachment.id,
            variant: "original",
            source: attachment.source,
          },
        })
        return buildOriginalMaterializedAttachment(
          updated,
          updated.sourceData.localPath,
          downloaded.contentType ?? updated.mimeType,
          downloaded.buffer.length,
        )
      }
    }
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
  const normalizeImage = options.normalizeImage ?? normalizeImageForVision

  const normalized = await normalizeImage({
    attachment,
    sourcePath: original.path,
    agentName,
    agentRoot,
  })

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_materialized",
    message: "attachment materialization updated",
    meta: {
      attachmentId: attachment.id,
      variant: "vision_safe",
      source: attachment.source,
    },
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
