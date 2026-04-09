import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { AttachmentRecord, MaterializedAttachment } from "./types"

export async function ensureReadableFile(filePath: string): Promise<void> {
  await fs.access(filePath)
}

export function extensionForAttachment(displayName: string, mimeType?: string): string {
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

export function originalStoragePath(agentRoot: string, attachment: AttachmentRecord, mimeType?: string): string {
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

export function buildOriginalMaterializedAttachment(
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
