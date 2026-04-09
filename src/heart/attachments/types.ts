import { createHash } from "node:crypto"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesAttachmentSummary } from "../../senses/bluebubbles/model"

export type AttachmentKind = "image" | "audio" | "document" | "binary" | "unknown"
export type AttachmentSourceKind = "bluebubbles" | "cli-local-file"
export type AttachmentVariant = "original" | "vision_safe"

export interface AttachmentRecordBase {
  id: string
  source: AttachmentSourceKind
  sourceId: string
  kind: AttachmentKind
  displayName: string
  mimeType?: string
  byteCount?: number
  createdAt: number
  lastSeenAt: number
}

export interface BlueBubblesAttachmentRecord extends AttachmentRecordBase {
  source: "bluebubbles"
  sourceData: BlueBubblesAttachmentSummary & { guid: string; localPath?: string }
}

export interface CliLocalFileAttachmentRecord extends AttachmentRecordBase {
  source: "cli-local-file"
  sourceData: {
    path: string
  }
}

export type AttachmentRecord = BlueBubblesAttachmentRecord | CliLocalFileAttachmentRecord

export interface MaterializedAttachment {
  attachmentId: string
  variant: AttachmentVariant
  path: string
  displayName: string
  mimeType?: string
  byteCount?: number
}

function emitAttachmentTypeEvent(event: string, meta: Record<string, unknown>): void {
  emitNervesEvent({
    component: "engine",
    event,
    message: "attachment record helper invoked",
    meta,
  })
}

export function buildAttachmentId(source: AttachmentSourceKind, stableId: string): string {
  emitAttachmentTypeEvent("engine.attachment_id_built", { source })
  return `attachment:${source}:${stableId}`
}

export function classifyAttachmentKind(mimeType?: string, displayName?: string): AttachmentKind {
  const normalizedMime = mimeType?.trim().toLowerCase() ?? ""
  const extension = path.extname(displayName ?? "").toLowerCase()

  if (normalizedMime.startsWith("image/")) return "image"
  if (normalizedMime.startsWith("audio/")) return "audio"
  if (
    normalizedMime.startsWith("text/")
    || normalizedMime === "application/pdf"
    || extension === ".pdf"
    || extension === ".txt"
    || extension === ".md"
    || extension === ".doc"
    || extension === ".docx"
  ) {
    return "document"
  }
  if (!normalizedMime && !displayName) return "unknown"
  return "binary"
}

function stableCliLocalFileId(filePath: string): string {
  return createHash("sha1").update(path.resolve(filePath)).digest("hex").slice(0, 16)
}

export function buildBlueBubblesAttachmentRecord(
  summary: BlueBubblesAttachmentSummary,
  now = Date.now(),
  options: {
    localPath?: string
    mimeType?: string
    byteCount?: number
  } = {},
): BlueBubblesAttachmentRecord {
  const guid = summary.guid?.trim()
  if (!guid) {
    throw new Error("BlueBubbles attachment guid is required")
  }

  const displayName = summary.transferName?.trim() || guid
  const mimeType = options.mimeType?.trim().toLowerCase() || summary.mimeType?.trim().toLowerCase() || undefined
  const record: BlueBubblesAttachmentRecord = {
    id: buildAttachmentId("bluebubbles", guid),
    source: "bluebubbles",
    sourceId: guid,
    kind: classifyAttachmentKind(mimeType, displayName),
    displayName,
    mimeType,
    byteCount: options.byteCount ?? summary.totalBytes,
    createdAt: now,
    lastSeenAt: now,
    sourceData: {
      ...summary,
      guid,
      ...(options.localPath ? { localPath: path.resolve(options.localPath) } : {}),
    },
  }
  emitAttachmentTypeEvent("engine.attachment_record_built", {
    source: "bluebubbles",
    kind: record.kind,
  })
  return record
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
  const record: CliLocalFileAttachmentRecord = {
    id: buildAttachmentId("cli-local-file", stableId),
    source: "cli-local-file",
    sourceId: stableId,
    kind: classifyAttachmentKind(mimeType, displayName),
    displayName,
    mimeType,
    byteCount: input.byteCount,
    createdAt: now,
    lastSeenAt: now,
    sourceData: {
      path: resolvedPath,
    },
  }
  emitAttachmentTypeEvent("engine.attachment_record_built", {
    source: "cli-local-file",
    kind: record.kind,
  })
  return record
}
