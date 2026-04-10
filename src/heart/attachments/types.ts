import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

export type AttachmentKind = "image" | "audio" | "document" | "binary" | "unknown"
export type AttachmentSourceKind = "bluebubbles" | "cli-local-file"
export type AttachmentVariant = "original" | "vision_safe"
export type AttachmentSourceData = object

export interface AttachmentRecordBase<TSource extends AttachmentSourceKind = AttachmentSourceKind> {
  id: string
  source: TSource
  sourceId: string
  kind: AttachmentKind
  displayName: string
  mimeType?: string
  byteCount?: number
  createdAt: number
  lastSeenAt: number
}

export type AttachmentRecord<
  TSource extends AttachmentSourceKind = AttachmentSourceKind,
  TSourceData extends AttachmentSourceData = AttachmentSourceData,
> = AttachmentRecordBase<TSource> & {
  sourceData: TSourceData
}

export interface MaterializedAttachment {
  attachmentId: string
  variant: AttachmentVariant
  path: string
  displayName: string
  mimeType?: string
  byteCount?: number
}

export function createAttachmentRecord<
  TSource extends AttachmentSourceKind,
  TSourceData extends AttachmentSourceData,
>(
  input: {
    source: TSource
    sourceId: string
    displayName: string
    mimeType?: string
    byteCount?: number
    sourceData: TSourceData
  },
  now = Date.now(),
): AttachmentRecord<TSource, TSourceData> {
  const record: AttachmentRecord<TSource, TSourceData> = {
    id: buildAttachmentId(input.source, input.sourceId),
    source: input.source,
    sourceId: input.sourceId,
    kind: classifyAttachmentKind(input.mimeType, input.displayName),
    displayName: input.displayName,
    mimeType: input.mimeType,
    byteCount: input.byteCount,
    createdAt: now,
    lastSeenAt: now,
    sourceData: input.sourceData,
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_record_built",
    message: "attachment record helper invoked",
    meta: {
      source: record.source,
      kind: record.kind,
    },
  })

  return record
}

export function buildAttachmentId(source: AttachmentSourceKind, stableId: string): string {
  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_id_built",
    message: "attachment record helper invoked",
    meta: { source },
  })
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
