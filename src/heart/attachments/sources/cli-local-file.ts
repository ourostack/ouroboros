import { createHash } from "node:crypto"
import * as path from "node:path"
import { buildOriginalMaterializedAttachment, ensureReadableFile } from "../originals"
import { createAttachmentRecord, type AttachmentRecord } from "../types"
import type { AttachmentSourceAdapter } from "./adapter"

export interface CliLocalFileAttachmentSourceData {
  path: string
}

export type CliLocalFileAttachmentRecord = AttachmentRecord<"cli-local-file", CliLocalFileAttachmentSourceData>

function stableCliLocalFileId(filePath: string): string {
  return createHash("sha1").update(path.resolve(filePath)).digest("hex").slice(0, 16)
}

function requireCliLocalFilePath(attachment: AttachmentRecord): string {
  if (attachment.source !== "cli-local-file") {
    throw new Error(`cli-local-file adapter cannot materialize ${attachment.source} attachments`)
  }

  const rawPath = (attachment.sourceData as Record<string, unknown> | undefined)?.path
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("CLI local attachment path is required")
  }

  return path.resolve(rawPath)
}

export function buildCliLocalFileAttachmentRecord(
  input: {
    path: string
    mimeType?: string
    byteCount?: number
    displayName?: string
  },
  now = Date.now(),
): CliLocalFileAttachmentRecord {
  const resolvedPath = path.resolve(input.path)
  const displayName = input.displayName?.trim() || path.basename(resolvedPath)
  const mimeType = input.mimeType?.trim().toLowerCase() || undefined
  const stableId = stableCliLocalFileId(resolvedPath)

  return createAttachmentRecord(
    {
      source: "cli-local-file",
      sourceId: stableId,
      displayName,
      mimeType,
      byteCount: input.byteCount,
      sourceData: {
        path: resolvedPath,
      },
    },
    now,
  )
}

export const cliLocalFileAttachmentSourceAdapter: AttachmentSourceAdapter = {
  source: "cli-local-file",
  async materializeOriginal({ attachment }) {
    const filePath = requireCliLocalFilePath(attachment)
    await ensureReadableFile(filePath)
    return buildOriginalMaterializedAttachment(attachment, filePath)
  },
}
